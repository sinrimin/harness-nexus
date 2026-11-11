// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import * as piAi from '@earendil-works/pi-ai';
import type { AssistantMessage, ToolCall } from '@earendil-works/pi-ai';
import { chatStreamEventSchema } from '@harness-nexus/shared';
import type { ChatStreamEvent } from '@harness-nexus/shared';
import type { AssistantMessageRow } from '@harness-nexus/core';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import { encryptSecret } from '../src/infra/crypto.js';
import { createAssistant } from '../src/services/assistant.js';
import type { Principal } from '../src/services/principal.js';
import { AssistantRealtimeService, type AssistantIO } from '../src/realtime/assistant.js';
import { SessionUsageAccumulator } from '../src/assistant/usage.js';

/**
 * #128 — the assistant session HUD's server half: the channel accumulator
 * (reported-vs-missing honesty, row seeding), the per-response `session_usage`
 * emits (never into the reconnect ring), the ready-push snapshot on
 * open/rejoin, and the exclusion of the title refine's bypass model call.
 *
 * The harness scripts usage through a hand-built streamFn (the buildModel
 * seam): the faux provider would OVERWRITE a scripted message's usage with
 * its own estimates, and the estimates are not what these assertions read.
 */

const KEY = 'test-secret-0123456789abcdef';
const owner: Principal = { userId: 'u-owner', role: 'user' };
const now = '2026-01-01T00:00:00.000Z';

interface UsageScript {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** A scripted response step: builds its message against the model it is asked for. */
type Step = (model: piAi.Model<string>) => AssistantMessage;

function withUsage(
  model: piAi.Model<string>,
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'],
  u: UsageScript,
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: u.input,
      output: u.output,
      cacheRead: u.cacheRead ?? 0,
      cacheWrite: u.cacheWrite ?? 0,
      totalTokens: u.input + u.output + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

const textReply =
  (text: string, u: UsageScript): Step =>
  (model) =>
    withUsage(model, [{ type: 'text', text }], 'stop', u);

const toolReply =
  (name: string, args: unknown, u: UsageScript): Step =>
  (model) =>
    withUsage(model, [piAi.fauxToolCall(name, args) as ToolCall], 'toolUse', u);

/** A queue-backed streamFn: one AssistantMessage per call, verbatim usage. */
function scriptedStream(steps: Step[]) {
  const queue = [...steps];
  return ((model: piAi.Model<string>) => {
    const stream = piAi.createAssistantMessageEventStream();
    const step = queue.shift();
    queueMicrotask(() => {
      if (step === undefined) {
        const error = withUsage(model, [], 'error', { input: 0, output: 0 });
        error.errorMessage = 'no more scripted responses';
        stream.push({ type: 'error', reason: 'error', error });
        stream.end(error);
        return;
      }
      const message = step(model);
      stream.push({ type: 'start', partial: message });
      stream.push({
        type: 'done',
        reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop',
        message,
      });
      stream.end(message);
    });
    return stream;
  }) as unknown as ReturnType<typeof piAi.createModels>['streamSimple'];
}

interface IoCall {
  event: string;
  payload: {
    sessionId?: string;
    assistantId?: string;
    assistantName?: string;
    sessionUsage?: { turns: number; inputTokens?: number; outputTokens?: number };
    event?: ChatStreamEvent;
  };
}

async function setup(
  opts: { titleRefine?: boolean; script?: Step[]; providerModels?: { id: string; contextWindow?: number }[] } = {},
) {
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
    apis: [{ kind: 'openai-chat', path: null }],
    baseUrl: 'https://gw.example.com/v1',
    credentialName: 'gw-key',
    scope: 'personal',
    ownerId: owner.userId,
    models: (opts.providerModels ?? [{ id: 'gw-large' }]).map((m) => ({
      id: m.id,
      apiKind: 'openai-chat',
      ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
    })),
    createdAt: now,
    updatedAt: now,
  });

  const faux = piAi.fauxProvider({
    models: [{ id: 'gw-large', name: 'Gateway Large', contextWindow: 64_000 }],
  });

  const calls: IoCall[] = [];
  const io: AssistantIO = {
    toChannel: (sid, event, payload) =>
      calls.push({ event, payload: payload as IoCall['payload'] }),
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
      titleRefine: opts.titleRefine ?? false,
      buildModel: async () => ({
        model: faux.getModel('gw-large') as never,
        streamFn: scriptedStream(opts.script ?? []) as never,
      }),
    },
    io,
  );
  const configId = await createAssistant({ uow }, owner, {
    name: 'Ops',
    providerId: 'prov-1',
    defaultModel: 'gw-large',
    enabledToolGroups: ['resources'],
    // autoWrite: the tool round-trip test must not park on a permission card.
    permissionMode: 'autoWrite',
  }).then((a) => a.id);
  return { svc, uow, faux, calls, configId };
}

async function settle(uow: ReturnType<typeof createMemoryUnitOfWork>, sessionId: string) {
  for (let i = 0; i < 500; i += 1) {
    const rows = await uow.assistants.listMessages(sessionId);
    const last = rows[rows.length - 1];
    if (rows.length > 0 && last?.type === 'assistant') return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('turn did not settle');
}

const sessionUsageEvents = (calls: IoCall[]) =>
  calls
    .filter((c) => c.event === 'assistant:event' && c.payload.event?.kind === 'session_usage')
    .map((c) => c.payload.event as Extract<ChatStreamEvent, { kind: 'session_usage' }>);

const readyPushes = (calls: IoCall[], sessionId: string) =>
  calls.filter((c) => c.event === 'assistant:session.ready' && c.payload.sessionId === sessionId);

const usageEvents = (calls: IoCall[]) =>
  calls
    .map((c) => c.payload.event)
    .filter((e): e is Extract<ChatStreamEvent, { kind: 'usage' }> => e?.kind === 'usage');

describe('SessionUsageAccumulator', () => {
  it('treats missing as unknown and 0 as a report for input/output', () => {
    const acc = new SessionUsageAccumulator();
    expect(acc.snapshot()).toBeNull();
    acc.record({ inputTokens: 0 });
    // A reported 0 IS known — it rides the snapshot (never rendered as fake).
    expect(acc.snapshot()).toEqual({ turns: 0, inputTokens: 0 });
  });

  it('reports a field only when its source did (mixed reports)', () => {
    const acc = new SessionUsageAccumulator();
    acc.record({ inputTokens: 5 });
    expect(acc.snapshot()).toEqual({ turns: 0, inputTokens: 5 });
    acc.record({ outputTokens: 7, cacheReadTokens: 40 });
    expect(acc.snapshot()).toEqual({
      turns: 0,
      inputTokens: 5,
      outputTokens: 7,
      cacheReadTokens: 40,
    });
  });

  it('treats a 0 CACHE field as unknown (pi-ai normalizes missing cache to 0)', () => {
    const acc = new SessionUsageAccumulator();
    acc.record({ inputTokens: 10, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(acc.snapshot()).toEqual({ turns: 0, inputTokens: 10, outputTokens: 3 });
  });

  it('sums repeated responses and counts user turns', () => {
    const acc = new SessionUsageAccumulator();
    acc.countTurn();
    acc.record({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 500, cacheWriteTokens: 50 });
    acc.countTurn();
    acc.record({ inputTokens: 30, outputTokens: 5, cacheReadTokens: 60 });
    expect(acc.snapshot()).toEqual({
      turns: 2,
      inputTokens: 130,
      outputTokens: 25,
      cacheReadTokens: 560,
      cacheWriteTokens: 50,
    });
  });

  it('seeds from persisted rows: user rows are turns, assistant usage is summed, cache stays unknown', () => {
    const rows: AssistantMessageRow[] = [
      { seq: 1, type: 'user', blocks: [{ type: 'text', text: 'hi' }] },
      {
        seq: 2,
        type: 'assistant',
        text: 'a',
        thought: '',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 100, outputTokens: 20 },
      },
      { seq: 3, type: 'toolResult', results: [] },
      { seq: 4, type: 'note', text: 'note' },
      { seq: 5, type: 'user', blocks: [{ type: 'text', text: 'again' }] },
      {
        seq: 6,
        type: 'assistant',
        text: 'b',
        thought: '',
        toolCalls: [],
        stopReason: 'end_turn',
        usage: { inputTokens: 30, outputTokens: 0 },
      },
    ];
    const acc = SessionUsageAccumulator.fromRows(rows);
    expect(acc.snapshot()).toEqual({
      turns: 2,
      inputTokens: 130,
      outputTokens: 20,
    });
  });
});

describe('#128 — assistant session usage telemetry', () => {
  it('emits session_usage after every model response of the turn loop (tool round-trips included)', async () => {
    const h = await setup({
      script: [
        // A tool round-trip: the first response asks for a (real) write tool,
        // the loop continues, the second settles the turn.
        toolReply(
          'resources_create',
          {
            resource: {
              key: 'skill:usage',
              kind: 'skill',
              name: 'usage',
              source: { type: 'inline', content: 'x' },
              scope: 'personal',
            },
          },
          { input: 100, output: 20, cacheRead: 500, cacheWrite: 50 },
        ),
        textReply('final', { input: 40, output: 8, cacheRead: 60 }),
      ],
    });
    const res = await h.svc.open(owner.userId, h.configId, undefined, 'sock-1');
    expect(res.ok).toBe(true);
    const sessionId = res.ok ? res.sessionId : '';
    await h.svc.onMessageSend(owner.userId, sessionId, 'do things');
    await settle(h.uow, sessionId);

    const events = sessionUsageEvents(h.calls);
    // One snapshot per counted response, both cumulative over the turn.
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      kind: 'session_usage',
      turns: 1,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 500,
      cacheWriteTokens: 50,
    });
    expect(events[1]).toEqual({
      kind: 'session_usage',
      turns: 1,
      inputTokens: 140,
      outputTokens: 28,
      cacheReadTokens: 560,
      cacheWriteTokens: 50,
    });

    // The turn's raw usage event carries the cache fields (additive wire).
    const usage = h.calls
      .map((c) => c.payload.event)
      .find((e) => e?.kind === 'usage' && e.inputTokens === 100);
    expect(usage).toMatchObject({
      kind: 'usage',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 500,
      cacheWriteTokens: 50,
    });

    // Derived state never rides the reconnect ring: a resync replays the
    // ring WITHOUT session_usage, and its ready push restores the totals.
    h.calls.length = 0;
    expect(await h.svc.resync(owner.userId, sessionId, 'sock-1')).toBe(true);
    expect(sessionUsageEvents(h.calls)).toHaveLength(0);
    const ready = readyPushes(h.calls, sessionId);
    expect(ready).toHaveLength(1);
    expect(ready[0]!.payload.sessionUsage).toEqual({
      turns: 1,
      inputTokens: 140,
      outputTokens: 28,
      cacheReadTokens: 560,
      cacheWriteTokens: 50,
    });
  });

  it('re-seeds a fresh channel from the persisted rows on reopen (cache honestly unknown)', async () => {
    const h = await setup({
      script: [textReply('answer', { input: 100, output: 20, cacheRead: 500, cacheWrite: 50 })],
    });
    const res = await h.svc.open(owner.userId, h.configId, undefined, 'sock-1');
    const sessionId = res.ok ? res.sessionId : '';
    await h.svc.onMessageSend(owner.userId, sessionId, 'hello');
    await settle(h.uow, sessionId);
    await h.svc.close(owner.userId, sessionId, 'user');

    // The channel is gone; a fresh open seeds from the rows (which persist
    // input/output only — the cache totals are channel-lifetime).
    const reopened = await h.svc.open(owner.userId, h.configId, sessionId, 'sock-2');
    expect(reopened.ok).toBe(true);
    const ready = readyPushes(h.calls, sessionId);
    expect(ready[ready.length - 1]!.payload.sessionUsage).toEqual({
      turns: 1,
      inputTokens: 100,
      outputTokens: 20,
    });
  });

  it('excludes the background title refine: only the turn loop is counted', async () => {
    // The refine and the turn ride the SAME buildModel seam and race for the
    // scripted queue, so both replies carry IDENTICAL usage: whichever each
    // call consumes, the totals must describe ONE response — a leak would
    // double them (200/40/1000).
    const h = await setup({
      titleRefine: true,
      script: [
        textReply('Short Title', { input: 100, output: 20, cacheRead: 500 }),
        textReply('the real answer', { input: 100, output: 20, cacheRead: 500 }),
      ],
    });
    const res = await h.svc.open(owner.userId, h.configId, undefined, 'sock-1');
    const sessionId = res.ok ? res.sessionId : '';
    await h.svc.onMessageSend(owner.userId, sessionId, 'name this conversation');
    await settle(h.uow, sessionId);

    // The refine RAN (its side effect: the stored title left the fallback).
    let titled = false;
    for (let i = 0; i < 500; i += 1) {
      const row = await h.uow.assistants.findSessionById(sessionId);
      if (row !== null && row.title !== 'name this conversation' && row.title !== '') {
        titled = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(titled).toBe(true);

    const events = sessionUsageEvents(h.calls);
    expect(events.length).toBeGreaterThan(0);
    const last = events[events.length - 1]!;
    expect(last).toEqual({
      kind: 'session_usage',
      turns: 1,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 500,
    });
  });

  it('keeps the wire additive: cache-bearing usage and session_usage both validate, old shapes still do', () => {
    expect(
      chatStreamEventSchema.parse({
        kind: 'usage',
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 500,
        cacheWriteTokens: 50,
      }),
    ).toMatchObject({ kind: 'usage', cacheReadTokens: 500 });
    // The pre-#128 shape (no cache fields) is still a valid event — old
    // emitters and stripped payloads must keep parsing.
    expect(chatStreamEventSchema.parse({ kind: 'usage', inputTokens: 1, outputTokens: 2 })).toEqual(
      { kind: 'usage', inputTokens: 1, outputTokens: 2 },
    );
    expect(
      chatStreamEventSchema.parse({
        kind: 'session_usage',
        turns: 1,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 500,
        cacheWriteTokens: 50,
      }),
    ).toMatchObject({ kind: 'session_usage', turns: 1 });
    expect(chatStreamEventSchema.parse({ kind: 'session_usage', turns: 0 })).toEqual({
      kind: 'session_usage',
      turns: 0,
    });
  });

  it('CTX — usage events carry a derived window reading when the registry has a contextWindow', async () => {
    const h = await setup({
      providerModels: [{ id: 'gw-large', contextWindow: 64_000 }],
      script: [textReply('ok', { input: 200, output: 40, cacheRead: 1000, cacheWrite: 50 })],
    });
    const res = await h.svc.open(owner.userId, h.configId, undefined, 'sock-1');
    expect(res.ok).toBe(true);
    const sessionId = res.ok ? res.sessionId : '';
    await h.svc.onMessageSend(owner.userId, sessionId, 'hello');
    await settle(h.uow, sessionId);
    // The request the model just answered (input + cache read/written —
    // pi-ai normalizes input to EXCLUDE the cached parts) plus the response
    // it produced: 200+1000+50+40 = the context as it now stands.
    expect(usageEvents(h.calls)[0]).toMatchObject({
      kind: 'usage',
      contextUsed: 1290,
      contextSize: 64_000,
    });
  });

  it('CTX — a registry entry without a contextWindow keeps the fields absent (honest blank)', async () => {
    const h = await setup({ script: [textReply('ok', { input: 10, output: 2 })] });
    const res = await h.svc.open(owner.userId, h.configId, undefined, 'sock-1');
    expect(res.ok).toBe(true);
    const sessionId = res.ok ? res.sessionId : '';
    await h.svc.onMessageSend(owner.userId, sessionId, 'hello');
    await settle(h.uow, sessionId);
    const usage = usageEvents(h.calls)[0]!;
    expect(usage.inputTokens).toBe(10);
    expect('contextUsed' in usage).toBe(false);
    expect('contextSize' in usage).toBe(false);
  });

  it('CTX — a mid-session model pick re-resolves the window from the registry', async () => {
    const h = await setup({
      providerModels: [{ id: 'gw-large' }, { id: 'gw-mini', contextWindow: 8_000 }],
      // One step: buildModel builds a FRESH scripted queue per turn, so both
      // turns see this same response — the numbers under test are the CTX
      // fields, and the model pick is what must change between them.
      script: [textReply('same', { input: 20, output: 3 })],
    });
    const res = await h.svc.open(owner.userId, h.configId, undefined, 'sock-1');
    expect(res.ok).toBe(true);
    const sessionId = res.ok ? res.sessionId : '';
    await h.svc.onMessageSend(owner.userId, sessionId, 'first');
    await settle(h.uow, sessionId);
    // gw-large carries no window: the first turn's usage has no CTX fields.
    expect('contextUsed' in usageEvents(h.calls).at(-1)!).toBe(false);

    const picked = await h.svc.onConfigSet(owner.userId, sessionId, {
      configId: 'model',
      value: 'prov-1/gw-mini',
    });
    expect(picked.ok).toBe(true);
    h.calls.length = 0;
    await h.svc.onMessageSend(owner.userId, sessionId, 'second');
    // settle() keys on "last row is assistant", which turn 1 already left
    // behind — wait for the new turn's usage event itself.
    for (let i = 0; i < 500 && usageEvents(h.calls).length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    await settle(h.uow, sessionId);
    expect(usageEvents(h.calls).at(-1)).toMatchObject({
      kind: 'usage',
      contextUsed: 23,
      contextSize: 8_000,
    });
  });
});
