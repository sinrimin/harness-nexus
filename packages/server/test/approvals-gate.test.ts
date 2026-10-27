// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * Issue #92 — the delegated-approvals gate: floor-before-model, `*_once`
 * eligibility, per-target reason channels (claude denies WITH a message,
 * everyone else escalates a model deny), the advisory line, race arbitration
 * against the human card, and fail-closed on provider failures. The decision
 * model is a fake SystemOne fetch; nothing here touches the network.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import { encryptSecret } from '../src/infra/crypto.js';
import { ChatService, type ChatIO } from '../src/realtime/chat.js';
import type { UnitOfWork } from '@harness-nexus/core';

const NOW = new Date().toISOString();
const KEY = 'k'.repeat(32);

interface CtlCall {
  machineId: string;
  event: string;
  payload: Record<string, unknown>;
}
interface ChannelCall {
  sessionId: string;
  event: string;
  payload: Record<string, unknown>;
}
interface FetchLog {
  url: string;
  body: {
    model: string;
    state: { userPrompts: string[]; toolCall: { title: string }; options: unknown[] };
    questions: { pick: { criteria: Record<string, string> } };
  };
}

type FetchImpl = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** The fake SystemOne — per-test answers, captured requests. */
function fakeSystemOne(answers: Record<string, unknown>, log: FetchLog[]): FetchImpl {
  return async (url, init) => {
    log.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify({ answers }) };
  };
}

async function setup(opts: {
  target: string;
  neverAllow?: string[];
  denyNote?: boolean;
  answers?: Record<string, unknown>;
  baseUrl?: string;
}): Promise<{
  svc: ChatService;
  uow: UnitOfWork;
  ctl: CtlCall[];
  channel: ChannelCall[];
  fetchLog: FetchLog[];
  sessionId: string;
}> {
  const uow = createMemoryUnitOfWork();
  await uow.users.save({
    id: 'u92',
    email: 'u92@x',
    passwordHash: null,
    role: 'user',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await uow.machines.save({
    id: 'm92',
    ownerId: 'u92',
    name: 'gate-box',
    hostname: null,
    os: null,
    arch: null,
    daemonVersion: null,
    capabilities: ['chat'],
    remoteChatEnabled: true,
    baseWorkspace: '/w',
    chatApprovals: {
      responder: 'delegated',
      providerId: 'p92',
      modelId: 'decision-model-preview',
      confidenceThreshold: 0.9,
      neverAllow: opts.neverAllow ?? [],
      denyNote: opts.denyNote ?? true,
    },
    enrollmentPatId: 'pat92',
    enrolledAt: NOW,
    lastSeenAt: null,
  });
  await uow.agentInstances.save({
    id: 'a92',
    machineId: 'm92',
    ownerId: 'u92',
    target: opts.target,
    profileId: 'p',
    profileVersion: '1',
    name: 'gate agent',
    directory: '/w',
    jobId: null,
    source: 'deploy',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await uow.llmProviders.save({
    id: 'p92',
    name: 'bailian-decision',
    api: 'systemone',
    baseUrl: opts.baseUrl ?? 'https://dashscope.example.com/compatible-mode/v1',
    credentialName: 'cred92',
    scope: 'personal',
    ownerId: 'u92',
    models: [{ id: 'decision-model-preview', type: 'decision' }],
    createdAt: NOW,
    updatedAt: NOW,
  });
  await uow.credentials.save({
    id: 'c92',
    ownerId: 'u92',
    name: 'cred92',
    secret: encryptSecret('sk-test', KEY),
    scope: 'personal',
    distributable: true,
    createdAt: NOW,
    updatedAt: NOW,
  });

  const ctl: CtlCall[] = [];
  const channel: ChannelCall[] = [];
  const fetchLog: FetchLog[] = [];
  const io: ChatIO = {
    toCtl: (machineId, event, payload) => ctl.push({ machineId, event, payload }),
    toChannel: (sessionId, event, payload) => channel.push({ sessionId, event, payload }),
    toUser: () => undefined,
    joinChannel: () => undefined,
    isAppSocketLive: () => true,
    userSockets: async () => ['sock-1'],
  };
  const svc = new ChatService(
    {
      uow,
      isOnline: () => true,
      io,
      approvals: {
        credentialEncryptionKey: KEY,
        timeoutMs: 1_000,
        fetchImpl: fakeSystemOne(
          opts.answers ?? {
            pick: { choice: 'yes-once', confidence: 0.97 },
            covered: { noul: 0.96 },
            why: { choice: 'fine' },
          },
          fetchLog,
        ),
      },
    },
    {
      maxSessionsPerMachine: 4,
      maxActiveSessionsPerMachine: 2,
      permissionTimeoutMs: 60_000,
      readyTimeoutMs: 5_000,
      idleTtlMs: 0,
      viewerGraceMs: 0,
    },
  );
  const opened = await svc.open('u92', 'a92', undefined, 'sock-1', undefined, undefined);
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw new Error('open failed');
  await svc.onReady('m92', { sessionId: opened.sessionId });
  return { svc, uow, ctl, channel, fetchLog, sessionId: opened.sessionId };
}

const TOOL = { toolCallId: 'tc1', title: 'Bash(rm -rf /tmp/x)' };
const OPTIONS = [
  { optionId: 'yes-once', name: 'Yes', kind: 'allow_once' },
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'no-once', name: 'No', kind: 'reject_once' },
];

function ctlResponds(ctl: CtlCall[], sessionId: string): CtlCall[] {
  return ctl.filter(
    (c) => c.event === 'chat:permission.respond' && c.payload.sessionId === sessionId,
  );
}

function channelEvents(channel: ChannelCall[], kind: string): Record<string, unknown>[] {
  return channel
    .filter((c) => c.event === 'chat:event')
    .map((c) => (c.payload as { event: Record<string, unknown> }).event)
    .filter((e) => e.kind === kind);
}

/** The gate runs beside the card; let its microtasks drain. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

describe('delegated approvals gate (#92)', () => {
  it('allows a covered, confident call; the question carries only *_once options', async () => {
    const t = await setup({ target: 'claude-code' });
    await t.svc.onStream('m92', t.sessionId, {
      kind: 'permission_request',
      requestId: 'r1',
      toolCall: TOOL,
      options: OPTIONS,
    });
    await settle();
    const responds = ctlResponds(t.ctl, t.sessionId);
    expect(responds).toHaveLength(1);
    expect(responds[0]!.payload.optionId).toBe('yes-once');
    expect(responds[0]!.payload.meta).toBeUndefined(); // allows carry no message
    const resolved = channelEvents(t.channel, 'permission_resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.responder).toBe('delegated');
    expect(resolved[0]!.decidedBy).toBe('model');
    expect((resolved[0]!.delegated as { providerName: string }).providerName).toBe(
      'bailian-decision',
    );
    expect(t.fetchLog).toHaveLength(1);
    expect(t.fetchLog[0]!.url).toBe('https://dashscope.example.com/compatible-mode/v1/systemone');
    expect(Object.keys(t.fetchLog[0]!.body.questions.pick.criteria)).toEqual([
      'yes-once',
      'no-once',
    ]);
    expect(t.fetchLog[0]!.body.model).toBe('decision-model-preview');
  });

  it('the floor denies BEFORE the model, with a deny message on claude', async () => {
    const t = await setup({ target: 'claude-code', neverAllow: ['rm -rf'] });
    await t.svc.onStream('m92', t.sessionId, {
      kind: 'permission_request',
      requestId: 'r2',
      toolCall: TOOL,
      options: OPTIONS,
    });
    await settle();
    expect(t.fetchLog).toHaveLength(0); // never consulted
    const responds = ctlResponds(t.ctl, t.sessionId);
    expect(responds).toHaveLength(1);
    expect(responds[0]!.payload.optionId).toBe('no-once');
    expect((responds[0]!.payload.meta as { denyMessage: string }).denyMessage).toContain(
      '[delegated approvals]',
    );
    const resolved = channelEvents(t.channel, 'permission_resolved');
    expect(resolved[0]!.decidedBy).toBe('floor');
    expect((resolved[0]!.delegated as { denial: { reason: string } }).denial.reason).toBe('policy');
  });

  it('a floor deny on a no-channel target parks the correction note instead', async () => {
    const t = await setup({ target: 'hermes', neverAllow: ['rm -rf'] });
    await t.svc.onStream('m92', t.sessionId, {
      kind: 'permission_request',
      requestId: 'r3',
      toolCall: TOOL,
      options: OPTIONS,
    });
    await settle();
    const responds = ctlResponds(t.ctl, t.sessionId);
    expect(responds).toHaveLength(1);
    expect(responds[0]!.payload.meta).toBeUndefined(); // no reason channel on hermes
    const queued = channelEvents(t.channel, 'queue_state');
    expect(queued).toHaveLength(1);
    const note = (queued[0]!.prompt as { type: string; text: string }[])[0]!.text.toString();
    expect(note).toContain('[delegated approvals]');
    expect(note).toContain('NOT a manual user denial');
  });

  it('a confident model REJECT denies on claude with the reason wired through', async () => {
    const t = await setup({
      target: 'claude-code',
      answers: {
        pick: { choice: 'no-once', confidence: 0.95 },
        covered: { noul: 0.2 },
        why: { choice: 'destructive' },
      },
    });
    await t.svc.onStream('m92', t.sessionId, {
      kind: 'permission_request',
      requestId: 'r4',
      toolCall: TOOL,
      options: OPTIONS,
    });
    await settle();
    const responds = ctlResponds(t.ctl, t.sessionId);
    expect(responds).toHaveLength(1);
    expect(responds[0]!.payload.optionId).toBe('no-once');
    expect((responds[0]!.payload.meta as { denyMessage: string }).denyMessage).toContain(
      'destructive',
    );
    const resolved = channelEvents(t.channel, 'permission_resolved');
    expect((resolved[0]!.delegated as { denial: { reason: string } }).denial.reason).toBe(
      'destructive',
    );
    // A claude deny rides the REAL channel — no queue note.
    expect(channelEvents(t.channel, 'queue_state')).toHaveLength(0);
  });

  it('a model reject on a NO-CHANNEL target escalates: advisory, never an answer', async () => {
    const t = await setup({
      target: 'opencode',
      answers: {
        pick: { choice: 'no-once', confidence: 0.95 },
        covered: { noul: 0.2 },
        why: { choice: 'destructive' },
      },
    });
    await t.svc.onStream('m92', t.sessionId, {
      kind: 'permission_request',
      requestId: 'r5',
      toolCall: TOOL,
      options: OPTIONS,
    });
    await settle();
    expect(ctlResponds(t.ctl, t.sessionId)).toHaveLength(0); // unanswered — the human card stays
    const advisory = channelEvents(t.channel, 'permission_advisory');
    expect(advisory).toHaveLength(1);
    expect(advisory[0]!.lean).toBe('reject');
    expect(advisory[0]!.reason).toBe('destructive');
    expect(channelEvents(t.channel, 'queue_state')).toHaveLength(0);
  });

  it('low coverage escalates even when the pick leans allow', async () => {
    const t = await setup({
      target: 'claude-code',
      answers: {
        pick: { choice: 'yes-once', confidence: 0.97 },
        covered: { noul: 0.1 },
        why: { choice: 'fine' },
      },
    });
    await t.svc.onStream('m92', t.sessionId, {
      kind: 'permission_request',
      requestId: 'r6',
      toolCall: TOOL,
      options: OPTIONS,
    });
    await settle();
    expect(ctlResponds(t.ctl, t.sessionId)).toHaveLength(0);
    const advisory = channelEvents(t.channel, 'permission_advisory');
    expect(advisory).toHaveLength(1);
    expect(advisory[0]!.lean).toBe('allow');
  });

  it('the human wins the race: a later gate verdict is dropped', async () => {
    const t = await setup({ target: 'claude-code' });
    await t.svc.onStream('m92', t.sessionId, {
      kind: 'permission_request',
      requestId: 'r7',
      toolCall: TOOL,
      options: OPTIONS,
    });
    // Human answers BEFORE the gate settles.
    const human = await t.svc.onPermissionRespond('u92', t.sessionId, 'r7', 'no-once');
    expect(human.ok).toBe(true);
    await settle();
    const responds = ctlResponds(t.ctl, t.sessionId);
    expect(responds).toHaveLength(1); // the human's — the gate's was dropped
    expect(responds[0]!.payload.optionId).toBe('no-once');
    expect(responds[0]!.payload.attribution).toBeUndefined();
  });

  it('a provider failure fail-closes to the human card (no answer, no advisory)', async () => {
    // An http:// base is refused by the outbound wrapper before any fetch —
    // the same path every other provider error takes.
    const t = await setup({ target: 'claude-code', baseUrl: 'http://insecure.example.com/v1' });
    await t.svc.onStream('m92', t.sessionId, {
      kind: 'permission_request',
      requestId: 'r8',
      toolCall: TOOL,
      options: OPTIONS,
    });
    await settle();
    expect(ctlResponds(t.ctl, t.sessionId)).toHaveLength(0);
    expect(t.fetchLog).toHaveLength(0);
    expect(channelEvents(t.channel, 'permission_advisory')).toHaveLength(0);
  });

  it('setApprovals refuses delegated without a configured provider; switches emit to ctl', async () => {
    const t = await setup({ target: 'claude-code' });
    expect(await t.svc.setApprovals('u92', t.sessionId, 'manual')).toEqual({ ok: true });
    const setEvents = t.ctl.filter((c) => c.event === 'chat:approvals.set');
    expect(setEvents).toHaveLength(1);
    expect(
      (setEvents[0]!.payload as { approvals: { responder: string } }).approvals.responder,
    ).toBe('manual');
    // Back to delegated — the config still exists, so it re-resolves.
    expect(await t.svc.setApprovals('u92', t.sessionId, 'delegated')).toEqual({ ok: true });
    // Strip the machine config: delegated now refuses honestly.
    const machine = await t.uow.machines.findById('m92');
    await t.uow.machines.save({ ...machine!, chatApprovals: undefined });
    expect(await t.svc.setApprovals('u92', t.sessionId, 'delegated')).toEqual({
      ok: false,
      code: 'CHAT_APPROVALS_NO_PROVIDER',
    });
  });
});
