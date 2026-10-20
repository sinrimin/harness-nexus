// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { emitAck, once, testConfig, waitFor } from './helpers.js';

/**
 * #67 — the assistant's client-agent dispatch, end to end against a fake
 * daemon: dispatch opens an in-process channel (no browser socket), the
 * prompt goes out on the ready tap through the ordinary send door, the tap
 * buffers the turn, and the poll settles done/closed/failed with the
 * continuation handle (nativeSessionId + cwd). The driven channel is a
 * NORMAL channel: budgets, gates, tab-bar visibility all unchanged.
 */

let app: FastifyInstance;
let baseUrl: string;
let jwt: string;
let userId: string;
let machineId: string;
let machineToken: string;
const agentId = 'agent-dispatch-1';
let daemon: Socket | null = null;

const authed = (token: string): { authorization: string } => ({ authorization: `Bearer ${token}` });

const connectDaemon = async (): Promise<Socket> => {
  if (daemon !== null) {
    daemon.disconnect();
    await waitFor(() => !app.realtime.presence.isOnline(machineId));
  }
  const sock = io(`${baseUrl}/ctl`, {
    auth: { token: machineToken, machineId },
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
  });
  sock.on('chat:reconcile', (_p: unknown, ack?: (res: unknown) => void) => ack?.({ held: [] }));
  await once(sock, 'connect');
  await emitAck(sock, 'machine:hello', {
    daemonVersion: '0.14.0-test',
    capabilities: ['chat'],
  });
  daemon = sock;
  return sock;
};

/** Daemon-side fixture turn: ready + a streamed reply + idle. */
const readyWithTurn = (
  d: Socket,
  start: { sessionId: string },
  opts: { nativeSessionId?: string; text?: string; beforeIdle?: () => void } = {},
): void => {
  void d.emit('chat:session.ready', {
    sessionId: start.sessionId,
    agentName: 'fixture-agent',
    agentVersion: '0.1.0',
    ...(opts.nativeSessionId !== undefined ? { nativeSessionId: opts.nativeSessionId } : {}),
  });
  const sendP = once(d, 'chat:message.send');
  void sendP.then(() => {
    void d.emit('chat:event', {
      sessionId: start.sessionId,
      event: { kind: 'session_status', state: 'active' },
    });
    void d.emit('chat:event', {
      sessionId: start.sessionId,
      event: { kind: 'message_delta', delta: opts.text ?? 'fixture reply' },
    });
    void d.emit('chat:event', {
      sessionId: start.sessionId,
      event: { kind: 'usage', inputTokens: 11, outputTokens: 7 },
    });
    void d.emit('chat:event', {
      sessionId: start.sessionId,
      event: { kind: 'turn_result', stopReason: 'end_turn' },
    });
    opts.beforeIdle?.();
    void d.emit('chat:event', {
      sessionId: start.sessionId,
      event: { kind: 'session_status', state: 'idle' },
    });
  });
};

beforeAll(async () => {
  app = await buildApp(testConfig({ chatReadyTimeoutMs: 2500 }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;

  const reg = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'dispatcher', password: 'hunter2hunter2' },
  });
  jwt = reg.json().token;
  userId = (await app.uow.users.findByUsername('dispatcher'))!.id;

  const enroll = await app.inject({
    method: 'POST',
    url: '/api/machines',
    headers: authed(jwt),
    payload: { name: 'dispatch-box' },
  });
  machineId = enroll.json().machine.id;
  machineToken = enroll.json().token;

  const now = new Date().toISOString();
  await app.uow.machines.save({
    ...(await app.uow.machines.findById(machineId))!,
    remoteChatEnabled: true,
    capabilities: ['chat'],
    baseWorkspace: '/tmp/dispatch-ws',
  });
  await app.uow.agentInstances.save({
    id: agentId,
    machineId,
    ownerId: userId,
    target: 'hermes',
    profileId: 'p',
    profileVersion: '1',
    name: 'dispatch agent',
    directory: '/home/tester/.hermes',
    jobId: null,
    createdAt: now,
    updatedAt: now,
  });

  await connectDaemon();
}, 20000);

afterAll(async () => {
  daemon?.disconnect();
  await app.close();
});

describe('#67 assistant dispatch', () => {
  it('dispatch → prompt on ready → turn → done with continuation handle, channel closed', async () => {
    const d = daemon!;
    const startP = once(d, 'chat:session.start');
    const res = await app.realtime.assistantDispatch.dispatch(userId, {
      agentInstanceId: agentId,
      prompt: 'do the thing',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.cwd).toBe('/home/tester/.hermes');
    const start = (await startP) as { sessionId: string; createDirectory?: boolean };
    expect(start.sessionId).toBe(res.channelId);
    // #70 — a dispatch promises a NEW session directory: the daemon creates
    // it when it does not exist yet.
    expect(start.createDirectory).toBe(true);

    const closeP = once(d, 'chat:session.close');
    readyWithTurn(d, start, { nativeSessionId: 'fx-native-1', text: 'all done' });

    const poll = await app.realtime.assistantDispatch.poll(userId, res.channelId, 5000);
    expect(poll).toMatchObject({
      status: 'done',
      text: 'all done',
      stopReason: 'end_turn',
      nativeSessionId: 'fx-native-1',
      cwd: '/home/tester/.hermes',
      usage: { inputTokens: 11, outputTokens: 7 },
      pendingPermission: false,
    });
    const closed = (await closeP) as { sessionId: string; reason: string };
    expect(closed.sessionId).toBe(res.channelId);
    expect(closed.reason).toBe('dispatch');
    // The terminal record stays answerable.
    const again = await app.realtime.assistantDispatch.poll(userId, res.channelId, 0);
    expect(again.ok === true && again.status === 'done').toBe(true);
  }, 15000);

  it('continuation passes the native resume arm through to the daemon', async () => {
    const d = daemon!;
    const startP = once(d, 'chat:session.start');
    const res = await app.realtime.assistantDispatch.dispatch(userId, {
      agentInstanceId: agentId,
      prompt: 'continue it',
      resume: { sessionId: 'fx-native-1', cwd: '/home/tester/.hermes' },
    });
    expect(res.ok).toBe(true);
    const start = (await startP) as { resume?: { sessionId: string; cwd: string }; cwd: string };
    expect(start.resume).toEqual({ sessionId: 'fx-native-1', cwd: '/home/tester/.hermes' });
    readyWithTurn(d, { sessionId: res.ok ? res.channelId : '' }, { text: 'continued' });
    const poll = await app.realtime.assistantDispatch.poll(
      userId,
      res.ok ? res.channelId : '',
      5000,
    );
    expect(poll).toMatchObject({ status: 'done', text: 'continued' });
  }, 15000);

  it('poll waitMs returns running for an unfinished turn, done after it lands', async () => {
    const d = daemon!;
    const startP = once(d, 'chat:session.start');
    const res = await app.realtime.assistantDispatch.dispatch(userId, {
      agentInstanceId: agentId,
      prompt: 'slow turn',
    });
    const start = (await startP) as { sessionId: string };
    void d.emit('chat:session.ready', { sessionId: start.sessionId, agentName: 'fixture-agent' });
    await once(d, 'chat:message.send');
    // Mid-turn, no result yet: a bounded poll waits and reports running.
    void d.emit('chat:event', {
      sessionId: start.sessionId,
      event: { kind: 'session_status', state: 'active' },
    });
    void d.emit('chat:event', {
      sessionId: start.sessionId,
      event: { kind: 'message_delta', delta: 'partial' },
    });
    const running = await app.realtime.assistantDispatch.poll(
      userId,
      res.ok ? res.channelId : '',
      300,
    );
    expect(running).toMatchObject({ status: 'running', busy: true, text: 'partial' });
    // The result settles it — no idle needed.
    void d.emit('chat:event', {
      sessionId: start.sessionId,
      event: { kind: 'turn_result', stopReason: 'end_turn' },
    });
    const done = await app.realtime.assistantDispatch.poll(
      userId,
      res.ok ? res.channelId : '',
      5000,
    );
    expect(done).toMatchObject({ status: 'done', text: 'partial', stopReason: 'end_turn' });
  }, 15000);

  it('a permission card from the driven agent surfaces as pendingPermission', async () => {
    const d = daemon!;
    const startP = once(d, 'chat:session.start');
    const res = await app.realtime.assistantDispatch.dispatch(userId, {
      agentInstanceId: agentId,
      prompt: 'needs approval',
    });
    const start = (await startP) as { sessionId: string };
    void d.emit('chat:session.ready', { sessionId: start.sessionId, agentName: 'fixture-agent' });
    await once(d, 'chat:message.send');
    void d.emit('chat:event', {
      sessionId: start.sessionId,
      event: { kind: 'session_status', state: 'active' },
    });
    void d.emit('chat:event', {
      sessionId: start.sessionId,
      event: {
        kind: 'permission_request',
        requestId: 'perm-dispatch-1',
        toolCall: { toolCallId: 't1', title: 'run fixture tool', kind: 'execute' },
        options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }],
      },
    });
    // Poll until the card is observed (the 400ms test watchdog will resolve
    // it on its own — the assertion must catch the window, not race it).
    let sawPending = false;
    for (let i = 0; i < 20 && !sawPending; i += 1) {
      const poll = await app.realtime.assistantDispatch.poll(
        userId,
        res.ok ? res.channelId : '',
        50,
      );
      if (poll.ok === true && poll.pendingPermission === true) sawPending = true;
    }
    expect(sawPending).toBe(true);
    // Settle the turn so the suite's channel count stays bounded.
    void d.emit('chat:event', {
      sessionId: start.sessionId,
      event: { kind: 'turn_result', stopReason: 'end_turn' },
    });
    const done = await app.realtime.assistantDispatch.poll(
      userId,
      res.ok ? res.channelId : '',
      5000,
    );
    expect(done.ok === true && done.status === 'done').toBe(true);
  }, 15000);

  it('a channel death mid-dispatch reports closed with the reason (no fake done)', async () => {
    const d = daemon!;
    const startP = once(d, 'chat:session.start');
    const res = await app.realtime.assistantDispatch.dispatch(userId, {
      agentInstanceId: agentId,
      prompt: 'will die',
    });
    const start = (await startP) as { sessionId: string };
    void d.emit('chat:session.ready', { sessionId: start.sessionId, agentName: 'fixture-agent' });
    await once(d, 'chat:message.send');
    void d.emit('chat:event', {
      sessionId: start.sessionId,
      event: { kind: 'session_status', state: 'active' },
    });
    // The daemon-side agent exits on its own (crash / user closed the tab).
    void d.emit('chat:session.closed', { sessionId: start.sessionId, reason: 'agent-exited' });
    const poll = await app.realtime.assistantDispatch.poll(
      userId,
      res.ok ? res.channelId : '',
      5000,
    );
    expect(poll).toMatchObject({ status: 'closed', reason: 'agent-exited' });
  }, 15000);

  it('gates refuse honestly: offline machine at dispatch, stranger at poll', async () => {
    // Poll for an unknown/foreign handle hides as DISPATCH_NOT_FOUND.
    const stranger = await app.realtime.assistantDispatch.poll('u-stranger', 'no-such', 0);
    expect(stranger).toEqual({ ok: false, code: 'DISPATCH_NOT_FOUND' });

    const d = daemon!;
    d.disconnect();
    await waitFor(() => !app.realtime.presence.isOnline(machineId));
    const res = await app.realtime.assistantDispatch.dispatch(userId, {
      agentInstanceId: agentId,
      prompt: 'offline attempt',
    });
    expect(res).toEqual({ ok: false, code: 'MACHINE_OFFLINE' });
    await connectDaemon();
  }, 15000);
});

describe('#67 dispatch tool surface', () => {
  it('the agent-dispatch group builds both tools against the dispatch dep, and dispatch is write-gated', async () => {
    const { buildAssistantTools, WRITE_TOOLS } = await import('../src/assistant/tools.js');
    const { createMemoryUnitOfWork } = await import('../src/infra/storage/memory/index.js');
    const uow = createMemoryUnitOfWork();
    const stub = {
      dispatch: async () => ({ ok: false as const, code: 'TEST' }),
      poll: async () => ({ ok: false as const, code: 'DISPATCH_NOT_FOUND' }),
    };
    const tools = buildAssistantTools(
      {
        uow,
        skills: { search: null as never, catalog: null as never, allowlist: [] },
        dispatch: stub as never,
      },
      { userId, role: 'user' },
      ['agent-dispatch'],
    );
    expect(tools.map((t) => t.name).sort()).toEqual(['agent_dispatch', 'agent_dispatch_poll']);
    expect(WRITE_TOOLS.has('agent_dispatch')).toBe(true);
    expect(WRITE_TOOLS.has('agent_dispatch_poll')).toBe(false);
  });
});

describe('#68 dispatch backflow', () => {
  /** A fresh assistant session row per test (note-row assertions stay isolated). */
  const makeAssistantSession = async (id: string): Promise<string> => {
    const now = new Date().toISOString();
    await app.uow.assistants.saveSession({
      id,
      ownerId: userId,
      assistantId: 'cfg-68-test',
      title: 'backflow',
      createdAt: now,
      updatedAt: now,
      lastMessageAt: null,
    });
    return id;
  };

  /** Dispatch + ready + the turn's first delta, WAITED until the server has
   *  marked the channel busy (emissions are async — the caller's next verb
   *  must not race the busy flip: queue-on-busy and the active budget both
   *  branch on it). */
  const dispatchMidTurn = async (
    d: Socket,
    assistantSessionId: string,
    prompt: string,
  ): Promise<string> => {
    const startP = once(d, 'chat:session.start');
    const res = await app.realtime.assistantDispatch.dispatch(userId, {
      agentInstanceId: agentId,
      prompt,
      assistantSessionId,
    });
    if (!res.ok) throw new Error(`dispatch failed: ${res.code}`);
    const start = (await startP) as { sessionId: string };
    void d.emit('chat:session.ready', { sessionId: start.sessionId, agentName: 'fixture-agent' });
    await once(d, 'chat:message.send');
    void d.emit('chat:event', {
      sessionId: start.sessionId,
      event: { kind: 'session_status', state: 'active' },
    });
    void d.emit('chat:event', {
      sessionId: start.sessionId,
      event: { kind: 'message_delta', delta: 'partial' },
    });
    // The turn is observably running before the caller proceeds.
    for (let i = 0; i < 100; i += 1) {
      const p = await app.realtime.assistantDispatch.poll(userId, res.channelId, 0);
      if (p.ok === true && p.busy) return res.channelId;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('dispatch turn never went busy');
  };

  it('a user stop flows back: poll notices (drained once) + a modelVisible note row', async () => {
    const d = daemon!;
    const sid = await makeAssistantSession('as-68-stop');
    const channelId = await dispatchMidTurn(d, sid, 'will be stopped');

    // The /app handler's marking, called directly: the user stopped the turn.
    app.realtime.assistantDispatch.noteUserOp(userId, channelId, 'turn.cancel');

    const poll = await app.realtime.assistantDispatch.poll(userId, channelId, 100);
    expect(poll.ok === true && poll.notices?.some((n) => n.includes('user stopped'))).toBe(true);
    // Drained — a repeat poll does not re-see the notice.
    const again = await app.realtime.assistantDispatch.poll(userId, channelId, 50);
    expect(again.ok === true && again.notices === undefined).toBe(true);
    // The transcript carries the note for the model's NEXT turn.
    const rows = await app.uow.assistants.listMessages(sid);
    const note = rows.find((r) => r.type === 'note' && r.text.includes('user stopped'));
    expect(note).toBeDefined();
    expect(note!.type === 'note' && note!.modelVisible).toBe(true);

    // Settle so the suite's channel count stays bounded.
    void d.emit('chat:event', {
      sessionId: channelId,
      event: { kind: 'turn_result', stopReason: 'cancelled' },
    });
    const done = await app.realtime.assistantDispatch.poll(userId, channelId, 5000);
    expect(done.ok === true && done.status === 'done').toBe(true);
  }, 15000);

  it('a completion with no poll waiting leaves a note + a poll notice', async () => {
    const d = daemon!;
    const sid = await makeAssistantSession('as-68-complete');
    const channelId = await dispatchMidTurn(d, sid, 'nobody watches');

    void d.emit('chat:event', {
      sessionId: channelId,
      event: { kind: 'turn_result', stopReason: 'end_turn' },
    });
    // First contact AFTER the outcome (poll(0) until the terminal lands — a
    // long wait would register a waiter and consume it live instead).
    let done: Awaited<ReturnType<typeof app.realtime.assistantDispatch.poll>> | undefined;
    for (let i = 0; i < 150 && done === undefined; i += 1) {
      const p = await app.realtime.assistantDispatch.poll(userId, channelId, 0);
      if (p.ok === true && p.status === 'done') done = p;
      else await new Promise((r) => setTimeout(r, 20));
    }
    expect(done?.ok === true && done.status === 'done').toBe(true);
    expect(done?.notices?.some((n) => n.includes('finished'))).toBe(true);
    const rows = await app.uow.assistants.listMessages(sid);
    expect(rows.some((r) => r.type === 'note' && r.text.includes('finished'))).toBe(true);
  }, 15000);

  it('a poll blocked in waitMs consumes the outcome directly — no completion note', async () => {
    const d = daemon!;
    const sid = await makeAssistantSession('as-68-waiter');
    const channelId = await dispatchMidTurn(d, sid, 'watched live');

    const pollP = app.realtime.assistantDispatch.poll(userId, channelId, 8000);
    await new Promise((r) => setTimeout(r, 100)); // let the waiter register
    void d.emit('chat:event', {
      sessionId: channelId,
      event: { kind: 'turn_result', stopReason: 'end_turn' },
    });
    const out = await pollP;
    expect(out.ok === true && out.status === 'done').toBe(true);
    expect(out.ok === true && !out.notices?.some((n) => n.includes('finished'))).toBe(true);
    const rows = await app.uow.assistants.listMessages(sid);
    expect(rows.some((r) => r.type === 'note' && r.text.includes('finished'))).toBe(false);
  }, 15000);

  it('a queued user interjection defers the settle: the channel runs a second turn', async () => {
    const d = daemon!;
    const sid = await makeAssistantSession('as-68-interject');
    const channelId = await dispatchMidTurn(d, sid, 'first question');

    // The user interjects through the ordinary door (queue-on-busy) + marking.
    const queued = app.realtime.chat.onMessageSend(userId, channelId, 'follow-up question');
    expect(queued).toMatchObject({ ok: true, queued: true });
    app.realtime.assistantDispatch.noteUserOp(userId, channelId, 'message.send', {
      text: 'follow-up question',
    });

    // The turn ends — but the parked interjection keeps the channel alive.
    const sendP2 = once(d, 'chat:message.send');
    void d.emit('chat:event', {
      sessionId: channelId,
      event: { kind: 'turn_result', stopReason: 'end_turn' },
    });
    void d.emit('chat:event', {
      sessionId: channelId,
      event: { kind: 'session_status', state: 'idle' },
    });
    const second = (await sendP2) as {
      sessionId: string;
      prompt: { type: string; text?: string }[];
    };
    expect(second.sessionId).toBe(channelId);
    expect(second.prompt.some((b) => b.text === 'follow-up question')).toBe(true);
    // Mid-flight check: still running, with the interjection notice aboard.
    const mid = await app.realtime.assistantDispatch.poll(userId, channelId, 50);
    expect(mid.ok === true && mid.status === 'running').toBe(true);
    expect(mid.ok === true && mid.notices?.some((n) => n.includes('sent a message'))).toBe(true);

    // The second turn runs and settles the dispatch with BOTH turns' text.
    void d.emit('chat:event', {
      sessionId: channelId,
      event: { kind: 'session_status', state: 'active' },
    });
    void d.emit('chat:event', {
      sessionId: channelId,
      event: { kind: 'message_delta', delta: 'second answer' },
    });
    void d.emit('chat:event', {
      sessionId: channelId,
      event: { kind: 'turn_result', stopReason: 'end_turn' },
    });
    const done = await app.realtime.assistantDispatch.poll(userId, channelId, 5000);
    expect(done).toMatchObject({ status: 'done', text: 'partial\nsecond answer' });
  }, 15000);

  it("the session's dispatch snapshot pushes to the owner's /app sockets", async () => {
    const d = daemon!;
    const sid = await makeAssistantSession('as-68-push');
    const viewer = io(`${baseUrl}/app`, {
      auth: { token: jwt },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
    await once(viewer, 'connect');
    const pushes: { sessionId: string; dispatches: { channelId: string; status: string }[] }[] = [];
    viewer.on('assistant:dispatches', (p: (typeof pushes)[number]) => pushes.push(p));
    try {
      const channelId = await dispatchMidTurn(d, sid, 'pushed live');
      await waitFor(() =>
        pushes.some(
          (p) => p.sessionId === sid && p.dispatches.some((x) => x.channelId === channelId),
        ),
      );
      void d.emit('chat:event', {
        sessionId: channelId,
        event: { kind: 'turn_result', stopReason: 'end_turn' },
      });
      await waitFor(() =>
        pushes.some(
          (p) =>
            p.sessionId === sid &&
            p.dispatches.some((x) => x.channelId === channelId && x.status === 'done'),
        ),
      );
    } finally {
      viewer.disconnect();
    }
  }, 15000);

  it("lists only THIS session's live dispatches; terminal records and strangers stay out", async () => {
    const d = daemon!;
    const sid = 'as-69-brief';
    await app.uow.assistants.saveSession({
      id: sid,
      ownerId: userId,
      assistantId: 'cfg-68-test',
      title: 'brief',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastMessageAt: null,
    });
    // Nothing live → no section at all.
    expect(app.realtime.assistantDispatch.briefFor(sid)).toBe('');

    const channelId = await dispatchMidTurn(d, sid, 'brief me');
    const brief = app.realtime.assistantDispatch.briefFor(sid);
    expect(brief).toContain(channelId);
    expect(brief).toContain(agentId);
    expect(brief).toContain('running');
    expect(brief).toContain('mid-turn');
    // A different session's brief stays empty.
    expect(app.realtime.assistantDispatch.briefFor('as-69-other')).toBe('');

    // Terminal → the section goes quiet again.
    void d.emit('chat:event', {
      sessionId: channelId,
      event: { kind: 'turn_result', stopReason: 'end_turn' },
    });
    const done = await app.realtime.assistantDispatch.poll(userId, channelId, 5000);
    expect(done.ok === true && done.status === 'done').toBe(true);
    expect(app.realtime.assistantDispatch.briefFor(sid)).toBe('');
  }, 15000);
});
