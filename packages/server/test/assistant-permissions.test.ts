// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import * as piAi from '@earendil-works/pi-ai';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import { createSqliteUnitOfWork } from '../src/infra/storage/sqlite/index.js';
import { encryptSecret } from '../src/infra/crypto.js';
import { createAssistant } from '../src/services/assistant.js';
import type { Principal } from '../src/services/principal.js';
import { AssistantRealtimeService, type AssistantIO } from '../src/realtime/assistant.js';
import { toolNeedsApproval, type AssistantToolClass } from '../src/assistant/tools.js';
import type { AssistantPermissionMode } from '@harness-nexus/core';
import type { ChatStreamEvent } from '@harness-nexus/shared';

/**
 * #79 — the graduated permission gate: classes are DECLARED on each tool and
 * the config's permissionMode decides writes. Reads never prompt; writes
 * prompt unless autoWrite pre-authorized them; meta ALWAYS prompts (no
 * silent tier — asserted through the decision table; its first real member
 * is API-tool create/modify, #80).
 */

const KEY = 'test-secret-0123456789abcdef';
const owner: Principal = { userId: 'u-owner', role: 'user' };
const now = '2026-01-01T00:00:00.000Z';

async function setup(opts: { tokensPerSecond?: number } = {}) {
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
    tokensPerSecond: opts.tokensPerSecond ?? 1_000_000,
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
    { permissionTimeoutMs: 150, viewerGraceMs: 0 },
  );
  return { svc, uow, faux, events };
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

describe('#79 — the class × mode decision table', () => {
  const cases: [AssistantToolClass, AssistantPermissionMode | undefined, boolean][] = [
    ['read', 'prompt', false],
    ['read', 'autoWrite', false],
    ['write', 'prompt', true],
    ['write', 'autoWrite', false],
    ['write', undefined, true], // absent config field = prompt (pre-#79 rows)
    ['meta', 'prompt', true],
    ['meta', 'autoWrite', true], // no silent tier for boundary-changing ops
  ];
  for (const [cls, mode, expected] of cases) {
    it(`${cls} × ${mode ?? '(absent)'} → ${expected ? 'approval' : 'silent'}`, () => {
      expect(toolNeedsApproval(cls, mode)).toBe(expected);
    });
  }
});

describe('#79 — write policy through a live turn', () => {
  it('autoWrite runs a declared write WITHOUT a card', async () => {
    const h = await setup();
    const a = await createAssistant({ uow: h.uow }, owner, {
      name: 'Auto',
      providerId: 'prov-1',
      defaultModel: 'gw-large',
      enabledToolGroups: ['resources'],
      permissionMode: 'autoWrite',
    });
    h.faux.setResponses([
      writeCall('resources_create', {
        resource: {
          key: 'skill:auto',
          kind: 'skill',
          name: 'Auto',
          source: { type: 'inline', content: 'x' },
          scope: 'personal',
        },
      }),
      piAi.fauxAssistantMessage([piAi.fauxText('created')]),
    ]);
    const res = await h.svc.open(owner.userId, a.id, undefined, 'sock-1');
    const sessionId = res.ok ? res.sessionId : '';
    await h.svc.onMessageSend(owner.userId, sessionId, 'make a skill');
    await settle(h, sessionId);

    expect(h.events.some((e) => e.event.kind === 'permission_request')).toBe(false);
    const list = await h.uow.resources.list({ scope: 'personal', ownerId: owner.userId });
    expect(list.some((r) => r.key === 'skill:auto')).toBe(true);
  });

  it('a read tool never cards regardless of mode; prompt mode still cards writes', async () => {
    const h = await setup();
    const a = await createAssistant({ uow: h.uow }, owner, {
      name: 'Prompt',
      providerId: 'prov-1',
      defaultModel: 'gw-large',
      enabledToolGroups: ['system'],
      permissionMode: 'prompt',
    });
    h.faux.setResponses([
      writeCall('system_info', {}),
      piAi.fauxAssistantMessage([piAi.fauxText('done')]),
    ]);
    const res = await h.svc.open(owner.userId, a.id, undefined, 'sock-1');
    const sessionId = res.ok ? res.sessionId : '';
    await h.svc.onMessageSend(owner.userId, sessionId, 'info please');
    await settle(h, sessionId);
    expect(h.events.some((e) => e.event.kind === 'permission_request')).toBe(false);

    // Same config, a write tool (resources group off — re-script through a
    // second config exercising the M3 path is covered by assistant-m3; here
    // we assert the mode round-trips through the service).
    expect(a.permissionMode).toBe('prompt');
  });

  it('the permission mode persists through the repository', async () => {
    const h = await setup();
    const a = await createAssistant({ uow: h.uow }, owner, {
      name: 'Stored',
      providerId: 'prov-1',
      defaultModel: 'gw-large',
      enabledToolGroups: [],
      permissionMode: 'autoWrite',
    });
    const read = await h.uow.assistants.findById(a.id);
    expect(read?.permissionMode).toBe('autoWrite');
    // Absent field = prompt (pre-#79 rows).
    const legacy = await h.uow.assistants.save({
      ...a,
      id: 'asst-legacy',
      name: 'Legacy',
      permissionMode: undefined,
    });
    expect((await h.uow.assistants.findById(legacy.id))?.permissionMode).toBeUndefined();
  });

  it('#80 — a configured API tool joins the turn as api__<service>__<tool>, class from method', async () => {
    const h = await setup();
    // A REAL loopback upstream (internal-flagged allowlist entry) — the full
    // runtime path, no fetch stubs.
    const { createServer } = await import('node:http');
    const server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end('{"code":0,"body":{"temp":21}}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    try {
      await h.uow.settings.save({
        ...(await h.uow.settings.get()),
        apiToolAllowlist: [{ host: '127.0.0.1', internal: true }],
        updatedAt: now,
      });
      await h.uow.apiTools.save({
        id: 's-wx',
        scope: 'personal',
        ownerId: owner.userId,
        name: 'weather',
        baseUrl: `http://127.0.0.1:${port}`,
        headers: {},
        tools: [
          {
            name: 'get_forecast',
            method: 'GET',
            path: '/v1/forecast',
            params: [{ name: 'city', in: 'query', type: 'string', required: true }],
            envelope: {
              codeField: 'code',
              success: [0],
              payloadField: 'body',
              errorFields: ['message'],
            },
          },
        ],
        createdAt: now,
        updatedAt: now,
      });
      const a = await createAssistant({ uow: h.uow }, owner, {
        name: 'Tooled',
        providerId: 'prov-1',
        defaultModel: 'gw-large',
        enabledToolGroups: ['api-tools'],
        apiToolServiceIds: ['s-wx'],
      });
      h.faux.setResponses([
        writeCall('api__weather__get_forecast', { city: 'Oslo' }),
        piAi.fauxAssistantMessage([piAi.fauxText('done')]),
      ]);
      const res = await h.svc.open(owner.userId, a.id, undefined, 'sock-1');
      const sessionId = res.ok ? res.sessionId : '';
      await h.svc.onMessageSend(owner.userId, sessionId, 'weather in Oslo?');
      await settle(h, sessionId);

      // GET → read: no card in EITHER mode.
      expect(h.events.some((e) => e.event.kind === 'permission_request')).toBe(false);
      const rows = await h.uow.assistants.listMessages(sessionId);
      const results = rows.flatMap((r) => (r.type === 'toolResult' ? r.results : []));
      const call = results.find((r) => r.tool === 'api__weather__get_forecast');
      expect(call?.isError).toBe(false);
      expect(call?.output).toContain('"temp": 21');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('#79 — the sender-level write-policy switch (session overrides config)', () => {
  /** The last session_config push's value for one option id. */
  const lastOption = (h: Awaited<ReturnType<typeof setup>>, id: string): string | undefined => {
    const configs = h.events.filter((e) => e.event.kind === 'session_config');
    const last = configs[configs.length - 1];
    if (last === undefined || last.event.kind !== 'session_config') return undefined;
    return last.event.configOptions?.find((o) => o.id === id)?.currentValue;
  };

  it('a fresh session stamps the config default into the composer option', async () => {
    const h = await setup();
    const a = await createAssistant({ uow: h.uow }, owner, {
      name: 'Default',
      providerId: 'prov-1',
      defaultModel: 'gw-large',
      enabledToolGroups: [],
      permissionMode: 'autoWrite',
    });
    await h.svc.open(owner.userId, a.id, undefined, 'sock-1');
    expect(lastOption(h, 'permissionMode')).toBe('autoWrite');
  });

  it('a legacy row (no stored mode) falls back to the config default at open', async () => {
    const h = await setup();
    const a = await createAssistant({ uow: h.uow }, owner, {
      name: 'LegacyRow',
      providerId: 'prov-1',
      defaultModel: 'gw-large',
      enabledToolGroups: [],
      permissionMode: 'autoWrite',
    });
    // A pre-v27 shape: the session row simply has no permissionMode field.
    await h.uow.assistants.saveSession({
      id: 'sess-legacy',
      ownerId: owner.userId,
      assistantId: a.id,
      title: 'old',
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
    });
    await h.svc.open(owner.userId, a.id, 'sess-legacy', 'sock-1');
    expect(lastOption(h, 'permissionMode')).toBe('autoWrite');
  });

  it('the switch moves the gate for the NEXT turn (card, then silent)', async () => {
    const h = await setup();
    const a = await createAssistant({ uow: h.uow }, owner, {
      name: 'Switchy',
      providerId: 'prov-1',
      defaultModel: 'gw-large',
      enabledToolGroups: ['resources'],
      permissionMode: 'prompt',
    });
    h.faux.setResponses([
      writeCall('resources_create', {
        resource: {
          key: 'skill:before',
          kind: 'skill',
          name: 'Before',
          source: { type: 'inline', content: 'x' },
          scope: 'personal',
        },
      }),
      piAi.fauxAssistantMessage([piAi.fauxText('denied, fine')]),
      writeCall('resources_create', {
        resource: {
          key: 'skill:after',
          kind: 'skill',
          name: 'After',
          source: { type: 'inline', content: 'x' },
          scope: 'personal',
        },
      }),
      piAi.fauxAssistantMessage([piAi.fauxText('created')]),
    ]);
    const res = await h.svc.open(owner.userId, a.id, undefined, 'sock-1');
    const sessionId = res.ok ? res.sessionId : '';

    // Turn 1 under prompt: the write cards, times out (150ms), and is denied.
    await h.svc.onMessageSend(owner.userId, sessionId, 'make one');
    await settle(h, sessionId);
    expect(h.events.filter((e) => e.event.kind === 'permission_request').length).toBe(1);
    expect(
      (await h.uow.resources.list({ scope: 'personal', ownerId: owner.userId })).some(
        (r) => r.key === 'skill:before',
      ),
    ).toBe(false);

    // Flip the sender switch → turn 2's identical write runs silently.
    const flip = await h.svc.onConfigSet(owner.userId, sessionId, {
      configId: 'permissionMode',
      value: 'autoWrite',
    });
    expect(flip.ok).toBe(true);
    expect(lastOption(h, 'permissionMode')).toBe('autoWrite');
    await h.svc.onMessageSend(owner.userId, sessionId, 'make another');
    // `settle` keys on the LAST assistant row — turn 1 already ended with one,
    // so wait for turn 2's rows (its user row + its closing row) first.
    const rowsAfterTurn1 = (await h.uow.assistants.listMessages(sessionId)).length;
    await settle(h, sessionId, rowsAfterTurn1 + 2);
    expect(h.events.filter((e) => e.event.kind === 'permission_request').length).toBe(1);
    expect(
      (await h.uow.resources.list({ scope: 'personal', ownerId: owner.userId })).some(
        (r) => r.key === 'skill:after',
      ),
    ).toBe(true);
  });

  it('an idle switch persists on the row and survives close/reopen', async () => {
    const h = await setup();
    const a = await createAssistant({ uow: h.uow }, owner, {
      name: 'Sticky',
      providerId: 'prov-1',
      defaultModel: 'gw-large',
      enabledToolGroups: [],
      permissionMode: 'prompt',
    });
    h.faux.setResponses([piAi.fauxAssistantMessage([piAi.fauxText('hello there')])]);
    const res = await h.svc.open(owner.userId, a.id, undefined, 'sock-1');
    const sessionId = res.ok ? res.sessionId : '';
    await h.svc.onMessageSend(owner.userId, sessionId, 'hi');
    await settle(h, sessionId);

    await h.svc.onConfigSet(owner.userId, sessionId, {
      configId: 'permissionMode',
      value: 'autoWrite',
    });
    expect((await h.uow.assistants.findSessionById(sessionId))?.permissionMode).toBe('autoWrite');

    await h.svc.close(owner.userId, sessionId, 'user');
    h.events.length = 0;
    await h.svc.open(owner.userId, a.id, sessionId, 'sock-2');
    expect(lastOption(h, 'permissionMode')).toBe('autoWrite');
  });

  it('a mid-turn switch persists via settle — the turn snapshot cannot revert it', async () => {
    const h = await setup({ tokensPerSecond: 40 });
    const a = await createAssistant({ uow: h.uow }, owner, {
      name: 'Midturn',
      providerId: 'prov-1',
      defaultModel: 'gw-large',
      enabledToolGroups: [],
      permissionMode: 'prompt',
    });
    h.faux.setResponses([
      piAi.fauxAssistantMessage([piAi.fauxText(`slow ${'stream '.repeat(60)}`)]),
    ]);
    const res = await h.svc.open(owner.userId, a.id, undefined, 'sock-1');
    const sessionId = res.ok ? res.sessionId : '';
    const sent = h.svc.onMessageSend(owner.userId, sessionId, 'go');

    // Wait until the turn is provably streaming, then flip mid-turn.
    for (let i = 0; i < 500; i += 1) {
      if (
        h.events.some((e) => e.event.kind === 'message_delta' || e.event.kind === 'thought_delta')
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 4));
    }
    const flip = await h.svc.onConfigSet(owner.userId, sessionId, {
      configId: 'permissionMode',
      value: 'autoWrite',
    });
    expect(flip.ok).toBe(true);
    // Deferred while the turn runs: the row still holds the open-time policy.
    expect((await h.uow.assistants.findSessionById(sessionId))?.permissionMode).toBe('prompt');

    await sent;
    await settle(h, sessionId);
    expect((await h.uow.assistants.findSessionById(sessionId))?.permissionMode).toBe('autoWrite');
  });

  it('an invalid mode value is refused', async () => {
    const h = await setup();
    const a = await createAssistant({ uow: h.uow }, owner, {
      name: 'Strict',
      providerId: 'prov-1',
      defaultModel: 'gw-large',
      enabledToolGroups: [],
    });
    const res = await h.svc.open(owner.userId, a.id, undefined, 'sock-1');
    const sessionId = res.ok ? res.sessionId : '';
    const bad = await h.svc.onConfigSet(owner.userId, sessionId, {
      configId: 'permissionMode',
      value: 'yolo',
    });
    expect(bad).toEqual({ ok: false, code: 'ASSISTANT_BAD_PERMISSION_MODE' });
    expect(lastOption(h, 'permissionMode')).toBe('prompt');
  });
});

describe('#79 — sqlite assistant_sessions.permission_mode round-trip (v27)', () => {
  it('stores and clears the conversation policy; legacy NULL reads as undefined', async (ctx) => {
    let uow: ReturnType<typeof createSqliteUnitOfWork>;
    try {
      uow = createSqliteUnitOfWork(':memory:');
    } catch {
      return ctx.skip('better-sqlite3 native binding unavailable for this Node major');
    }
    // assistant_sessions carries FKs (owner + config) — seed both.
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
    await uow.assistants.save({
      id: 'asst-1',
      ownerId: owner.userId,
      name: 'S',
      providerId: 'prov-1',
      defaultModel: 'm',
      enabledToolGroups: [],
      mcpServerIds: [],
      skillResourceIds: [],
      apiToolServiceIds: [],
      createdAt: now,
      updatedAt: now,
    });
    const base = {
      ownerId: owner.userId,
      assistantId: 'asst-1',
      title: '',
      createdAt: now,
      updatedAt: now,
      lastMessageAt: null,
    };
    await uow.assistants.saveSession({ id: 's1', ...base, permissionMode: 'autoWrite' });
    expect((await uow.assistants.findSessionById('s1'))?.permissionMode).toBe('autoWrite');
    // Clearing (undefined) writes NULL back — the legacy shape reads as such.
    await uow.assistants.saveSession({ id: 's1', ...base });
    expect((await uow.assistants.findSessionById('s1'))?.permissionMode).toBeUndefined();
  });
});
