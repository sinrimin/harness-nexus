// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * Issue #97 — the delegated-decision audit trail: one row per gate verdict
 * (model rows carry the raw severity/intent/why, floor rows stay lean),
 * the humanResponse backfill on escalated cards, owner-only listing, the
 * on-write per-owner prune, and the sqlite driver round-trip. The decision
 * model is a fake SystemOne fetch; nothing touches the network.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import { createSqliteUnitOfWork } from '../src/infra/storage/sqlite/index.js';
import { encryptSecret } from '../src/infra/crypto.js';
import { ChatService, type ChatIO } from '../src/realtime/chat.js';
import { listDecisionRecords } from '../src/services/decision-records.js';
import { DECISION_RECORDS_CAP, type DecisionRecord, type UnitOfWork } from '@harness-nexus/core';

const NOW = new Date().toISOString();
const KEY = 'k'.repeat(32);

type FetchImpl = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** The v2 answer triple (mirrors the gate's wire shape). */
function answers(opts: {
  severity: number;
  intent: number;
  why?: string;
}): Record<string, unknown> {
  return {
    severity: { score: opts.severity, confidence: 0.95 },
    intent: { noul: opts.intent, confidence: 0.9 },
    why: { choice: opts.why ?? 'fine', confidence: 0.9 },
  };
}

async function setup(opts: {
  target: string;
  answers?: Record<string, unknown>;
  neverAllow?: string[];
  permissionTimeoutMs?: number;
}): Promise<{
  svc: ChatService;
  uow: UnitOfWork;
  sessionId: string;
}> {
  const uow = createMemoryUnitOfWork();
  await uow.users.save({
    id: 'u97',
    email: 'u97@x',
    passwordHash: null,
    role: 'user',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await uow.machines.save({
    id: 'm97',
    ownerId: 'u97',
    name: 'audit-box',
    hostname: null,
    os: null,
    arch: null,
    daemonVersion: null,
    capabilities: ['chat'],
    remoteChatEnabled: true,
    baseWorkspace: '/w',
    chatApprovals: {
      responder: 'delegated',
      providerId: 'p97',
      modelId: 'decision-model-preview',
      confidenceThreshold: 0.6,
      neverAllow: opts.neverAllow ?? [],
      denyNote: true,
    },
    enrollmentPatId: 'pat97',
    enrolledAt: NOW,
    lastSeenAt: null,
  });
  await uow.agentInstances.save({
    id: 'a97',
    machineId: 'm97',
    ownerId: 'u97',
    target: opts.target,
    profileId: 'p',
    profileVersion: '1',
    name: 'audit agent',
    directory: '/w',
    jobId: null,
    source: 'deploy',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await uow.llmProviders.save({
    id: 'p97',
    name: 'bailian-decision',
    apis: [{ kind: 'systemone', path: null }],
    baseUrl: 'https://dashscope.example.com/compatible-mode/v1',
    credentialName: 'cred97',
    scope: 'personal',
    ownerId: 'u97',
    models: [{ id: 'decision-model-preview', apiKind: 'systemone' }],
    createdAt: NOW,
    updatedAt: NOW,
  });
  await uow.credentials.save({
    id: 'c97',
    ownerId: 'u97',
    name: 'cred97',
    secret: encryptSecret('sk-test', KEY),
    scope: 'personal',
    distributable: true,
    createdAt: NOW,
    updatedAt: NOW,
  });

  const io: ChatIO = {
    toCtl: () => undefined,
    toChannel: () => undefined,
    toUser: () => undefined,
    joinChannel: () => undefined,
    isAppSocketLive: () => true,
    userSockets: async () => ['sock-1'],
  };
  const fetchImpl: FetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body) as { state: { toolCall: { title?: string } } };
    // The never-allow floor card still gets "asked" — the floor answers
    // BEFORE the call, so any request proves the model path ran.
    void body;
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ answers: opts.answers ?? answers({ severity: 1.5, intent: 0.9 }) }),
    };
  };
  const svc = new ChatService(
    {
      uow,
      isOnline: () => true,
      io,
      approvals: { credentialEncryptionKey: KEY, timeoutMs: 1_000, fetchImpl },
    },
    {
      maxSessionsPerMachine: 4,
      maxActiveSessionsPerMachine: 2,
      permissionTimeoutMs: opts.permissionTimeoutMs ?? 60_000,
      readyTimeoutMs: 5_000,
      idleTtlMs: 0,
      viewerGraceMs: 0,
    },
  );
  const opened = await svc.open('u97', 'a97', undefined, 'sock-1', undefined, undefined);
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw new Error('open failed');
  await svc.onReady('m97', { sessionId: opened.sessionId });
  return { svc, uow, sessionId: opened.sessionId };
}

const OPTIONS = [
  { optionId: 'yes-once', name: 'Yes', kind: 'allow_once' },
  { optionId: 'no-once', name: 'No', kind: 'reject_once' },
];

/** Fire one permission card and drain the gate's microtasks. */
async function fire(
  svc: ChatService,
  sessionId: string,
  requestId: string,
  toolCall: Record<string, unknown>,
): Promise<void> {
  await svc.onStream('m97', sessionId, {
    kind: 'permission_request',
    requestId,
    toolCall: toolCall as never,
    options: OPTIONS,
  });
  await new Promise((r) => setTimeout(r, 20));
}

async function rows(uow: UnitOfWork): Promise<DecisionRecord[]> {
  return uow.decisionRecords.list({ ownerId: 'u97' });
}

describe('decision records (#97) — rows land per verdict', () => {
  it('a model allow carries the raw verdict + provenance; the input preview is the bounded view', async () => {
    const t = await setup({ target: 'claude-code' });
    await fire(t.svc, t.sessionId, 'r-allow', {
      toolCallId: 'tc1',
      title: 'Bash(rm -rf /tmp/x)',
      rawInput: { command: 'rm -rf /tmp/x' },
    });
    const all = await rows(t.uow);
    expect(all).toHaveLength(1);
    const row = all[0]!;
    expect(row.outcome).toBe('allow');
    expect(row.decidedBy).toBe('model');
    expect(row.axis).toBe('chat');
    expect(row.machineId).toBe('m97');
    expect(row.sessionId).toBe(t.sessionId);
    expect(row.requestId).toBe('r-allow');
    expect(row.target).toBe('claude-code');
    expect(row.toolTitle).toBe('Bash(rm -rf /tmp/x)');
    expect(row.toolInputPreview).toContain('rm -rf /tmp/x');
    expect(row.severity).toBe(1.5);
    expect(row.intent).toBe(0.9);
    expect(row.sevConfidence).toBe(0.95);
    expect(row.intentConfidence).toBe(0.9);
    expect(row.providerName).toBe('bailian-decision');
    expect(row.modelId).toBe('decision-model-preview');
    expect(row.latencyMs).toBeDefined();
    expect(row.humanResponse).toBeUndefined();
  });

  it('a never-allow floor denial lands a lean row (policy reason, no model fields)', async () => {
    const t = await setup({ target: 'claude-code', neverAllow: ['rm -rf'] });
    await fire(t.svc, t.sessionId, 'r-floor', {
      toolCallId: 'tc2',
      title: 'Bash(rm -rf /)',
      rawInput: { command: 'rm -rf /' },
    });
    const row = (await rows(t.uow))[0]!;
    expect(row.outcome).toBe('deny');
    expect(row.decidedBy).toBe('floor');
    expect(row.denialReason).toBe('policy');
    expect(row.severity).toBeUndefined();
    expect(row.providerName).toBeUndefined();
    expect(row.latencyMs).toBeUndefined();
  });

  it('an advisory escalation records outcome escalate, and the human answer backfills', async () => {
    // Mid band with a low intent → advisory (the card stays with the human).
    const t = await setup({
      target: 'codex',
      answers: answers({ severity: 4.2, intent: 0.2, why: 'not_covered' }),
    });
    await fire(t.svc, t.sessionId, 'r-esc', {
      toolCallId: 'tc3',
      title: 'Bash(curl example.com)',
      rawInput: { command: 'curl example.com' },
    });
    const row = (await rows(t.uow))[0]!;
    expect(row.outcome).toBe('escalate');
    expect(row.decidedBy).toBe('model');
    expect(row.severity).toBe(4.2);
    expect(row.intent).toBe(0.2);
    expect(row.why).toBe('not_covered');
    expect(row.humanResponse).toBeUndefined();

    const res = t.svc.onPermissionRespond('u97', t.sessionId, 'r-esc', 'yes-once');
    expect(res.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    const backfilled = (await rows(t.uow))[0]!;
    expect(backfilled.humanResponse).toBe('allow');
  });

  it('a reject option backfills as reject', async () => {
    const t = await setup({ target: 'codex', answers: answers({ severity: 4.2, intent: 0.2 }) });
    await fire(t.svc, t.sessionId, 'r-rej', {
      toolCallId: 'tc4',
      title: 'Bash(curl x.io)',
      rawInput: { command: 'curl x.io' },
    });
    t.svc.onPermissionRespond('u97', t.sessionId, 'r-rej', 'no-once');
    await new Promise((r) => setTimeout(r, 20));
    expect((await rows(t.uow))[0]!.humanResponse).toBe('reject');
  });

  it('the permission watchdog backfills timeout', async () => {
    const t = await setup({
      target: 'codex',
      answers: answers({ severity: 4.2, intent: 0.2 }),
      permissionTimeoutMs: 15,
    });
    await fire(t.svc, t.sessionId, 'r-tmo', {
      toolCallId: 'tc5',
      title: 'Bash(curl y.io)',
      rawInput: { command: 'curl y.io' },
    });
    await new Promise((r) => setTimeout(r, 60));
    expect((await rows(t.uow))[0]!.humanResponse).toBe('timeout');
  });
});

describe('decision records (#97) — listing', () => {
  it('is owner-scoped (the principal IS the filter) and newest-first', async () => {
    const uow = createMemoryUnitOfWork();
    for (const id of ['u-a', 'u-b']) {
      await uow.users.save({
        id,
        email: `${id}@x`,
        passwordHash: null,
        role: 'user',
        status: 'active',
        createdAt: NOW,
        updatedAt: NOW,
      });
    }
    const mk = (owner: string, n: number): DecisionRecord => ({
      id: `row-${owner}-${n}`,
      ownerId: owner,
      createdAt: new Date(Date.parse('2026-01-01T00:00:00Z') + n * 1000).toISOString(),
      axis: 'assistant',
      toolTitle: `t${n}`,
      outcome: 'allow',
      decidedBy: 'model',
    });
    await uow.decisionRecords.append(mk('u-a', 1));
    await uow.decisionRecords.append(mk('u-b', 2));
    await uow.decisionRecords.append(mk('u-a', 3));

    const aRows = await listDecisionRecords(
      { uow },
      { userId: 'u-a', role: 'user' },
      { limit: 50 },
    );
    expect(aRows.map((r) => r.id)).toEqual(['row-u-a-3', 'row-u-a-1']);
    const bRows = await listDecisionRecords(
      { uow },
      { userId: 'u-b', role: 'admin' },
      { limit: 50 },
    );
    expect(bRows.map((r) => r.id)).toEqual(['row-u-b-2']); // admin widens nothing
  });

  it('append prunes to the per-owner cap on write (a busy OTHER owner is untouched)', async () => {
    const uow = createMemoryUnitOfWork();
    for (const id of ['u-a', 'u-b']) {
      await uow.users.save({
        id,
        email: `${id}@x`,
        passwordHash: null,
        role: 'user',
        status: 'active',
        createdAt: NOW,
        updatedAt: NOW,
      });
    }
    const mk = (owner: string, n: number): DecisionRecord => ({
      id: `row-${owner}-${n}`,
      ownerId: owner,
      createdAt: new Date(Date.parse('2026-01-01T00:00:00Z') + n).toISOString(),
      axis: 'chat',
      toolTitle: 't',
      outcome: 'allow',
      decidedBy: 'floor',
    });
    for (let i = 0; i < DECISION_RECORDS_CAP + 5; i++)
      await uow.decisionRecords.append(mk('u-a', i));
    await uow.decisionRecords.append(mk('u-b', 0));

    const aRows = await uow.decisionRecords.list({
      ownerId: 'u-a',
      limit: DECISION_RECORDS_CAP + 10,
    });
    expect(aRows).toHaveLength(DECISION_RECORDS_CAP);
    expect(aRows[0]!.id).toBe(`row-u-a-${DECISION_RECORDS_CAP + 4}`); // newest kept
    expect(aRows.at(-1)!.id).toBe('row-u-a-5'); // the 5 oldest pruned
    expect(await uow.decisionRecords.list({ ownerId: 'u-b' })).toHaveLength(1);
  });
});

describe('decision records (#97) — sqlite driver', () => {
  it('round-trips rows, filters, and backfills first-answer-wins', async () => {
    const uow = createSqliteUnitOfWork(':memory:');
    await uow.users.save({
      id: 'u-s',
      username: 'u-s',
      email: 'u-s@x',
      passwordHash: null,
      role: 'user',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });
    const base = {
      ownerId: 'u-s',
      axis: 'chat' as const,
      machineId: 'm1',
      sessionId: 's1',
      requestId: 'q1',
      target: 'claude-code',
      toolTitle: 'Bash(ls)',
      toolKind: 'Bash',
      toolInputPreview: '{"command":"ls"}',
      outcome: 'escalate' as const,
      decidedBy: 'model' as const,
      severity: 4.5,
      intent: 0.3,
      why: 'not_covered' as const,
      sevConfidence: 0.95,
      intentConfidence: 0.9,
      providerName: 'prov',
      modelId: 'm',
      latencyMs: 812,
    };
    await uow.decisionRecords.append({ id: 'd1', createdAt: '2026-01-01T00:00:01.000Z', ...base });
    await uow.decisionRecords.append({
      id: 'd2',
      createdAt: '2026-01-01T00:00:02.000Z',
      ...base,
      requestId: 'q2',
      outcome: 'allow',
      decidedBy: 'floor',
      severity: undefined,
      intent: undefined,
      why: undefined,
      sevConfidence: undefined,
      intentConfidence: undefined,
      providerName: undefined,
      modelId: undefined,
      latencyMs: undefined,
    });

    const all = await uow.decisionRecords.list({ ownerId: 'u-s' });
    expect(all.map((r) => r.id)).toEqual(['d2', 'd1']); // newest-first
    expect(all[1]!.severity).toBe(4.5);

    const escalateOnly = await uow.decisionRecords.list({ ownerId: 'u-s', outcome: 'escalate' });
    expect(escalateOnly.map((r) => r.id)).toEqual(['d1']);

    expect(await uow.decisionRecords.markHumanResponse('u-s', 's1', 'q1', 'reject')).toBe(true);
    // First answer wins — a later watchdog cannot rewrite the pair.
    expect(await uow.decisionRecords.markHumanResponse('u-s', 's1', 'q1', 'timeout')).toBe(false);
    expect(
      (await uow.decisionRecords.list({ ownerId: 'u-s', outcome: 'escalate' }))[0]!.humanResponse,
    ).toBe('reject');
  });
});
