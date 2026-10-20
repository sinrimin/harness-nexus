// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import * as piAi from '@earendil-works/pi-ai';
import type { UnitOfWork } from '@harness-nexus/core';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import { encryptSecret } from '../src/infra/crypto.js';
import { createAssistant } from '../src/services/assistant.js';
import type { Principal } from '../src/services/principal.js';
import { AssistantRealtimeService, type AssistantIO } from '../src/realtime/assistant.js';
import type { ChatStreamEvent, HistoryItem, PromptBlock } from '@harness-nexus/shared';

/**
 * #52 M1 — the assistant runtime, driven END-TO-END through the realtime
 * coordinator with pi-ai's scripted FAUX provider standing in for the model
 * (no network, ever; the `buildModel` seam is exactly this injection point).
 * Covers: open/send/turn with a tool call, transcript persistence, audit
 * rows, the per-user busy gate + depth-1 queue, config.set rebind, and
 * owner-only access.
 */

const KEY = 'test-secret-0123456789abcdef';
const owner: Principal = { userId: 'u-owner', role: 'user' };
const other: Principal = { userId: 'u-other', role: 'user' };

interface Harness {
  svc: AssistantRealtimeService;
  uow: UnitOfWork;
  faux: ReturnType<typeof piAi.fauxProvider>;
  events: { sessionId: string; event: ChatStreamEvent }[];
  /** Provider ids the buildModel seam resolved, in turn order (#58-4). */
  providersSeen: string[];
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
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  await uow.credentials.save({
    id: 'cred-1',
    name: 'gw-key',
    secret: encryptSecret('sk-test', KEY),
    scope: 'personal',
    ownerId: owner.userId,
    distributable: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  await uow.llmProviders.save({
    id: 'prov-1',
    name: 'Gateway',
    api: 'openai-chat',
    baseUrl: 'https://gw.example.com/v1',
    credentialName: 'gw-key',
    scope: 'personal',
    ownerId: owner.userId,
    models: [
      {
        id: 'gw-large',
        type: 'chat',
        displayName: 'Gateway Large',
        contextWindow: 64_000,
        maxOutputTokens: 4_000,
      },
    ],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  const faux = piAi.fauxProvider({
    models: [{ id: 'gw-large', name: 'Gateway Large', contextWindow: 64_000 }],
    tokensPerSecond: 1_000_000,
  });
  const models = piAi.createModels();
  models.setProvider(faux.provider);

  const events: { sessionId: string; event: ChatStreamEvent }[] = [];
  const providersSeen: string[] = [];
  const io: AssistantIO = {
    toChannel: (_sessionId, event, payload) => {
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
      buildModel: async ({ provider }) => {
        providersSeen.push(provider.id);
        return {
          model: faux.getModel('gw-large'),
          streamFn: models.streamSimple.bind(models),
        };
      },
    },
    io,
  );

  const config = await createAssistant({ uow }, owner, {
    name: 'Ops',
    providerId: 'prov-1',
    defaultModel: 'gw-large',
    enabledToolGroups: ['resources', 'system'],
  });
  await createAssistant({ uow }, owner, {
    name: 'Second',
    providerId: 'prov-1',
    defaultModel: 'gw-large',
    enabledToolGroups: ['system'],
  });
  return { svc, uow, faux, events, providersSeen };
}

async function opsId(h: Harness): Promise<string> {
  const configs = await h.uow.assistants.listByOwner(owner.userId);
  return configs.find((c) => c.name === 'Ops')!.id;
}

async function secondId(h: Harness): Promise<string> {
  const configs = await h.uow.assistants.listByOwner(owner.userId);
  return configs.find((c) => c.name === 'Second')!.id;
}

/** Wait until the per-user busy gate is free (turns are settled). */
async function busySettled(h: Harness, sessionId: string): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    // The idle session_status at the end of the LAST turn is our marker: poll
    // the transcript until it stops growing AND the events ended idle.
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

describe('#52 assistant runtime (faux provider)', () => {
  it('runs a tool-calling turn end to end: stream events, transcript rows, audit, title', async () => {
    const h = await setup();
    h.faux.setResponses([
      piAi.fauxAssistantMessage([piAi.fauxToolCall('system_info', {})]),
      piAi.fauxAssistantMessage([piAi.fauxText('platform version listed')]),
    ]);

    const res = await h.svc.open(owner.userId, await opsId(h), undefined, 'sock-1');
    expect(res.ok).toBe(true);
    const sessionId = res.ok ? res.sessionId : '';

    const send = await h.svc.onMessageSend(owner.userId, sessionId, 'what version is this?');
    expect(send).toEqual({ ok: true, queued: false });

    await busySettled(h, sessionId);
    const kinds = h.events.map((e) => e.event.kind);
    expect(kinds).toContain('user_message');
    expect(kinds).toContain('session_status');
    expect(kinds.filter((k) => k === 'tool_call').length).toBeGreaterThanOrEqual(2);
    expect(kinds).toContain('message_delta');
    expect(kinds).toContain('turn_result');
    expect(kinds.at(-1)).toBe('session_status');

    const rows = await h.uow.assistants.listMessages(sessionId);
    expect(rows.map((r) => r.type)).toEqual(['user', 'assistant', 'toolResult', 'assistant']);
    expect(rows[1]!.type === 'assistant' && rows[1]!.toolCalls[0]!.tool).toBe('system_info');
    expect(rows[2]!.type === 'toolResult' && rows[2]!.results[0]!.isError).toBe(false);

    const audits = await h.uow.assistants.listToolCallAudits(sessionId);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.tool).toBe('system_info');
    expect(audits[0]!.status).toBe('ok');

    const session = await h.uow.assistants.findSessionById(sessionId);
    expect(session?.title).toBe('what version is this?');
    expect(session?.lastMessageAt).not.toBeNull();

    const history: HistoryItem[] = await h.svc.historyFor(sessionId);
    expect(history[0]!.type).toBe('user');
    const toolEvent = history.find((i) => i.type === 'event' && i.event.kind === 'tool_call') as
      | {
          type: 'event';
          event: { kind: 'tool_call'; call: { toolName?: string; output?: string } };
        }
      | undefined;
    expect(toolEvent?.event.call.toolName).toBe('system_info');
    expect(toolEvent?.event.call.output).toContain('version');
  });

  it('parks a second send in the depth-1 queue while the user is busy, then flushes', async () => {
    const h = await setup();
    const res = await h.svc.open(owner.userId, await opsId(h), undefined, 'sock-1');
    const sessionId = res.ok ? res.sessionId : '';

    h.faux.setResponses([
      piAi.fauxAssistantMessage([piAi.fauxText('first answer')]),
      piAi.fauxAssistantMessage([piAi.fauxText('second answer')]),
    ]);

    const first = await h.svc.onMessageSend(owner.userId, sessionId, 'first');
    expect(first).toEqual({ ok: true, queued: false });
    const second = await h.svc.onMessageSend(owner.userId, sessionId, 'second');
    expect(second).toEqual({ ok: true, queued: true });
    expect(h.events.some((e) => e.event.kind === 'queue_state' && e.event.prompt !== null)).toBe(
      true,
    );
    const third = await h.svc.onMessageSend(owner.userId, sessionId, 'third');
    expect(third).toEqual({ ok: false, code: 'QUEUE_FULL' });

    await busySettled(h, sessionId);
    const rows = await h.uow.assistants.listMessages(sessionId);
    expect(rows.filter((r) => r.type === 'user')).toHaveLength(2);
    expect(rows.filter((r) => r.type === 'assistant' && r.text !== '')).toHaveLength(2);
    expect(
      h.events.some(
        (e) => e.event.kind === 'queue_state' && (e.event as { flushed: boolean }).flushed,
      ),
    ).toBe(true);
  });

  it("refuses another user's assistant and session (owner-only)", async () => {
    const h = await setup();
    const id = await opsId(h);
    const res = await h.svc.open(owner.userId, id, undefined, 'sock-1');
    expect(res.ok).toBe(true);
    const sessionId = res.ok ? res.sessionId : '';

    expect(await h.svc.open(other.userId, id, sessionId, 'sock-2')).toEqual({
      ok: false,
      code: 'ASSISTANT_NOT_FOUND',
    });
    expect(await h.svc.onMessageSend(other.userId, sessionId, 'hi')).toEqual({
      ok: false,
      code: 'SESSION_NOT_FOUND',
    });
  });

  it('config.set rebinds the agent for the next turn (note row + new option snapshot)', async () => {
    const h = await setup();
    const res = await h.svc.open(owner.userId, await opsId(h), undefined, 'sock-1');
    const sessionId = res.ok ? res.sessionId : '';

    const set = await h.svc.onConfigSet(owner.userId, sessionId, {
      configId: 'agent',
      value: await secondId(h),
    });
    expect(set.ok).toBe(true);
    const rows = await h.uow.assistants.listMessages(sessionId);
    expect(rows.some((r) => r.type === 'note' && r.text.includes('"Second"'))).toBe(true);

    // The LAST session_config snapshot is the post-rebind truth (open also
    // pushed one before the switch).
    const cfgEvents = h.events.filter((e) => e.event.kind === 'session_config');
    const cfgEvent = cfgEvents.at(-1);
    expect(cfgEvent).toBeDefined();
    const options = (
      cfgEvent!.event as {
        configOptions: { id: string; currentValue: string; options: { value: string }[] }[];
      }
    ).configOptions;
    expect(options.find((o) => o.id === 'agent')?.currentValue).toBe(await secondId(h));
    expect(options.find((o) => o.id === 'model')?.options).toHaveLength(1);

    expect(
      await h.svc.onConfigSet(owner.userId, sessionId, { configId: 'model', value: 'nope' }),
    ).toEqual({ ok: false, code: 'ASSISTANT_MODEL_NOT_ON_PROVIDER' });
  });

  it('#58-4 model select spans visible providers (grouped) and re-points the turn', async () => {
    const h = await setup();
    // A second, GLOBAL provider exposing the SAME model name — the exact case
    // the locked-to-config dropdown could not distinguish or switch.
    await h.uow.llmProviders.save({
      id: 'prov-2',
      name: 'Second Gateway',
      api: 'openai-chat',
      baseUrl: 'https://gw2.example.com/v1',
      credentialName: 'gw-key',
      scope: 'global',
      ownerId: null,
      models: [{ id: 'gw-large', type: 'chat', displayName: 'Gw2 Large' }],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    // Another user's PERSONAL provider — #36: never listed, never settable.
    await h.uow.llmProviders.save({
      id: 'prov-other',
      name: 'Stranger',
      api: 'openai-chat',
      baseUrl: 'https://stranger.example.com/v1',
      credentialName: 'gw-key',
      scope: 'personal',
      ownerId: other.userId,
      models: [{ id: 'sneaky', type: 'chat' }],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });

    const res = await h.svc.open(owner.userId, await opsId(h), undefined, 'sock-1');
    const sessionId = res.ok ? res.sessionId : '';
    type CfgEvent = Extract<ChatStreamEvent, { kind: 'session_config' }>;
    const lastCfg = (): CfgEvent =>
      h.events.filter((e) => e.event.kind === 'session_config').at(-1)!.event as CfgEvent;

    const initial = lastCfg().configOptions.find((o) => o.id === 'model')!;
    expect(initial.currentValue).toBe('prov-1/gw-large');
    expect(initial.options).toEqual([
      { value: 'prov-1/gw-large', name: 'Gateway Large', group: 'Gateway' },
      { value: 'prov-2/gw-large', name: 'Gw2 Large', group: 'Second Gateway' },
    ]);

    // Switch to the other provider's same-named model; the NEXT turn resolves
    // prov-2 (the config stays the default-binding only).
    expect(
      await h.svc.onConfigSet(owner.userId, sessionId, {
        configId: 'model',
        value: 'prov-2/gw-large',
      }),
    ).toEqual({ ok: true });
    expect(lastCfg().configOptions.find((o) => o.id === 'model')!.currentValue).toBe(
      'prov-2/gw-large',
    );
    h.faux.setResponses([piAi.fauxAssistantMessage([piAi.fauxText('ok')])]);
    await h.svc.onMessageSend(owner.userId, sessionId, 'hi');
    await busySettled(h, sessionId);
    expect(h.providersSeen.at(-1)).toBe('prov-2');

    // #36 — a stranger's personal provider is refused even when spelled out.
    expect(
      await h.svc.onConfigSet(owner.userId, sessionId, {
        configId: 'model',
        value: 'prov-other/sneaky',
      }),
    ).toEqual({ ok: false, code: 'ASSISTANT_MODEL_NOT_ON_PROVIDER' });

    // Legacy bare id — resolves against the channel's CURRENT provider.
    expect(
      await h.svc.onConfigSet(owner.userId, sessionId, { configId: 'model', value: 'gw-large' }),
    ).toEqual({ ok: true });
    expect(lastCfg().configOptions.find((o) => o.id === 'model')!.currentValue).toBe(
      'prov-2/gw-large',
    );
  });

  it('blocks tools outside the enabled groups (belt-and-braces gate)', async () => {
    const h = await setup();
    // 'Second' has only the system group — a machines tool must not run.
    const res = await h.svc.open(owner.userId, await secondId(h), undefined, 'sock-1');
    const sessionId = res.ok ? res.sessionId : '';
    h.faux.setResponses([
      piAi.fauxAssistantMessage([piAi.fauxToolCall('machines_list', {})]),
      piAi.fauxAssistantMessage([piAi.fauxText('done')]),
    ]);
    await h.svc.onMessageSend(owner.userId, sessionId, 'list machines');
    await busySettled(h, sessionId);
    // The attempt IS audited (an error row — the model tried), and the
    // model-facing result is an error it can react to.
    const audits = await h.uow.assistants.listToolCallAudits(sessionId);
    const attempt = audits.find((a) => a.tool === 'machines_list');
    expect(attempt?.status).toBe('error');
    const rows = await h.uow.assistants.listMessages(sessionId);
    const toolRow = rows.find((r) => r.type === 'toolResult');
    expect(
      toolRow !== undefined && toolRow.type === 'toolResult' && toolRow.results[0]!.isError,
    ).toBe(true);
  });
});
