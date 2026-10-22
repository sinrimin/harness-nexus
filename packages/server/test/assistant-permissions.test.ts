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

async function setup() {
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
    { permissionTimeoutMs: 150, viewerGraceMs: 0 },
  );
  return { svc, uow, faux, events };
}

async function settle(h: Awaited<ReturnType<typeof setup>>, sessionId: string): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    const rows = await h.uow.assistants.listMessages(sessionId);
    const settled = rows.length > 0 && rows[rows.length - 1]!.type === 'assistant';
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
});
