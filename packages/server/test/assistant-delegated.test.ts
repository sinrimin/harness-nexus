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
 * #95 follow-up — the assistant's third write policy (`permissionMode:
 * 'delegated'`): writes and META calls still surface a permission card, but
 * the shared #92 decision gate answers beside it (first responder wins). A
 * decisive verdict settles the card with attribution; low confidence leaves
 * the card to the human with an advisory. The decision model is a fake
 * SystemOne fetch; nothing here touches the network.
 */

const KEY = 'test-secret-0123456789abcdef';
const owner: Principal = { userId: 'u-owner', role: 'user' };
const now = '2026-01-01T00:00:00.000Z';

type FetchImpl = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

function fakeSystemOne(answers: Record<string, unknown>, log: unknown[]): FetchImpl {
  return async (_url, init) => {
    log.push(JSON.parse(init.body));
    return { ok: true, status: 200, text: async () => JSON.stringify({ answers }) };
  };
}

// v2 — severity 1–2 (a routine in-platform write) allows without consulting
// intent; a flat severity answer escalates to the human card.
const ALLOW = {
  severity: { score: 1.2, confidence: 0.97 },
  intent: { noul: 0.98, confidence: 0.95 },
  why: { choice: 'fine' },
};

async function setup(opts: { delegated?: boolean; answers?: Record<string, unknown> } = {}) {
  const uow = createMemoryUnitOfWork();
  await uow.users.save({
    id: owner.userId,
    username: 'owner',
    email: null,
    passwordHash: null,
    role: 'user',
    status: 'active',
    ...(opts.delegated
      ? { defaultModels: { decision: { providerId: 'prov-dec', modelId: 'decision-model' } } }
      : {}),
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
    apis: [{ kind: 'openai-chat', path: null }],
    baseUrl: 'https://gw.example.com/v1',
    credentialName: 'gw-key',
    scope: 'personal',
    ownerId: owner.userId,
    models: [{ id: 'gw-large', apiKind: 'openai-chat' }],
    createdAt: now,
    updatedAt: now,
  });
  await uow.credentials.save({
    id: 'cred-dec',
    name: 'dec-key',
    secret: encryptSecret('sk-decision', KEY),
    scope: 'personal',
    ownerId: owner.userId,
    distributable: true,
    createdAt: now,
    updatedAt: now,
  });
  await uow.llmProviders.save({
    id: 'prov-dec',
    name: 'Decision',
    apis: [{ kind: 'systemone', path: null }],
    baseUrl: 'https://dec.example.com/v1',
    credentialName: 'dec-key',
    scope: 'personal',
    ownerId: owner.userId,
    models: [{ id: 'decision-model', apiKind: 'systemone' }],
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
  const fetchLog: unknown[] = [];
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
      ...(opts.delegated
        ? {
            approvals: {
              timeoutMs: 2_000,
              fetchImpl: fakeSystemOne(opts.answers ?? ALLOW, fetchLog),
            },
          }
        : {}),
    },
    io,
    undefined,
    { permissionTimeoutMs: 3_000, viewerGraceMs: 0 },
  );
  return { svc, uow, faux, events, fetchLog };
}

async function settle(
  h: Awaited<ReturnType<typeof setup>>,
  sessionId: string,
  minRows = 1,
): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    const rows = await h.uow.assistants.listMessages(sessionId);
    const settled = rows.length >= minRows && rows[rows.length - 1]!.type === 'assistant';
    if (settled) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('turn did not settle');
}

const writeCall = (name: string, args: unknown) =>
  piAi.fauxAssistantMessage([piAi.fauxToolCall(name, args)]);

const skillWrite = (key: string) =>
  writeCall('resources_create', {
    resource: {
      key,
      kind: 'skill',
      name: key,
      source: { type: 'inline', content: 'x' },
      scope: 'personal',
    },
  });

describe('#95 — assistant delegated write policy', () => {
  it('auto-answers a write with the decision model and runs it', async () => {
    const h = await setup({ delegated: true });
    const a = await createAssistant({ uow: h.uow }, owner, {
      name: 'Delegated',
      providerId: 'prov-1',
      defaultModel: 'gw-large',
      enabledToolGroups: ['resources'],
      permissionMode: 'delegated',
    });
    h.faux.setResponses([
      skillWrite('skill:delegated'),
      piAi.fauxAssistantMessage([piAi.fauxText('done')]),
    ]);
    const res = await h.svc.open(owner.userId, a.id, undefined, 'sock-1');
    const sessionId = res.ok ? res.sessionId : '';
    await h.svc.onMessageSend(owner.userId, sessionId, 'make a skill');
    await settle(h, sessionId);

    // The card still surfaces (audit/visibility), then settles delegated.
    expect(h.events.some((e) => e.event.kind === 'permission_request')).toBe(true);
    const resolved = h.events.find(
      (e) => e.event.kind === 'permission_resolved' && e.event.responder === 'delegated',
    );
    expect(resolved).toBeDefined();
    if (resolved?.event.kind !== 'permission_resolved') throw new Error('missing resolved');
    expect(resolved.event.decidedBy).toBe('model');
    expect(resolved.event.delegated).toMatchObject({
      providerName: 'Decision',
      modelId: 'decision-model',
    });
    // The gate saw the user's prompt and the one-shot options only.
    expect(h.fetchLog).toHaveLength(1);
    // #92 amendment — the seam's args travel as toolCall.input (the ds-web
    // trial: a web_search scored 0.16 with the query invisible), the tool's
    // own description rides along, and the user's own prompt is in the
    // window (the rowsBefore fix).
    const sent = h.fetchLog[0] as {
      state: {
        toolCall: { title: string; input?: string; description?: string };
        userPrompts: string[];
      };
    };
    expect(sent.state.toolCall.input).toContain('skill:delegated');
    expect(sent.state.toolCall.description).toContain('Create a resource');
    expect(sent.state.userPrompts).toContain('make a skill');
    const list = await h.uow.resources.list({ scope: 'personal', ownerId: owner.userId });
    expect(list.some((r) => r.key === 'skill:delegated')).toBe(true);
  });

  it('low confidence leaves the card to the human with an advisory', async () => {
    const h = await setup({
      delegated: true,
      answers: {
        severity: { score: 1.2, confidence: 0.4 },
        intent: { noul: 0.98, confidence: 0.9 },
        why: { choice: 'fine' },
      },
    });
    const a = await createAssistant({ uow: h.uow }, owner, {
      name: 'Unsure',
      providerId: 'prov-1',
      defaultModel: 'gw-large',
      enabledToolGroups: ['resources'],
      permissionMode: 'delegated',
    });
    h.faux.setResponses([
      skillWrite('skill:human'),
      piAi.fauxAssistantMessage([piAi.fauxText('done')]),
    ]);
    const res = await h.svc.open(owner.userId, a.id, undefined, 'sock-1');
    const sessionId = res.ok ? res.sessionId : '';
    await h.svc.onMessageSend(owner.userId, sessionId, 'make a skill');

    let requestId: string | undefined;
    for (let i = 0; i < 300 && requestId === undefined; i += 1) {
      const card = h.events.find((e) => e.event.kind === 'permission_request');
      if (card?.event.kind === 'permission_request') requestId = card.event.requestId;
      else await new Promise((r) => setTimeout(r, 10));
    }
    if (requestId === undefined) throw new Error('no permission card');
    // The model's lean is advisory only; the card is still pending.
    expect(
      h.events.some((e) => e.event.kind === 'permission_advisory' && e.event.lean === 'allow'),
    ).toBe(true);
    expect(h.events.some((e) => e.event.kind === 'permission_resolved')).toBe(false);

    // The human answers — the write then runs.
    expect(h.svc.onPermissionRespond(owner.userId, sessionId, requestId, 'allow_once')).toEqual({
      ok: true,
    });
    await settle(h, sessionId);
    const list = await h.uow.resources.list({ scope: 'personal', ownerId: owner.userId });
    expect(list.some((r) => r.key === 'skill:human')).toBe(true);
  });

  it('advertises the third option and refuses it when no decision model resolves', async () => {
    const h = await setup(); // no default decision model, no approvals dep
    const a = await createAssistant({ uow: h.uow }, owner, {
      name: 'Plain',
      providerId: 'prov-1',
      defaultModel: 'gw-large',
      enabledToolGroups: [],
      permissionMode: 'prompt',
    });
    const res = await h.svc.open(owner.userId, a.id, undefined, 'sock-1');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const config = h.events.filter((e) => e.event.kind === 'session_config').at(-1)?.event;
    if (config?.kind !== 'session_config') throw new Error('missing config');
    const perm = config.configOptions?.find((o) => o.id === 'permissionMode');
    expect(perm?.options?.map((o) => o.value)).toEqual(['prompt', 'autoWrite', 'delegated']);

    expect(
      await h.svc.onConfigSet(owner.userId, res.sessionId, {
        configId: 'permissionMode',
        value: 'delegated',
      }),
    ).toEqual({ ok: false, code: 'ASSISTANT_APPROVALS_NO_PROVIDER' });
  });

  it('a config default of delegated without a resolvable model falls back to the human card', async () => {
    const h = await setup(); // no user default, no approvals dep
    const a = await createAssistant({ uow: h.uow }, owner, {
      name: 'Fallback',
      providerId: 'prov-1',
      defaultModel: 'gw-large',
      enabledToolGroups: ['resources'],
      permissionMode: 'delegated',
    });
    h.faux.setResponses([
      skillWrite('skill:fallback'),
      piAi.fauxAssistantMessage([piAi.fauxText('done')]),
    ]);
    const res = await h.svc.open(owner.userId, a.id, undefined, 'sock-1');
    const sessionId = res.ok ? res.sessionId : '';
    await h.svc.onMessageSend(owner.userId, sessionId, 'make a skill');
    let requestId: string | undefined;
    for (let i = 0; i < 300 && requestId === undefined; i += 1) {
      const card = h.events.find((e) => e.event.kind === 'permission_request');
      if (card?.event.kind === 'permission_request') requestId = card.event.requestId;
      else await new Promise((r) => setTimeout(r, 10));
    }
    if (requestId === undefined) throw new Error('no permission card');
    // No gate ran: the card simply waits for the human.
    expect(h.events.some((e) => e.event.kind === 'permission_advisory')).toBe(false);
    h.svc.onPermissionRespond(owner.userId, sessionId, requestId, 'reject_once');
    await settle(h, sessionId);
    const list = await h.uow.resources.list({ scope: 'personal', ownerId: owner.userId });
    expect(list.some((r) => r.key === 'skill:fallback')).toBe(false);
  });
});
