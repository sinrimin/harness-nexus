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
    const start = (await startP) as { sessionId: string };
    expect(start.sessionId).toBe(res.channelId);

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
