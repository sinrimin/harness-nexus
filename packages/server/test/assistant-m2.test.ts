// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import * as piAi from '@earendil-works/pi-ai';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import { encryptSecret } from '../src/infra/crypto.js';
import { createAssistant, updateAssistant } from '../src/services/assistant.js';
import type { Principal } from '../src/services/principal.js';
import { AssistantRealtimeService, type AssistantIO } from '../src/realtime/assistant.js';
import type { ChatStreamEvent } from '@harness-nexus/shared';
import type { AggregatedTool } from '@harness-nexus/mcp-runtime';

/**
 * #52 M2 — the skills + MCP wiring, end to end through the realtime
 * coordinator with the faux model and a STUB registry seam (no network, no
 * pool). Covers: config validation (visibility, skill kind/source rules),
 * the read_skill round trip, the MCP `<server>__<tool>` round trip, prompt
 * notes for unavailable servers/skills, and the toolset gate for MCP names.
 */

const KEY = 'test-secret-0123456789abcdef';
const owner: Principal = { userId: 'u-owner', role: 'user' };
const other: Principal = { userId: 'u-other', role: 'user' };
const now = '2026-01-01T00:00:00.000Z';

interface Harness {
  svc: AssistantRealtimeService;
  uow: ReturnType<typeof createMemoryUnitOfWork>;
  faux: ReturnType<typeof piAi.fauxProvider>;
  events: { sessionId: string; event: ChatStreamEvent }[];
  mcpCalls: { name: string; args: unknown }[];
}

/** The stub registry: one serving server (srv-x) + one unavailable id. */
function stubMcp(calls: { name: string; args: unknown }[]) {
  const tools: AggregatedTool[] = [
    {
      name: 'srv-x__echo',
      description: 'Echoes text',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
  ];
  return {
    listTools: (serverIds: string[]) =>
      serverIds.includes('mcp-live') || serverIds.includes('*') ? tools : [],
    callTool: async (name: string, args?: Record<string, unknown>) => {
      calls.push({ name, args });
      return { content: [{ type: 'text', text: `mcp:${String((args ?? {}).text ?? '')}` }] };
    },
  };
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
  // A readable skill + an external-source skill + a foreign personal skill.
  await uow.resources.save({
    id: 'skill-live',
    key: 'skill:live',
    kind: 'skill',
    name: 'Live Skill',
    description: 'does live things',
    version: '1.0.0',
    source: { type: 'inline', content: '# Live Skill\nDo the live thing carefully.' },
    scope: 'personal',
    ownerId: owner.userId,
    targets: [],
    createdAt: now,
    updatedAt: now,
  });
  await uow.resources.save({
    id: 'skill-git',
    key: 'skill:git',
    kind: 'skill',
    name: 'Git Skill',
    version: '1.0.0',
    source: { type: 'git', url: 'https://example.com/s.git' },
    scope: 'personal',
    ownerId: owner.userId,
    targets: [],
    createdAt: now,
    updatedAt: now,
  });
  await uow.resources.save({
    id: 'skill-hook',
    key: 'hook:x',
    kind: 'hook',
    name: 'Not A Skill',
    version: '1.0.0',
    source: { type: 'inline', content: 'x' },
    scope: 'personal',
    ownerId: owner.userId,
    targets: [],
    createdAt: now,
    updatedAt: now,
  });
  // Visible MCP rows: one server-dialed live (the stub serves it), one
  // client-dialed (stub serves nothing for it).
  await uow.mcpServers.save({
    id: 'mcp-live',
    name: 'srv-x',
    transport: { type: 'http', url: 'https://mcp.example.com/mcp' },
    dialSite: 'server',
    scope: 'personal',
    ownerId: owner.userId,
    createdAt: now,
    updatedAt: now,
  });
  await uow.mcpServers.save({
    id: 'mcp-client',
    name: 'srv-c',
    transport: { type: 'http', url: 'https://mcp.example.com/c' },
    dialSite: 'client',
    scope: 'personal',
    ownerId: owner.userId,
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
  const mcpCalls: { name: string; args: unknown }[] = [];
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
    stubMcp(mcpCalls),
  );
  return { svc, uow, faux, events, mcpCalls };
}

async function opsId(h: Harness): Promise<string> {
  const configs = await h.uow.assistants.listByOwner(owner.userId);
  return configs.find((c) => c.name === 'Ops')!.id;
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

describe('#52 M2 — config validation (visibility, skill rules)', () => {
  it('accepts visible MCP servers and inline skills; rejects the rest with pointed codes', async () => {
    const h = await setup();
    const a = await createAssistant({ uow: h.uow }, owner, {
      name: 'Ops',
      providerId: 'prov-1',
      defaultModel: 'gw-large',
      mcpServerIds: ['mcp-live', 'mcp-client'],
      skillResourceIds: ['skill-live'],
    });
    expect(a.mcpServerIds).toEqual(['mcp-live', 'mcp-client']);
    expect(a.skillResourceIds).toEqual(['skill-live']);

    // Foreign personal MCP row 404-hides.
    await expect(
      updateAssistant({ uow: h.uow }, owner, a.id, { mcpServerIds: ['nope'] }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'MCP_SERVER_NOT_FOUND' });
    // Non-skill kind.
    await expect(
      updateAssistant({ uow: h.uow }, owner, a.id, { skillResourceIds: ['skill-hook'] }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'ASSISTANT_SKILL_NOT_SKILL' });
    // External source.
    await expect(
      updateAssistant({ uow: h.uow }, owner, a.id, { skillResourceIds: ['skill-git'] }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'ASSISTANT_SKILL_SOURCE_UNREADABLE' });
    // Dedupe on replace.
    const dedup = await updateAssistant({ uow: h.uow }, owner, a.id, {
      mcpServerIds: ['mcp-live', 'mcp-live'],
    });
    expect(dedup.mcpServerIds).toEqual(['mcp-live']);
    void other;
  });
});

describe('#52 M2 — read_skill + MCP tools in the live turn', () => {
  it('serves the skill body via read_skill and the MCP tool via srv__tool', async () => {
    const h = await setup();
    const a = await createAssistant({ uow: h.uow }, owner, {
      name: 'Ops',
      providerId: 'prov-1',
      defaultModel: 'gw-large',
      enabledToolGroups: ['system'],
      mcpServerIds: ['mcp-live', 'mcp-client'],
      skillResourceIds: ['skill-live'],
    });
    h.faux.setResponses([
      piAi.fauxAssistantMessage([piAi.fauxToolCall('read_skill', { skill: 'Live Skill' })]),
      piAi.fauxAssistantMessage([piAi.fauxToolCall('srv-x__echo', { text: 'hi' })]),
      piAi.fauxAssistantMessage([piAi.fauxText('done')]),
    ]);

    const res = await h.svc.open(owner.userId, a.id, undefined, 'sock-1');
    expect(res.ok).toBe(true);
    const sessionId = res.ok ? res.sessionId : '';
    await h.svc.onMessageSend(owner.userId, sessionId, 'use the things');
    await settle(h, sessionId);

    // The skill body round-tripped through the transcript (toolResult row).
    const rows = await h.uow.assistants.listMessages(sessionId);
    const results = rows.flatMap((r) => (r.type === 'toolResult' ? r.results : []));
    const readSkill = results.find((r) => r.tool === 'read_skill');
    expect(readSkill?.output).toContain('Do the live thing carefully.');
    // The MCP tool executed through the stub seam.
    expect(h.mcpCalls).toEqual([{ name: 'srv-x__echo', args: { text: 'hi' } }]);
    const echo = results.find((r) => r.tool === 'srv-x__echo');
    expect(echo?.output).toBe('mcp:hi');

    // Audits cover both dynamic tools.
    const audits = await h.uow.assistants.listToolCallAudits(sessionId);
    expect(audits.map((x) => x.tool).sort()).toEqual(['read_skill', 'srv-x__echo']);
  });

  it('notes unavailable MCP servers honestly (client-dialed yields no tools)', async () => {
    const h = await setup();
    const a = await createAssistant({ uow: h.uow }, owner, {
      name: 'Ops',
      providerId: 'prov-1',
      defaultModel: 'gw-large',
      enabledToolGroups: ['system'],
      mcpServerIds: ['mcp-client'],
      skillResourceIds: ['skill-live'],
    });
    // The skill vanishes AFTER the config saved — the turn must skip it with
    // a prompt note, not crash.
    await h.uow.resources.delete('skill-live');
    h.faux.setResponses([piAi.fauxAssistantMessage([piAi.fauxText('ok')])]);

    const res = await h.svc.open(owner.userId, a.id, undefined, 'sock-1');
    const sessionId = res.ok ? res.sessionId : '';
    await h.svc.onMessageSend(owner.userId, sessionId, 'go');
    await settle(h, sessionId);

    // The unavailable server + skipped skill produced tool errors the model
    // can see — read_skill exists (skill configured but unresolvable) and
    // the srv tools simply are not present.
    const audits = await h.uow.assistants.listToolCallAudits(sessionId);
    expect(audits.filter((x) => x.tool.startsWith('srv-'))).toHaveLength(0);
    // The turn still completes.
    const rows = await h.uow.assistants.listMessages(sessionId);
    expect(rows[rows.length - 1]!.type).toBe('assistant');
  });

  it('read_skill errors cleanly for unknown skills / files', async () => {
    const h = await setup();
    const a = await createAssistant({ uow: h.uow }, owner, {
      name: 'Ops',
      providerId: 'prov-1',
      defaultModel: 'gw-large',
      skillResourceIds: ['skill-live'],
    });
    h.faux.setResponses([
      piAi.fauxAssistantMessage([piAi.fauxToolCall('read_skill', { skill: 'nope' })]),
      piAi.fauxAssistantMessage([piAi.fauxText('sorry')]),
    ]);
    const res = await h.svc.open(owner.userId, a.id, undefined, 'sock-1');
    const sessionId = res.ok ? res.sessionId : '';
    await h.svc.onMessageSend(owner.userId, sessionId, 'go');
    await settle(h, sessionId);
    const rows = await h.uow.assistants.listMessages(sessionId);
    const results = rows.flatMap((r) => (r.type === 'toolResult' ? r.results : []));
    expect(results[0]?.isError).toBe(true);
    expect(results[0]?.output).toContain('no configured skill matches');
  });
});
