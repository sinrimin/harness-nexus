// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * Issue #92 — the delegated-approvals gate: floor-before-model, the metadata
 * pre-filter, `*_once` eligibility, the v2 severity × intent verdict matrix,
 * per-target reason channels (claude denies WITH a message, everyone else
 * escalates a deny-shaped verdict), the advisory line with its verdict
 * inputs, race arbitration against the human card, the prompt window's
 * head/tail cut, and fail-closed on provider failures or flat answers. The
 * decision model is a fake SystemOne fetch; nothing here touches the network.
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
    state: {
      userPrompts: string[];
      toolCall: { title: string; input?: string };
      options: unknown[];
    };
    questions: {
      severity: { type: string; criteria: string[] };
      intent: { type: string };
      why: { criteria: Record<string, string> };
    };
  };
}

type FetchImpl = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

/** The v2 answer triple — severity score, intent noul, why choice. */
function answers(opts: {
  severity: number;
  intent: number;
  sevConfidence?: number;
  /** `null` = the wire's noul answers that carry NO confidence at all. */
  intentConfidence?: number | null;
  why?: string;
}): Record<string, unknown> {
  return {
    severity: { score: opts.severity, confidence: opts.sevConfidence ?? 0.95 },
    intent: { noul: opts.intent, confidence: opts.intentConfidence ?? 0.9 },
    why: { choice: opts.why ?? 'fine', confidence: 0.9 },
  };
}

/** The fake SystemOne — per-test answers, captured requests. */
function fakeSystemOne(answer: Record<string, unknown>, log: FetchLog[]): FetchImpl {
  return async (url, init) => {
    log.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify({ answers: answer }) };
  };
}

async function setup(opts: {
  target: string;
  neverAllow?: string[];
  denyNote?: boolean;
  answers?: Record<string, unknown>;
  baseUrl?: string;
  /** #95 — machine carries NO override pair; the user default decides. */
  followDefault?: boolean;
  /** #95 — machine carries NO chatApprovals at all. */
  noMachineConfig?: boolean;
  /** #95 — the machine row's responder default (harness defaults delegated). */
  responder?: 'manual' | 'delegated';
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
    ...(opts.followDefault
      ? { defaultModels: { decision: { providerId: 'p92', modelId: 'decision-model-preview' } } }
      : {}),
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
    ...(opts.noMachineConfig
      ? {}
      : {
          chatApprovals: {
            responder: (opts.responder ?? 'delegated') as 'manual' | 'delegated',
            ...(opts.followDefault ? {} : { providerId: 'p92', modelId: 'decision-model-preview' }),
            confidenceThreshold: 0.6,
            neverAllow: opts.neverAllow ?? [],
            denyNote: opts.denyNote ?? true,
          },
        }),
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
    apis: [{ kind: 'systemone', path: null }],
    baseUrl: opts.baseUrl ?? 'https://dashscope.example.com/compatible-mode/v1',
    credentialName: 'cred92',
    scope: 'personal',
    ownerId: 'u92',
    models: [{ id: 'decision-model-preview', apiKind: 'systemone' }],
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
        fetchImpl: fakeSystemOne(opts.answers ?? answers({ severity: 1.5, intent: 0.9 }), fetchLog),
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

const TOOL = {
  toolCallId: 'tc1',
  title: 'Bash(rm -rf /tmp/x)',
  rawInput: { command: 'rm -rf /tmp/x' },
};
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

/** Fire one permission card and drain the gate's microtasks. */
async function fire(t: { svc: ChatService; sessionId: string }): Promise<void> {
  await t.svc.onStream('m92', t.sessionId, {
    kind: 'permission_request',
    requestId: `r-${Math.random().toString(36).slice(2, 8)}`,
    toolCall: TOOL,
    options: OPTIONS,
  });
  await settle();
}

function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 20));
}

describe('delegated approvals gate (#92) — v2 verdict matrix', () => {
  it('allows a routine call; the call carries the v2 question set and only *_once options', async () => {
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
    // The v2 questions: severity (7-level score) × intent (noul) × why.
    expect(Object.keys(t.fetchLog[0]!.body.questions)).toEqual(['severity', 'intent', 'why']);
    expect(t.fetchLog[0]!.body.questions.severity.type).toBe('score');
    expect(t.fetchLog[0]!.body.questions.severity.criteria).toHaveLength(7);
    expect(t.fetchLog[0]!.body.questions.intent.type).toBe('noul');
    expect(Object.keys(t.fetchLog[0]!.body.questions.why.criteria)).toContain('fine');
    expect(t.fetchLog[0]!.body.model).toBe('decision-model-preview');
    // #92 amendment — the arguments travel with the tool view (the severity
    // and intent questions judge the actual call; the ds-web trial scored
    // 0.16 with the query invisible).
    expect(t.fetchLog[0]!.body.state.toolCall.input).toBe('{"command":"rm -rf /tmp/x"}');
  });

  it('severity 1–2 allows WITHOUT consulting intent (a flat intent must not re-block the trivial tier)', async () => {
    const t = await setup({
      target: 'claude-code',
      answers: answers({ severity: 2.4, intent: 0.05, intentConfidence: 0.1 }),
    });
    await fire(t);
    expect(ctlResponds(t.ctl, t.sessionId)).toHaveLength(1);
    expect(ctlResponds(t.ctl, t.sessionId)[0]!.payload.optionId).toBe('yes-once');
    expect(channelEvents(t.channel, 'permission_advisory')).toHaveLength(0);
  });

  it.each([
    { severity: 3.2, intent: 0.85, expected: 'allow' },
    { severity: 5.7, intent: 0.95, expected: 'allow' },
    { severity: 3.2, intent: 0.4, expected: 'escalate' },
    { severity: 5.7, intent: 0.1, expected: 'escalate' },
  ])('mid band $severity × intent $intent → $expected', async ({ severity, intent, expected }) => {
    const t = await setup({ target: 'claude-code', answers: answers({ severity, intent }) });
    await fire(t);
    if (expected === 'allow') {
      expect(ctlResponds(t.ctl, t.sessionId)).toHaveLength(1);
      expect(ctlResponds(t.ctl, t.sessionId)[0]!.payload.optionId).toBe('yes-once');
    } else {
      expect(ctlResponds(t.ctl, t.sessionId)).toHaveLength(0); // card stays with the human
      const advisory = channelEvents(t.channel, 'permission_advisory');
      expect(advisory).toHaveLength(1);
      expect(advisory[0]!.lean).toBe('reject');
      // v2 — the verdict inputs ride along as context.
      expect(advisory[0]!.severity).toBe(severity);
      expect(advisory[0]!.intent).toBe(intent);
    }
  });

  it('severity 7 denies on claude with the why reason wired through', async () => {
    const t = await setup({
      target: 'claude-code',
      answers: answers({ severity: 6.8, intent: 0.98, why: 'sensitive' }),
    });
    await fire(t);
    const responds = ctlResponds(t.ctl, t.sessionId);
    expect(responds).toHaveLength(1);
    expect(responds[0]!.payload.optionId).toBe('no-once');
    expect((responds[0]!.payload.meta as { denyMessage: string }).denyMessage).toContain(
      'sensitive',
    );
    const resolved = channelEvents(t.channel, 'permission_resolved');
    expect((resolved[0]!.delegated as { denial: { reason: string } }).denial.reason).toBe(
      'sensitive',
    );
    // A claude deny rides the REAL channel — no queue note.
    expect(channelEvents(t.channel, 'queue_state')).toHaveLength(0);
  });

  it('severity 7 on a NO-CHANNEL target is an advisory, never an unexplained stop', async () => {
    const t = await setup({
      target: 'opencode',
      answers: answers({ severity: 6.8, intent: 0.98, why: 'sensitive' }),
    });
    await fire(t);
    expect(ctlResponds(t.ctl, t.sessionId)).toHaveLength(0);
    const advisory = channelEvents(t.channel, 'permission_advisory');
    expect(advisory).toHaveLength(1);
    expect(advisory[0]!.lean).toBe('reject');
    expect(advisory[0]!.reason).toBe('sensitive');
    expect(advisory[0]!.severity).toBe(6.8);
  });

  it('a flat severity answer fail-closes to the human (advisory, never a decision)', async () => {
    const t = await setup({
      target: 'claude-code',
      answers: answers({ severity: 1.2, intent: 0.9, sevConfidence: 0.3 }),
    });
    await fire(t);
    expect(ctlResponds(t.ctl, t.sessionId)).toHaveLength(0);
    const advisory = channelEvents(t.channel, 'permission_advisory');
    expect(advisory).toHaveLength(1);
    expect(advisory[0]!.lean).toBe('allow'); // the lean survives; the DECISION does not
    expect(advisory[0]!.confidence).toBe(0.3);
  });

  it('a mid-band intent WITHOUT a confidence field still allows (the wire omits noul confidence)', async () => {
    // Calibration finding: Bailian decision-model-preview never attaches
    // confidence to noul answers — absent must not read as "flat" (that
    // would brick every mid-band allow on SystemOne-compatible providers).
    const t = await setup({
      target: 'claude-code',
      answers: answers({ severity: 4.2, intent: 0.91, intentConfidence: null }),
    });
    await fire(t);
    const responds = ctlResponds(t.ctl, t.sessionId);
    expect(responds).toHaveLength(1);
    expect(responds[0]!.payload.optionId).toBe('yes-once');
  });

  it('a flat INTENT answer fail-closes only in the mid band (not in the routine tier)', async () => {
    const mid = await setup({
      target: 'claude-code',
      answers: answers({ severity: 4.0, intent: 0.95, intentConfidence: 0.2 }),
    });
    await fire(mid);
    expect(ctlResponds(mid.ctl, mid.sessionId)).toHaveLength(0);
    expect(channelEvents(mid.channel, 'permission_advisory')).toHaveLength(1);
  });
});

describe('delegated approvals gate (#92) — pre-filter and floor', () => {
  it('the metadata pre-filter allows a verb-pinned git read with NO model call', async () => {
    const t = await setup({ target: 'claude-code' });
    await t.svc.onStream('m92', t.sessionId, {
      kind: 'permission_request',
      requestId: 'r-pf',
      toolCall: {
        toolCallId: 'tc-pf',
        title: 'Bash(git status)',
        kind: 'execute',
        rawInput: { command: 'git status' },
      },
      options: OPTIONS,
    });
    await settle();
    expect(t.fetchLog).toHaveLength(0); // the model was never consulted
    const responds = ctlResponds(t.ctl, t.sessionId);
    expect(responds).toHaveLength(1);
    expect(responds[0]!.payload.optionId).toBe('yes-once');
    const resolved = channelEvents(t.channel, 'permission_resolved');
    expect(resolved[0]!.decidedBy).toBe('floor'); // the deterministic layer
  });

  it('an in-workspace Read pre-filters through with NO model call', async () => {
    const t = await setup({ target: 'claude-code' });
    await t.svc.onStream('m92', t.sessionId, {
      kind: 'permission_request',
      requestId: 'r-pf2',
      toolCall: {
        toolCallId: 'tc-pf2',
        title: 'Read',
        kind: 'read',
        rawInput: { file_path: '/w/src/a.ts' },
      },
      options: OPTIONS,
    });
    await settle();
    expect(t.fetchLog).toHaveLength(0);
    expect(ctlResponds(t.ctl, t.sessionId)[0]!.payload.optionId).toBe('yes-once');
  });

  it('a credential-shaped Read still sees the model (grade 6, not the pre-filter)', async () => {
    const t = await setup({
      target: 'claude-code',
      answers: answers({ severity: 6.1, intent: 0.2, why: 'sensitive' }),
    });
    await t.svc.onStream('m92', t.sessionId, {
      kind: 'permission_request',
      requestId: 'r-pf3',
      toolCall: {
        toolCallId: 'tc-pf3',
        title: 'Read',
        kind: 'read',
        rawInput: { file_path: '/w/.env' },
      },
      options: OPTIONS,
    });
    await settle();
    expect(t.fetchLog).toHaveLength(1); // the model judged it
    expect(ctlResponds(t.ctl, t.sessionId)).toHaveLength(0); // mid band, low intent ⇒ human
    expect(channelEvents(t.channel, 'permission_advisory')[0]!.reason).toBe('sensitive');
  });

  it('the never-allow floor also matches a pattern that only lives in the arguments', async () => {
    const t = await setup({
      target: 'claude-code',
      neverAllow: ['grid.purge'],
      answers: answers({ severity: 1.5, intent: 0.99 }),
    });
    await t.svc.onStream('m92', t.sessionId, {
      kind: 'permission_request',
      requestId: 'r1',
      toolCall: { toolCallId: 'tc1', title: 'Run job', rawInput: { target: 'grid.purge --all' } },
      options: OPTIONS,
    });
    await settle();
    expect(t.fetchLog).toHaveLength(0); // the floor fired BEFORE the model
    const resolved = channelEvents(t.channel, 'permission_resolved');
    expect(resolved[0]!.decidedBy).toBe('floor');
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
});

describe('delegated approvals gate (#92) — context window', () => {
  it('the state carries the last 8 prompts, each head ¾ + tail ¼ cut', async () => {
    const t = await setup({ target: 'claude-code' });
    for (let i = 1; i <= 10; i += 1) {
      expect(await t.svc.onMessageSend('u92', t.sessionId, `prompt ${i}`)).toMatchObject({
        ok: true,
      });
    }
    // One long prompt: head marker at the start, supplement at the tail.
    const big =
      'HEADMARK ' + 'x'.repeat(3_000) + ' middletext '.repeat(100) + ' TAILMARK-supplement';
    expect(await t.svc.onMessageSend('u92', t.sessionId, big)).toMatchObject({ ok: true });
    await t.svc.onStream('m92', t.sessionId, {
      kind: 'permission_request',
      requestId: 'r-win',
      toolCall: TOOL,
      options: OPTIONS,
    });
    await settle();
    expect(t.fetchLog).toHaveLength(1);
    const prompts = t.fetchLog[0]!.body.state.userPrompts;
    expect(prompts).toHaveLength(8); // 10 + 1 sent; window keeps the last 8
    expect(prompts[0]).toBe('prompt 4');
    const clipped = prompts[7]!;
    expect(clipped.startsWith('HEADMARK')).toBe(true); // the head survived
    expect(clipped.includes('…[cut]…')).toBe(true); // the middle dropped, marked
    expect(clipped.endsWith('TAILMARK-supplement')).toBe(true); // the tail survived
    expect(clipped.length).toBeLessThanOrEqual(600 + ' …[cut]… '.length);
  });
});

describe('delegated approvals gate (#92) — resolution and provider #95 paths', () => {
  it('#95 — follows the USER default decision model when the machine sets no override', async () => {
    const t = await setup({ target: 'claude-code', followDefault: true });
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
    expect(t.fetchLog[0]!.body.model).toBe('decision-model-preview');
    const resolved = channelEvents(t.channel, 'permission_resolved');
    expect((resolved[0]!.delegated as { providerName: string }).providerName).toBe(
      'bailian-decision',
    );
  });

  it('#95 — a MANUAL machine with a user default ADVERTISES the switch (responder manual + provenance)', async () => {
    const t = await setup({ target: 'claude-code', followDefault: true, responder: 'manual' });
    const start = t.ctl.find((c) => c.event === 'chat:session.start');
    expect(start).toBeDefined();
    const approvals = (start!.payload as { approvals?: Record<string, unknown> }).approvals;
    // advertised while MANUAL — the sender's switch renders from this view
    expect(approvals).toMatchObject({
      responder: 'manual',
      modelId: 'decision-model-preview',
      providerName: 'bailian-decision',
    });
    // and flipping it on live still works
    expect(await t.svc.setApprovals('u92', t.sessionId, 'delegated')).toEqual({ ok: true });
    // the SERVER pushes the slice itself (old daemons never synthesize it)
    const cfgEvents = channelEvents(t.channel, 'session_config').filter(
      (e) => e.approvals !== undefined,
    );
    expect(cfgEvents.length).toBeGreaterThanOrEqual(2); // ready push + flip push
    expect(cfgEvents.at(-1)!.approvals).toMatchObject({
      responder: 'delegated',
      modelId: 'decision-model-preview',
    });
  });

  it('#95 — with NOTHING resolvable the view is STILL advertised (manual, no model) so the switch stays discoverable', async () => {
    const t = await setup({ target: 'claude-code', followDefault: true, responder: 'manual' });
    await t.uow.users.save({
      id: 'u92',
      email: 'u92@x',
      passwordHash: null,
      role: 'user',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    }); // clears the user default the harness seeded
    const reopened = await t.svc.open('u92', 'a92', undefined, 'sock-2', undefined, undefined);
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) throw new Error('open failed');
    await t.svc.onReady('m92', { sessionId: reopened.sessionId });
    const starts = t.ctl.filter((c) => c.event === 'chat:session.start');
    const last = starts.at(-1)!;
    // The sender renders the control from this view; the web disables the
    // switch and points at the provider defaults because modelId is absent.
    expect((last.payload as { approvals?: unknown }).approvals).toEqual({ responder: 'manual' });
    const cfgEvents = channelEvents(t.channel, 'session_config').filter(
      (e) => e.approvals !== undefined,
    );
    expect(cfgEvents.at(-1)!.approvals).toEqual({ responder: 'manual' });
    expect(
      await t.svc.setApprovals('u92', (reopened as { sessionId: string }).sessionId, 'delegated'),
    ).toEqual({
      ok: false,
      code: 'CHAT_APPROVALS_NO_PROVIDER',
    });
  });

  it('#95 — setApprovals offers delegated via the user default even with NO machine config', async () => {
    const t = await setup({ target: 'claude-code', followDefault: true, noMachineConfig: true });
    // default responder is manual (delegation is opt-in)…
    expect(await t.svc.setApprovals('u92', t.sessionId, 'delegated')).toEqual({ ok: true });
    const set = t.ctl.filter((c) => c.event === 'chat:approvals.set');
    expect(set).toHaveLength(1);
    expect((set[0]!.payload as { approvals: { modelId: string } }).approvals.modelId).toBe(
      'decision-model-preview',
    );
    // …and once the user default no longer resolves, delegated is refused again.
    await t.uow.users.save({
      id: 'u92',
      email: 'u92@x',
      passwordHash: null,
      role: 'user',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });
    await t.svc.setApprovals('u92', t.sessionId, 'manual');
    expect(await t.svc.setApprovals('u92', t.sessionId, 'delegated')).toEqual({
      ok: false,
      code: 'CHAT_APPROVALS_NO_PROVIDER',
    });
  });

  it('options without an allow_once (persistent-only allows) escalate silently', async () => {
    const t = await setup({ target: 'claude-code' });
    await t.svc.onStream('m92', t.sessionId, {
      kind: 'permission_request',
      requestId: 'r-persist',
      toolCall: TOOL,
      options: [
        { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'no-once', name: 'No', kind: 'reject_once' },
      ],
    });
    await settle();
    expect(ctlResponds(t.ctl, t.sessionId)).toHaveLength(0); // nothing we may answer
    expect(t.fetchLog).toHaveLength(0); // and the model is never consulted
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
