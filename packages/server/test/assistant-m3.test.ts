// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import * as piAi from '@earendil-works/pi-ai';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import { encryptSecret } from '../src/infra/crypto.js';
import { createAssistant } from '../src/services/assistant.js';
import type { Principal } from '../src/services/principal.js';
import { AssistantRealtimeService, type AssistantIO } from '../src/realtime/assistant.js';
import type { ChatStreamEvent } from '@harness-nexus/shared';

/**
 * #52 M3 — the write-tool approval gate and the daily token budget, driven
 * through the realtime coordinator with the faux model (no network).
 *
 * The gate reuses the ACP permission wire: a mutating tool call surfaces a
 * `permission_request` card, the browser answers
 * `assistant:permission.respond`, and deny/timeout/cancel all block the
 * write with a reason the model reads. The budget sums the config's
 * sessions' assistant-turn usage for the UTC day and refuses further turns.
 */

const KEY = 'test-secret-0123456789abcdef';
const owner: Principal = { userId: 'u-owner', role: 'user' };
const now = '2026-01-01T00:00:00.000Z';

interface Harness {
  svc: AssistantRealtimeService;
  uow: ReturnType<typeof createMemoryUnitOfWork>;
  faux: ReturnType<typeof piAi.fauxProvider>;
  events: { sessionId: string; event: ChatStreamEvent }[];
}

async function setup(): Promise<Harness> {
  const uow = createMemoryUnitOfWork();
  await uow.users.save({
    id: owner.userId,
    username: 'owner',
    email: null,
    passwordHash: null,
    role: 'user',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  await uow.credentials.save({
    id: 'cred-1',
    name: 'gw-key',
    secret: encryptSecret('sk-test', KEY),
    scope: 'personal',
    ownerId: owner.userId,
    distributable: true,
    createdAt: now,
    updatedAt: now,
  });
  await uow.llmProviders.save({
    id: 'prov-1',
    name: 'Gateway',
    api: 'openai-chat',
    baseUrl: 'https://gw.example.com/v1',
    credentialName: 'gw-key',
    scope: 'personal',
    ownerId: owner.userId,
    models: [{ id: 'gw-large', type: 'chat' }],
    createdAt: now,
    updatedAt: now,
  });

  const faux = piAi.fauxProvider({
    models: [{ id: 'gw-large', name: 'Gateway Large', contextWindow: 64_000 }],
    tokensPerSecond: 1_000_000,
  });
  const models = piAi.createModels();
  models.setProvider(faux.provider);

  const events: { sessionId: string; event: ChatStreamEvent }[] = [];
  const io: AssistantIO = {
    toChannel: (_sid, event, payload) => {
      if (event === 'assistant:event') {
        events.push(payload as { sessionId: string; event: ChatStreamEvent });
      }
    },
    toUser: () => undefined,
    joinChannel: () => undefined,
    userSockets: async () => [],
  };
  const svc = new AssistantRealtimeService(
    {
      uow,
      credentialEncryptionKey: KEY,
      skills: {
        search: { search: async () => ({ results: [], partial: false }) } as never,
        catalog: {} as never,
        allowlist: [],
      },
      buildModel: async () => ({
        model: faux.getModel('gw-large'),
        streamFn: models.streamSimple.bind(models),
      }),
    },
    io,
    undefined,
    { permissionTimeoutMs: 150 },
  );
  return { svc, uow, faux, events };
}

async function settle(h: Harness, sessionId: string): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    const rows = await h.uow.assistants.listMessages(sessionId);
    const settled =
      rows.length > 0 &&
      rows[rows.length - 1]!.type === 'assistant' &&
      h.events.at(-1)?.event.kind === 'session_status';
    if (settled) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('turn did not settle');
}

function permissionRequestOf(
  h: Harness,
):
  | { requestId: string; event: Extract<ChatStreamEvent, { kind: 'permission_request' }> }
  | undefined {
  for (const e of h.events) {
    if (e.event.kind === 'permission_request') {
      return { requestId: e.event.requestId, event: e.event };
    }
  }
  return undefined;
}

describe('#52 M3 — write-tool approval gate', () => {
  it('a write tool surfaces a permission card; allow executes it', async () => {
    const h = await setup();
    const a = await createAssistant({ uow: h.uow }, owner, {
      name: 'Ops',
      providerId: 'prov-1',
      defaultModel: 'gw-large',
      enabledToolGroups: ['system', 'resources'],
    });
    // Script: try a write, then conclude.
    h.faux.setResponses([
      piAi.fauxAssistantMessage([piAi.fauxToolCall('system_info', {})]),
      piAi.fauxAssistantMessage([piAi.fauxText('done')]),
    ]);
    // First script a WRITE turn: system_info is a read (no card). Redo:
    h.faux.setResponses([
      piAi.fauxAssistantMessage([
        piAi.fauxToolCall('resources_create', {
          resource: {
            key: 'skill:x',
            kind: 'skill',
            name: 'X',
            source: { type: 'inline', content: 'x' },
            scope: 'personal',
          },
        }),
      ]),
      piAi.fauxAssistantMessage([piAi.fauxText('created')]),
    ]);

    const res = await h.svc.open(owner.userId, a.id, undefined, 'sock-1');
    const sessionId = res.ok ? res.sessionId : '';
    await h.svc.onMessageSend(owner.userId, sessionId, 'make a skill');

    // The card appears; approve it.
    await new Promise((r) => setTimeout(r, 50));
    const req = permissionRequestOf(h);
    expect(req).toBeDefined();
    expect(req!.event.toolCall.toolName).toBe('resources_create');
    expect(req!.event.options.map((o) => o.optionId).sort()).toEqual(['allow_once', 'reject_once']);

    const respond = await h.svc.onPermissionRespond(
      owner.userId,
      sessionId,
      req!.requestId,
      'allow_once',
    );
    expect(respond.ok).toBe(true);
    await settle(h, sessionId);

    // The write RAN (resource exists) and the card settled as selected.
    const rows = await h.uow.assistants.listMessages(sessionId);
    const results = rows.flatMap((r) => (r.type === 'toolResult' ? r.results : []));
    const write = results.find((r) => r.tool === 'resources_create');
    expect(write?.isError).toBe(false);
    const list = await h.uow.resources.list({ scope: 'personal', ownerId: owner.userId });
    expect(list.some((r) => r.key === 'skill:x')).toBe(true);
    expect(
      h.events.some(
        (e) =>
          e.event.kind === 'permission_resolved' &&
          (e.event as { requestId: string; outcome: string }).requestId === req!.requestId &&
          (e.event as { outcome: string }).outcome === 'selected',
      ),
    ).toBe(true);
  });

  it('deny blocks the write with a readable reason; timeout denies too', async () => {
    const h = await setup();
    const a = await createAssistant({ uow: h.uow }, owner, {
      name: 'Ops',
      providerId: 'prov-1',
      defaultModel: 'gw-large',
      enabledToolGroups: ['resources'],
    });
    h.faux.setResponses([
      piAi.fauxAssistantMessage([
        piAi.fauxToolCall('resources_create', {
          resource: {
            key: 'skill:y',
            kind: 'skill',
            name: 'Y',
            source: { type: 'inline', content: 'y' },
            scope: 'personal',
          },
        }),
      ]),
      piAi.fauxAssistantMessage([piAi.fauxText('okay')]),
    ]);
    const res = await h.svc.open(owner.userId, a.id, undefined, 'sock-1');
    const sessionId = res.ok ? res.sessionId : '';
    await h.svc.onMessageSend(owner.userId, sessionId, 'make another');
    await new Promise((r) => setTimeout(r, 50));
    const req = permissionRequestOf(h);
    expect(req).toBeDefined();

    // Deny.
    await h.svc.onPermissionRespond(owner.userId, sessionId, req!.requestId, 'reject_once');
    await settle(h, sessionId);
    const rows = await h.uow.assistants.listMessages(sessionId);
    const results = rows.flatMap((r) => (r.type === 'toolResult' ? r.results : []));
    const write = results.find((r) => r.tool === 'resources_create');
    expect(write?.isError).toBe(true);
    expect(write?.output).toContain('declined');
    const list = await h.uow.resources.list({ scope: 'personal', ownerId: owner.userId });
    expect(list.some((r) => r.key === 'skill:y')).toBe(false);

    // Timeout path: a fresh turn whose card is never answered.
    h.events.length = 0;
    h.faux.setResponses([
      piAi.fauxAssistantMessage([
        piAi.fauxToolCall('resources_create', {
          resource: {
            key: 'skill:z',
            kind: 'skill',
            name: 'Z',
            source: { type: 'inline', content: 'z' },
            scope: 'personal',
          },
        }),
      ]),
      piAi.fauxAssistantMessage([piAi.fauxText('fine')]),
    ]);
    await h.svc.onMessageSend(owner.userId, sessionId, 'one more');
    await settle(h, sessionId);
    expect(
      h.events.some(
        (e) =>
          e.event.kind === 'permission_resolved' &&
          (e.event as { outcome: string }).outcome === 'timeout',
      ),
    ).toBe(true);
    const rows2 = await h.uow.assistants.listMessages(sessionId);
    const write2 = rows2
      .flatMap((r) => (r.type === 'toolResult' ? r.results : []))
      .find(
        (r) => r.tool === 'resources_create' && r.output.includes('skill:z') === false && r.isError,
      );
    expect(write2).toBeDefined();
  }, 10_000);

  it("another user's respond bounces; unknown request ids bounce", async () => {
    const h = await setup();
    const a = await createAssistant({ uow: h.uow }, owner, {
      name: 'Ops',
      providerId: 'prov-1',
      defaultModel: 'gw-large',
    });
    const res = await h.svc.open(owner.userId, a.id, undefined, 'sock-1');
    const sessionId = res.ok ? res.sessionId : '';
    expect(await h.svc.onPermissionRespond('u-stranger', sessionId, 'r1', 'allow_once')).toEqual({
      ok: false,
      code: 'SESSION_NOT_FOUND',
    });
    expect(await h.svc.onPermissionRespond(owner.userId, sessionId, 'r1', 'allow_once')).toEqual({
      ok: false,
      code: 'PERMISSION_NOT_FOUND',
    });
  });
});

describe('#52 M3 — daily token budget', () => {
  it('refuses turns once the config spends its daily budget (and unlimited configs never refuse)', async () => {
    const h = await setup();
    const a = await createAssistant({ uow: h.uow }, owner, {
      name: 'Ops',
      providerId: 'prov-1',
      defaultModel: 'gw-large',
      dailyTokenBudget: 10,
    });
    // Seed spend: one assistant row with 10 tokens today.
    const res = await h.svc.open(owner.userId, a.id, undefined, 'sock-1');
    const sessionId = res.ok ? res.sessionId : '';
    await h.uow.assistants.appendMessage(sessionId, {
      seq: 1,
      type: 'user',
      blocks: [{ type: 'text', text: 'hi' }],
    });
    await h.uow.assistants.appendMessage(sessionId, {
      seq: 2,
      type: 'assistant',
      text: 'ok',
      thought: '',
      toolCalls: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 6, outputTokens: 4 },
    });
    await h.uow.assistants.saveSession({
      ...(await h.uow.assistants.findSessionById(sessionId))!,
      lastMessageAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    h.faux.setResponses([piAi.fauxAssistantMessage([piAi.fauxText('would run')])]);
    await h.svc.onMessageSend(owner.userId, sessionId, 'another');
    await new Promise((r) => setTimeout(r, 100));

    // The refusal is honest: an error note row + prompt-error event, no model call.
    const rows = await h.uow.assistants.listMessages(sessionId);
    const note = rows.find((r) => r.type === 'note');
    expect(note !== undefined && note.type === 'note' && note.text).toContain('budget');
    expect(
      h.events.some(
        (e) =>
          e.event.kind === 'raw' && (e.event as { method: string }).method === 'hnx/prompt-error',
      ),
    ).toBe(true);
    // The scripted response was NOT consumed → the model never ran. Reset for
    // the unlimited control below.
    h.faux.setResponses([piAi.fauxAssistantMessage([piAi.fauxText('runs')])]);

    // An unlimited config (no budget) runs the same setup fine.
    const b = await createAssistant({ uow: h.uow }, owner, {
      name: 'Free',
      providerId: 'prov-1',
      defaultModel: 'gw-large',
    });
    const res2 = await h.svc.open(owner.userId, b.id, undefined, 'sock-1');
    const sessionId2 = res2.ok ? res2.sessionId : '';
    await h.svc.onMessageSend(owner.userId, sessionId2, 'go');
    await settle(h, sessionId2);
    const rows2 = await h.uow.assistants.listMessages(sessionId2);
    expect(rows2[rows2.length - 1]!.type).toBe('assistant');
  });
});
