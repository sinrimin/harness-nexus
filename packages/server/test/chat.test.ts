import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { ChatStreamEvent } from '@harness-nexus/shared';
import { emitAck, once, testConfig, waitFor } from './helpers.js';

/**
 * Chat integration (Phase 8 C5, reworked 9 W7) with a fake daemon on /ctl and
 * a fake browser on /app: open → start → ready → message round-trip,
 * permission respond + timeout watchdog, busy gate, re-join (+ history
 * resync), resume passthrough, spawn failure, ready-timeout, session cap,
 * disconnect teardown, user disconnect, and the gating matrix.
 *
 * Chat timeouts come from testConfig overrides: permission 400ms (fast
 * watchdog test) and ready 2500ms (the vitest worker startup can starve the
 * fake daemon's reply beyond the default 800ms; the watchdog test still waits
 * past it). Cap is 2 open sessions per machine.
 */

let app: FastifyInstance;
let baseUrl: string;
let jwt: string;
let machineId: string;
let machineToken: string;
let agentId: string;
let daemon: Socket;
let browser: Socket;

const authed = (token: string): { authorization: string } => ({ authorization: `Bearer ${token}` });

const openSession = async (
  sock: Socket,
  agentInstanceId: string,
  sessionId?: string,
): Promise<{ sessionId?: string; phase?: 'starting' | 'ready'; error?: string }> =>
  (await emitAck(sock, 'chat:session.open', {
    agentInstanceId,
    ...(sessionId !== undefined ? { sessionId } : {}),
  })) as { sessionId?: string; phase?: 'starting' | 'ready'; error?: string };

/** 9 W6 — open with a project `directory`. */
const openSessionDir = async (
  sock: Socket,
  agentInstanceId: string,
  directory: string,
): Promise<{ sessionId?: string; phase?: 'starting' | 'ready'; error?: string }> =>
  (await emitAck(sock, 'chat:session.open', {
    agentInstanceId,
    directory,
  })) as { sessionId?: string; phase?: 'starting' | 'ready'; error?: string };

/** 9 W7 — open resuming the agent's OWN native session. */
const openSessionResume = async (
  sock: Socket,
  agentInstanceId: string,
  resume: { sessionId: string; cwd: string },
): Promise<{ sessionId?: string; phase?: 'starting' | 'ready'; error?: string }> =>
  (await emitAck(sock, 'chat:session.open', {
    agentInstanceId,
    resume,
  })) as { sessionId?: string; phase?: 'starting' | 'ready'; error?: string };

/** Daemon-side ready reply for a start event. */
const readyFor = (sock: Socket, start: { sessionId: string }): void => {
  void sock.emit('chat:session.ready', {
    sessionId: start.sessionId,
    agentName: 'fixture-agent',
    agentVersion: '0.1.0',
  });
};

/** Collect `chat:event` payloads matching `pred` (events stream in order). */
const nextEvent = async (
  sock: Socket,
  pred: (e: ChatStreamEvent) => boolean,
  timeoutMs = 5000,
): Promise<ChatStreamEvent> => {
  const seen: ChatStreamEvent[] = [];
  const grabbed = new Promise<ChatStreamEvent>((resolve) => {
    const onEvent = (envelope: { event: ChatStreamEvent }): void => {
      if (pred(envelope.event)) {
        sock.off('chat:event', onEvent);
        resolve(envelope.event);
      } else {
        seen.push(envelope.event);
      }
    };
    sock.on('chat:event', onEvent);
  });
  const timer = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error(`no matching chat:event (${seen.length} others seen)`)),
      timeoutMs,
    ),
  );
  return Promise.race([grabbed, timer]);
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
    payload: { username: 'chatter', password: 'hunter2hunter2' },
  });
  jwt = reg.json().token;

  const enroll = await app.inject({
    method: 'POST',
    url: '/api/machines',
    headers: authed(jwt),
    payload: { name: 'chat-box' },
  });
  machineId = enroll.json().machine.id;
  machineToken = enroll.json().token;

  const now = new Date().toISOString();
  await app.uow.agentInstances.save({
    id: 'agent-chat-1',
    machineId,
    ownerId: (await app.uow.users.findByUsername('chatter'))!.id,
    target: 'hermes',
    profileId: 'profile-chat-1',
    profileVersion: '1.0.0',
    name: 'chat agent',
    directory: '/home/tester/.hermes',
    jobId: 'job-chat-1',
    createdAt: now,
    updatedAt: now,
  });
  agentId = 'agent-chat-1';

  browser = io(`${baseUrl}/app`, { auth: { token: jwt }, transports: ['websocket'] });
  await once(browser, 'connect');
}, 20000);

afterAll(async () => {
  daemon?.close();
  browser?.close();
  await app?.close();
}, 20000);

async function connectDaemon(
  capabilities: string[],
  opts: { heldIds?: () => string[] } = {},
): Promise<Socket> {
  const sock = io(`${baseUrl}/ctl`, {
    auth: { token: machineToken, machineId },
    transports: ['websocket'],
  });
  // 9 W11 E — the server reconciles on EVERY connection; the handler must be
  // attached BEFORE the connect resolves or the ack misses the window. The
  // default models a fresh W11 daemon: it holds nothing.
  sock.on('chat:reconcile', (payload: unknown, ack?: (res: unknown) => void) => {
    const held = opts.heldIds ? opts.heldIds() : [];
    ack?.({ held });
  });
  await once(sock, 'connect');
  await emitAck(sock, 'machine:hello', { daemonVersion: '0.4.0-test', capabilities });
  return sock;
}

describe('gating', () => {
  it('refuses while remote chat is disabled, machine offline, or daemon lacks chat', async () => {
    daemon = await connectDaemon(['inventory', 'chat']);

    let res = await openSession(browser, agentId);
    expect(res.error).toBe('REMOTE_CHAT_DISABLED');

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/machines/${machineId}`,
      headers: authed(jwt),
      payload: { remoteChatEnabled: true },
    });
    expect(patch.json().machine.remoteChatEnabled).toBe(true);

    daemon.close();
    await waitFor(() => !app.realtime.presence.isOnline(machineId));
    res = await openSession(browser, agentId);
    expect(res.error).toBe('MACHINE_OFFLINE');

    daemon = await connectDaemon(['inventory']); // no 'chat'
    res = await openSession(browser, agentId);
    expect(res.error).toBe('DAEMON_NO_CHAT');

    daemon.close();
    daemon = await connectDaemon(['chat']);
  });

  it('a non-owner cannot even see the agent (existence hiding)', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'chatterother', password: 'hunter2hunter2' },
    });
    const other = io(`${baseUrl}/app`, {
      auth: { token: reg.json().token },
      transports: ['websocket'],
    });
    await once(other, 'connect');
    const res = await openSession(other, agentId);
    expect(res.error).toBe('AGENT_INSTANCE_NOT_FOUND');
    const rest = await app.inject({
      method: 'GET',
      url: `/api/agent-instances/${agentId}/sessions`,
      headers: authed(reg.json().token),
    });
    expect(rest.statusCode).toBe(404);
    other.close();
  });
});

describe('rejoin (9 W7 — resync, no persisted rows)', () => {
  it('fresh open acks phase starting; a rejoin acks ready, re-pushes ready, and asks the daemon to resync history', async () => {
    // Local socket — the lifecycle suite below reuses the gating suite's
    // shared `daemon`; closing it here would starve them.
    const d = await connectDaemon(['chat']);
    const startPromise = new Promise<{ sessionId: string }>((resolve) => {
      d.on('chat:session.start', (p: { sessionId: string }) => resolve(p));
    });
    const fresh = await openSession(browser, agentId);
    const start = await startPromise;
    expect(fresh.sessionId).toBe(start.sessionId);
    expect(fresh.phase).toBe('starting');

    readyFor(d, start);
    const ready = (await once(browser, 'chat:session.ready')) as {
      nativeSessionId?: string;
    };
    // The daemon's ready carries the agent's own session id; the server
    // re-pushes ready (with it) and asks for a history resync.
    expect(ready.nativeSessionId).toBeUndefined(); // this fake daemon sends none

    const resyncP = once(d, 'chat:session.resync');
    const gotPush = once(browser, 'chat:session.ready');
    const rejoin = await openSession(browser, agentId, start.sessionId);
    expect(rejoin.sessionId).toBe(start.sessionId);
    expect(rejoin.phase).toBe('ready');
    await gotPush;
    const resync = (await resyncP) as { sessionId: string };
    expect(resync.sessionId).toBe(start.sessionId);

    await emitAck(d, 'chat:session.closed', {
      sessionId: start.sessionId,
      reason: 'user',
    });
    await once(browser, 'chat:session.closed');
    d.close();
  }, 15000);

  it('relays a daemon history batch to the channel room', async () => {
    const d = await connectDaemon(['chat']);
    try {
      const startPromise = once(d, 'chat:session.start');
      const res = await openSession(browser, agentId);
      const start = (await startPromise) as { sessionId: string };
      const readyP = once(browser, 'chat:session.ready');
      d.emit('chat:session.ready', { sessionId: start.sessionId, nativeSessionId: 'native-7' });
      const ready = (await readyP) as { nativeSessionId?: string };
      expect(ready.nativeSessionId).toBe('native-7');

      const historyP = once(browser, 'chat:history');
      d.emit('chat:history', {
        sessionId: start.sessionId,
        items: [
          { type: 'user', blocks: [{ type: 'text', text: 'earlier question' }] },
          { type: 'event', event: { kind: 'message_delta', delta: 'earlier answer' } },
        ],
      });
      const history = (await historyP) as { sessionId: string; items: unknown[] };
      expect(history.sessionId).toBe(start.sessionId);
      expect(history.items).toHaveLength(2);

      await emitAck(d, 'chat:session.closed', { sessionId: start.sessionId, reason: 'user' });
      await once(browser, 'chat:session.closed');
    } finally {
      d.close();
    }
  }, 15000);

  it('a FRESH socket rejoining a ready channel receives the ready re-push + history (join-before-push)', async () => {
    // Tab-switch/refresh transcript loss (user-found 2026-09-15): the
    // rejoin used to push `ready` + the resync from INSIDE open(), before
    // the /app handler joined the opener — a socket that was never in the
    // room got nothing. The fix joins in reattach, BEFORE the pushes.
    const d = await connectDaemon(['chat']);
    const fresh = io(`${baseUrl}/app`, { auth: { token: jwt }, transports: ['websocket'] });
    try {
      const startPromise = once(d, 'chat:session.start');
      const open = await openSession(browser, agentId);
      const start = (await startPromise) as { sessionId: string };
      expect(open.sessionId).toBe(start.sessionId);
      d.emit('chat:session.ready', { sessionId: start.sessionId, nativeSessionId: 'native-race' });
      await once(browser, 'chat:session.ready');

      await once(fresh, 'connect');
      const readyP = once(fresh, 'chat:session.ready');
      const resyncP = once(d, 'chat:session.resync');
      const rejoin = await openSession(fresh, agentId, start.sessionId);
      expect(rejoin.phase).toBe('ready');
      const ready = (await readyP) as { sessionId: string; nativeSessionId?: string };
      expect(ready.sessionId).toBe(start.sessionId);
      expect(ready.nativeSessionId).toBe('native-race');
      const resync = (await resyncP) as { sessionId: string };
      expect(resync.sessionId).toBe(start.sessionId);
      // The daemon's history replay is relayed into the room — the fresh
      // socket must receive it too.
      const historyP = once(fresh, 'chat:history');
      d.emit('chat:history', {
        sessionId: start.sessionId,
        items: [{ type: 'user', blocks: [{ type: 'text', text: 'again' }] }],
      });
      const history = (await historyP) as { sessionId: string };
      expect(history.sessionId).toBe(start.sessionId);

      await emitAck(d, 'chat:session.closed', { sessionId: start.sessionId, reason: 'user' });
      await once(fresh, 'chat:session.closed');
    } finally {
      fresh.close();
      d.close();
    }
  }, 15000);
});

describe('workspace directories (9 W6)', () => {
  it('validates the picked directory against the base workspace before anything else', async () => {
    // No base workspace configured yet.
    let res = await openSessionDir(browser, agentId, '/home/tester/work/proj-a');
    expect(res.error).toBe('WORKSPACE_NOT_SET');

    await app.inject({
      method: 'PATCH',
      url: `/api/machines/${machineId}`,
      headers: authed(jwt),
      payload: { baseWorkspace: '/home/tester/work' },
    });

    // Outside the root (even after resolution).
    res = await openSessionDir(browser, agentId, '/home/tester/elsewhere');
    expect(res.error).toBe('WORKSPACE_INVALID');
    res = await openSessionDir(browser, agentId, '/home/tester/work/../../etc');
    expect(res.error).toBe('WORKSPACE_INVALID');

    // A valid subdirectory: start carries it.
    const d = await connectDaemon(['chat']);
    try {
      const startPromise = once(d, 'chat:session.start');
      res = await openSessionDir(browser, agentId, '/home/tester/work/proj-a/');
      expect(res.sessionId).toBeTruthy();
      const start = (await startPromise) as { sessionId: string; cwd: string };
      expect(start.cwd).toBe('/home/tester/work/proj-a');

      // The root itself is allowed.
      const rootStart = once(d, 'chat:session.start');
      const rootRes = await openSessionDir(browser, agentId, '/home/tester/work');
      const rootEvt = (await rootStart) as { cwd: string };
      expect(rootEvt.cwd).toBe('/home/tester/work');
      expect(rootRes.sessionId).toBeTruthy();

      await emitAck(d, 'chat:session.closed', { sessionId: res.sessionId!, reason: 'user' });
      await emitAck(d, 'chat:session.closed', { sessionId: rootRes.sessionId!, reason: 'user' });
    } finally {
      d.close();
    }
  }, 15000);

  it('resume passes the native session + its cwd through VERBATIM (no containment)', async () => {
    const d = await connectDaemon(['chat']);
    try {
      const startPromise = once(d, 'chat:session.start');
      // A cwd OUTSIDE the base workspace — legal on resume (it came from the
      // daemon's own listing; dsh enforces its own match).
      const res = await openSessionResume(browser, agentId, {
        sessionId: 'native-s-1',
        cwd: '/somewhere/else/entirely',
      });
      expect(res.sessionId).toBeTruthy();
      const start = (await startPromise) as {
        sessionId: string;
        cwd: string;
        resume?: { sessionId: string; cwd: string };
      };
      expect(start.cwd).toBe('/somewhere/else/entirely');
      expect(start.resume).toEqual({ sessionId: 'native-s-1', cwd: '/somewhere/else/entirely' });

      await emitAck(d, 'chat:session.closed', { sessionId: res.sessionId!, reason: 'user' });
    } finally {
      d.close();
    }
  }, 15000);

  it('session start carries modelOptions from the stored RuntimeConfig (9 W13)', async () => {
    const now = new Date().toISOString();
    const ownerId = (await app.uow.users.findByUsername('chatter'))!.id;
    await app.uow.agentInstances.save({
      id: 'agent-chat-codex',
      machineId,
      ownerId,
      target: 'codex',
      profileId: 'profile-chat-1',
      profileVersion: '1.0.0',
      name: 'codex agent',
      directory: '/home/tester/.codex',
      jobId: 'job-chat-1',
      createdAt: now,
      updatedAt: now,
    });
    await app.uow.runtimeConfigs.save({
      id: 'rc-chat-1',
      machineId,
      ownerId,
      target: 'codex',
      spec: {
        providerLabel: 'gw',
        baseUrl: 'https://gw.example.com/v1',
        api: 'openai',
        model: 'gw-large',
        credentialName: 'gw-key',
        providerId: null,
        // 'gw-large' repeated on purpose: the hint must dedupe extras against
        // the default (stored extras are normalized route-side; belt+braces).
        models: ['gw-mini', 'gw-large'],
        extra: null,
      },
      createdAt: now,
      updatedAt: now,
    });
    const d = await connectDaemon(['chat']);
    try {
      const startPromise = once(d, 'chat:session.start');
      const res = await openSession(browser, 'agent-chat-codex');
      expect(res.sessionId).toBeTruthy();
      const start = (await startPromise) as { modelOptions?: string[] };
      expect(start.modelOptions).toEqual(['gw-large', 'gw-mini']);
      await emitAck(d, 'chat:session.closed', { sessionId: res.sessionId!, reason: 'user' });

      // No stored row → the field is omitted entirely.
      await app.uow.runtimeConfigs.deleteByMachine(machineId);
      const p2 = once(d, 'chat:session.start');
      const res2 = await openSession(browser, 'agent-chat-codex');
      expect(res2.sessionId).toBeTruthy();
      const start2 = (await p2) as { modelOptions?: string[] };
      expect(start2.modelOptions).toBeUndefined();
      await emitAck(d, 'chat:session.closed', { sessionId: res2.sessionId!, reason: 'user' });

      // A non-runtime target (hermes) never carries the hint.
      const p3 = once(d, 'chat:session.start');
      const res3 = await openSession(browser, agentId);
      expect(res3.sessionId).toBeTruthy();
      const start3 = (await p3) as { modelOptions?: string[] };
      expect(start3.modelOptions).toBeUndefined();
      await emitAck(d, 'chat:session.closed', { sessionId: res3.sessionId!, reason: 'user' });
    } finally {
      d.close();
    }
  }, 15000);
});

describe('session lifecycle', () => {
  it(
    'open → start → ready → prompt round-trip with streaming + permission',
    { timeout: 15000 },
    async () => {
      const startP = once(daemon, 'chat:session.start');
      const res = await openSession(browser, agentId);
      expect(res.sessionId).toBeTruthy();
      const sessionId = res.sessionId!;

      const start = (await startP) as { sessionId: string; target: string; cwd: string };
      expect(start.sessionId).toBe(sessionId);
      expect(start.target).toBe('hermes');
      expect(start.cwd).toBe('/home/tester/.hermes');

      const readyP = once(browser, 'chat:session.ready');
      readyFor(daemon, start);
      const ready = (await readyP) as { sessionId: string; agentName?: string };
      expect(ready.sessionId).toBe(sessionId);
      expect(ready.agentName).toBe('fixture-agent');

      // Prompt: browser → server → daemon (string normalized to a text block).
      const promptP = once(daemon, 'chat:message.send');
      const sendAck = await emitAck(browser, 'chat:message.send', {
        sessionId,
        content: 'hello agent',
      });
      expect(sendAck).toEqual({ accepted: true, queued: false });
      const prompt = (await promptP) as { sessionId: string; prompt: unknown[] };
      expect(prompt.sessionId).toBe(sessionId);
      expect(prompt.prompt).toEqual([{ type: 'text', text: 'hello agent' }]);

      // Stream back: status → delta; the busy gate rejects a second prompt.
      // Listeners attach BEFORE the triggering emits — socket.io does not
      // buffer events for absent listeners.
      const activeP = nextEvent(browser, (e) => e.kind === 'session_status');
      const deltaP = nextEvent(browser, (e) => e.kind === 'message_delta');
      daemon.emit('chat:event', { sessionId, event: { kind: 'session_status', state: 'active' } });
      daemon.emit('chat:event', {
        sessionId,
        event: { kind: 'message_delta', delta: 'working on it' },
      });
      expect(await activeP).toEqual({ kind: 'session_status', state: 'active' });
      expect(await deltaP).toEqual({ kind: 'message_delta', delta: 'working on it' });

      // #10 — a second prompt mid-turn QUEUES (server-owned slot, depth 1):
      // ack carries queued:true and the chip rides a queue_state event.
      const chipP = nextEvent(browser, (e) => e.kind === 'queue_state');
      const queued = await emitAck(browser, 'chat:message.send', {
        sessionId,
        content: 'too early',
      });
      expect(queued).toEqual({ accepted: true, queued: true });
      expect(await chipP).toEqual({
        kind: 'queue_state',
        prompt: [{ type: 'text', text: 'too early' }],
        flushed: false,
      });
      // Drop the chip so the rest of this test's idle→send flow is clean.
      const droppedP = nextEvent(browser, (e) => e.kind === 'queue_state' && e.prompt === null);
      const dropAck = await emitAck(browser, 'chat:queue.cancel', { sessionId });
      expect(dropAck).toEqual({ accepted: true });
      expect(await droppedP).toEqual({ kind: 'queue_state', prompt: null, flushed: false });

      const permReqP = nextEvent(browser, (e) => e.kind === 'permission_request');
      daemon.emit('chat:event', {
        sessionId,
        event: {
          kind: 'permission_request',
          requestId: 'perm-1',
          toolCall: { toolCallId: 't1', title: 'run fixture tool', kind: 'execute' },
          options: [
            { optionId: 'allow_always', name: 'Allow', kind: 'allow_always' },
            { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
          ],
        },
      });
      await permReqP;

      const respondP = once(daemon, 'chat:permission.respond');
      const resolvedP = nextEvent(browser, (e) => e.kind === 'permission_resolved');
      const respondAck = await emitAck(browser, 'chat:permission.respond', {
        sessionId,
        requestId: 'perm-1',
        optionId: 'allow_always',
      });
      expect(respondAck).toEqual({ accepted: true });
      const forwarded = (await respondP) as {
        sessionId: string;
        requestId: string;
        optionId?: string;
      };
      expect(forwarded.optionId).toBe('allow_always'); // verbatim, never rewritten
      expect(await resolvedP).toEqual({
        kind: 'permission_resolved',
        requestId: 'perm-1',
        outcome: 'selected',
        optionId: 'allow_always',
      });

      const idleP = nextEvent(browser, (e) => e.kind === 'session_status' && e.state === 'idle');
      daemon.emit('chat:event', {
        sessionId,
        event: { kind: 'turn_result', stopReason: 'end_turn' },
      });
      daemon.emit('chat:event', { sessionId, event: { kind: 'session_status', state: 'idle' } });
      await idleP;
      const secondPromptP = once(daemon, 'chat:message.send');
      const ok = await emitAck(browser, 'chat:message.send', { sessionId, content: 'again' });
      expect(ok).toEqual({ accepted: true, queued: false });
      await secondPromptP;

      // Re-join: a second tab opens the SAME session and sees new events.
      const tab2 = io(`${baseUrl}/app`, { auth: { token: jwt }, transports: ['websocket'] });
      await once(tab2, 'connect');
      const rejoin = await openSession(tab2, agentId, sessionId);
      expect(rejoin.sessionId).toBe(sessionId);
      const tabsP = nextEvent(tab2, (e) => e.kind === 'message_delta' && e.delta === 'hi tabs');
      daemon.emit('chat:event', { sessionId, event: { kind: 'message_delta', delta: 'hi tabs' } });
      await tabsP;
      tab2.close();

      // Leave no live session behind — later tests depend on the cap budget.
      const selfClosedP = once(browser, 'chat:session.closed');
      await emitAck(browser, 'chat:session.close', { sessionId });
      await selfClosedP;
    },
  );

  it('permission timeout answers the daemon with cancelled and settles the card', async () => {
    const startP = once(daemon, 'chat:session.start');
    await openSession(browser, agentId);
    const start = (await startP) as { sessionId: string };
    const readyP = once(browser, 'chat:session.ready');
    readyFor(daemon, start);
    await readyP;

    daemon.emit('chat:event', {
      sessionId: start.sessionId,
      event: {
        kind: 'permission_request',
        requestId: 'perm-timeout',
        toolCall: { toolCallId: 't2' },
        options: [{ optionId: 'allow_once', name: 'Allow', kind: 'allow_once' }],
      },
    });
    const cancelP = once(daemon, 'chat:permission.respond');
    const cancel = (await cancelP) as { requestId: string; optionId?: string };
    expect(cancel.requestId).toBe('perm-timeout');
    expect(cancel.optionId).toBeUndefined(); // cancelled
    const settled = await nextEvent(browser, (e) => e.kind === 'permission_resolved', 3000);
    expect(settled).toEqual({
      kind: 'permission_resolved',
      requestId: 'perm-timeout',
      outcome: 'timeout',
    });

    const closedP = once(browser, 'chat:session.closed');
    await emitAck(browser, 'chat:session.close', { sessionId: start.sessionId });
    await closedP;
  });

  it('elicitation round-trips accept verbatim and times out with cancel (9 W14.1)', async () => {
    const startP = once(daemon, 'chat:session.start');
    await openSession(browser, agentId);
    const start = (await startP) as { sessionId: string };
    const readyP = once(browser, 'chat:session.ready');
    readyFor(daemon, start);
    await readyP;

    // Request → relayed to the browser.
    const reqP = nextEvent(browser, (e) => e.kind === 'elicitation_request');
    daemon.emit('chat:event', {
      sessionId: start.sessionId,
      event: {
        kind: 'elicitation_request',
        requestId: 'eli-1',
        message: 'Which color do you prefer?',
        fields: [
          {
            name: 'question_0',
            type: 'enum',
            required: true,
            options: [{ value: 'Red' }, { value: 'Blue' }],
          },
          { name: 'question_1', type: 'text' },
        ],
        toolCallId: 'call_1',
      },
    });
    await reqP;

    // Accept → values forwarded VERBATIM (they are the ACP content).
    const respondP = once(daemon, 'chat:elicitation.respond');
    const resolvedP = nextEvent(browser, (e) => e.kind === 'elicitation_resolved');
    const ack = await emitAck(browser, 'chat:elicitation.respond', {
      sessionId: start.sessionId,
      requestId: 'eli-1',
      action: 'accept',
      values: { question_0: 'Red', question_1: 'thanks' },
    });
    expect(ack).toEqual({ accepted: true });
    const forwarded = (await respondP) as {
      requestId: string;
      action: string;
      values?: Record<string, unknown>;
    };
    expect(forwarded.action).toBe('accept');
    expect(forwarded.values).toEqual({ question_0: 'Red', question_1: 'thanks' });
    expect(await resolvedP).toEqual({
      kind: 'elicitation_resolved',
      requestId: 'eli-1',
      outcome: 'accepted',
    });

    // An unanswered request times out ⇒ cancel to the daemon + settled card.
    daemon.emit('chat:event', {
      sessionId: start.sessionId,
      event: {
        kind: 'elicitation_request',
        requestId: 'eli-timeout',
        message: 'Slow one?',
        fields: [],
      },
    });
    const cancelP = once(daemon, 'chat:elicitation.respond');
    const cancel = (await cancelP) as { requestId: string; action: string };
    expect(cancel.requestId).toBe('eli-timeout');
    expect(cancel.action).toBe('cancel');
    const settled = await nextEvent(browser, (e) => e.kind === 'elicitation_resolved', 3000);
    expect(settled).toEqual({
      kind: 'elicitation_resolved',
      requestId: 'eli-timeout',
      outcome: 'timeout',
    });

    const closedP = once(browser, 'chat:session.closed');
    await emitAck(browser, 'chat:session.close', { sessionId: start.sessionId });
    await closedP;
  });

  it('spawn failure (ready with error) closes the channel as spawn-failed', async () => {
    const startP = once(daemon, 'chat:session.start');
    await openSession(browser, agentId);
    const start = (await startP) as { sessionId: string };
    const failedP = once(browser, 'chat:session.failed');
    const failedClosedP = once(browser, 'chat:session.closed');
    daemon.emit('chat:session.ready', {
      sessionId: start.sessionId,
      error: 'npx: command not found',
    });
    const failed = (await failedP) as {
      sessionId: string;
      error: string;
    };
    expect(failed.error).toContain('npx');
    await failedClosedP;
  });

  it(
    'ready watchdog closes a channel the daemon never reports ready',
    { timeout: 10000 },
    async () => {
      const startP = once(daemon, 'chat:session.start');
      await openSession(browser, agentId);
      await startP; // daemon stays silent on purpose
      const closed = (await once(browser, 'chat:session.closed', 6000)) as {
        sessionId: string;
        reason: string;
      };
      expect(closed.reason).toBe('spawn-timeout');
    },
  );

  it(
    'a full TOTAL budget evicts the oldest non-busy channel instead of rejecting',
    { timeout: 15000 },
    async () => {
      // Helpers default the budget to 2 total / 1 active.
      const ids: string[] = [];
      for (let i = 0; i < 2; i++) {
        const startP = once(daemon, 'chat:session.start');
        await openSession(browser, agentId);
        const start = (await startP) as { sessionId: string };
        const readyP = once(browser, 'chat:session.ready');
        readyFor(daemon, start);
        await readyP;
        ids.push(start.sessionId);
      }

      // Third open at cap: the OLDEST (idle) channel gives way — no rejection.
      const evictedP = once(browser, 'chat:session.closed');
      const startP = once(daemon, 'chat:session.start');
      const third = await openSession(browser, agentId);
      expect(third.error).toBeUndefined();
      const evicted = (await evictedP) as { sessionId: string; reason: string };
      expect(evicted.sessionId).toBe(ids[0]);
      expect(evicted.reason).toBe('evicted');
      const start3 = (await startP) as { sessionId: string };
      const ready3P = once(browser, 'chat:session.ready');
      readyFor(daemon, start3);
      await ready3P;

      // Leave the table clean for the tests below.
      await emitAck(browser, 'chat:session.close', { sessionId: ids[1]! });
      await emitAck(browser, 'chat:session.close', { sessionId: third.sessionId! });
    },
  );

  it(
    'a full budget where EVERY channel is mid-turn still rejects',
    { timeout: 15000 },
    async () => {
      const ids: string[] = [];
      for (let i = 0; i < 2; i++) {
        const startP = once(daemon, 'chat:session.start');
        await openSession(browser, agentId);
        const start = (await startP) as { sessionId: string };
        const readyP = once(browser, 'chat:session.ready');
        readyFor(daemon, start);
        await readyP;
        ids.push(start.sessionId);
        // Mid-turn sessions are eviction-proof — mark both busy.
        daemon.emit('chat:event', {
          sessionId: start.sessionId,
          event: { kind: 'session_status', state: 'active' },
        });
      }
      const third = await openSession(browser, agentId);
      expect(third.error).toBe('SESSION_LIMIT_REACHED');
      for (const id of ids) {
        daemon.emit('chat:event', {
          sessionId: id,
          event: { kind: 'session_status', state: 'idle' },
        });
        await emitAck(browser, 'chat:session.close', { sessionId: id });
      }
    },
  );

  it(
    'an ACTIVE budget bounces a prompt on an otherwise idle channel',
    { timeout: 15000 },
    async () => {
      // Active cap is 1 (helpers): one generating session blocks every other.
      const startP1 = once(daemon, 'chat:session.start');
      await openSession(browser, agentId);
      const s1 = (await startP1) as { sessionId: string };
      const ready1P = once(browser, 'chat:session.ready');
      readyFor(daemon, s1);
      await ready1P;
      daemon.emit('chat:event', {
        sessionId: s1.sessionId,
        event: { kind: 'session_status', state: 'active' },
      });

      const startP2 = once(daemon, 'chat:session.start');
      await openSession(browser, agentId);
      const s2 = (await startP2) as { sessionId: string };
      const ready2P = once(browser, 'chat:session.ready');
      readyFor(daemon, s2);
      await ready2P;

      const bounced = await emitAck(browser, 'chat:message.send', {
        sessionId: s2.sessionId,
        content: 'should bounce',
      });
      expect(bounced).toEqual({ error: 'MACHINE_BUSY' });

      // The generating turn ends → the same prompt goes through.
      daemon.emit('chat:event', {
        sessionId: s1.sessionId,
        event: { kind: 'session_status', state: 'idle' },
      });
      const ok = await emitAck(browser, 'chat:message.send', {
        sessionId: s2.sessionId,
        content: 'goes through',
      });
      expect(ok).toEqual({ accepted: true, queued: false });

      await emitAck(browser, 'chat:session.close', { sessionId: s1.sessionId });
      await emitAck(browser, 'chat:session.close', { sessionId: s2.sessionId });
    },
  );

  it(
    'the last window leaving (socket gone) closes an IDLE channel — the adapter dies',
    { timeout: 10000 },
    async () => {
      // 9 W11 user-scoped liveness: park the suite's shared `browser` socket —
      // "the last viewer" is now the user's last CONNECTED window, and the
      // shared socket would keep the channel alive.
      browser.disconnect();
      const viewer = io(`${baseUrl}/app`, { auth: { token: jwt }, transports: ['websocket'] });
      await once(viewer, 'connect');
      const startP = once(daemon, 'chat:session.start');
      await openSession(viewer, agentId);
      const start = (await startP) as { sessionId: string };
      const readyP = once(viewer, 'chat:session.ready');
      readyFor(daemon, start);
      await readyP;

      // Viewer drops (tab close / full refresh) with nobody else in the room:
      // the channel must close and TELL THE DAEMON (this teardown was missing —
      // adapters piled up on the machine until every later spawn timed out).
      const daemonCloseP = once(daemon, 'chat:session.close');
      viewer.close();
      const toDaemon = (await daemonCloseP) as { sessionId: string };
      expect(toDaemon.sessionId).toBe(start.sessionId);
      browser = io(`${baseUrl}/app`, { auth: { token: jwt }, transports: ['websocket'] });
      await once(browser, 'connect');
    },
  );

  it(
    'the last viewer leaving MID-TURN closes the channel when the turn ends',
    { timeout: 15000 },
    async () => {
      browser.disconnect();
      const viewer = io(`${baseUrl}/app`, { auth: { token: jwt }, transports: ['websocket'] });
      await once(viewer, 'connect');
      const startP = once(daemon, 'chat:session.start');
      await openSession(viewer, agentId);
      const start = (await startP) as { sessionId: string };
      const readyP = once(viewer, 'chat:session.ready');
      readyFor(daemon, start);
      await readyP;
      daemon.emit('chat:event', {
        sessionId: start.sessionId,
        event: { kind: 'session_status', state: 'active' },
      });

      // Viewer drops while generating: NO close yet (the turn must finish and
      // persist), then the idle transition lands it.
      const daemonCloseP = once(daemon, 'chat:session.close');
      viewer.close();
      await new Promise((r) => setTimeout(r, 400));
      daemon.emit('chat:event', {
        sessionId: start.sessionId,
        event: { kind: 'turn_result', stopReason: 'end_turn' },
      });
      daemon.emit('chat:event', {
        sessionId: start.sessionId,
        event: { kind: 'session_status', state: 'idle' },
      });
      const toDaemon = (await daemonCloseP) as { sessionId: string };
      expect(toDaemon.sessionId).toBe(start.sessionId);
      browser = io(`${baseUrl}/app`, { auth: { token: jwt }, transports: ['websocket'] });
      await once(browser, 'connect');
    },
  );

  it(
    'daemon disconnect closes every open channel (the native sessions survive)',
    { timeout: 10000 },
    async () => {
      // Self-sufficient: the budget tests above leave a clean table.
      const startP = once(daemon, 'chat:session.start');
      await openSession(browser, agentId);
      const start = (await startP) as { sessionId: string };
      const readyP = once(browser, 'chat:session.ready');
      readyFor(daemon, start);
      await readyP;

      daemon.close();
      const closed = (await once(browser, 'chat:session.closed', 6000)) as { reason: string };
      expect(closed.reason).toBe('connection-lost');
    },
  );

  it(
    'a daemon RECONNECT reaps the previous connection’s channels even when the machine never went offline',
    { timeout: 10000 },
    async () => {
      // The reconnect race: the replacement socket registers BEFORE the old
      // one's disconnect is processed, so presence never flips and the
      // offline-transition reap is skipped. The old channels are dead (the
      // daemon tears sessions down with its socket) yet they kept their slots
      // — every later open answered SESSION_LIMIT_REACHED until a server
      // restart. Reaping on connection is what makes a daemon restart
      // recoverable.
      // The daemon that came back is tracked locally so the test can close it:
      // a socket left connected here makes the suite's `app.close()` hang.
      const reconnected = await connectDaemon(['chat']);
      daemon = reconnected;
      const startP = once(reconnected, 'chat:session.start');
      await openSession(browser, agentId);
      const start = (await startP) as { sessionId: string };
      const readyP = once(browser, 'chat:session.ready');
      readyFor(reconnected, start);
      await readyP;

      // The old socket stays connected on purpose (no offline transition).
      // The listener must be attached BEFORE the replacement connects: the reap
      // fires on connection, i.e. before `connectDaemon` even returns.
      const closedP = once(browser, 'chat:session.closed', 6000);
      const replacement = await connectDaemon(['chat']);
      const closed = (await closedP) as { reason: string };
      expect(closed.reason).toBe('connection-lost');

      try {
        // And the cap is free again — a fresh open is accepted.
        const startP2 = once(replacement, 'chat:session.start');
        const again = await openSession(browser, agentId);
        expect(again.error).toBeUndefined();
        const start2 = (await startP2) as { sessionId: string };
        const closed2P = once(browser, 'chat:session.closed');
        await emitAck(browser, 'chat:session.close', { sessionId: start2.sessionId });
        await closed2P;
      } finally {
        replacement.close();
        reconnected.close();
      }
    },
  );

  it('user disconnect notifies the daemon (channel-only — no session finality)', async () => {
    daemon = await connectDaemon(['chat']);
    const startP = once(daemon, 'chat:session.start');
    await openSession(browser, agentId);
    const start = (await startP) as { sessionId: string };
    const readyP = once(browser, 'chat:session.ready');
    readyFor(daemon, start);
    await readyP;

    const daemonCloseP = once(daemon, 'chat:session.close');
    const selfClosedP = once(browser, 'chat:session.closed');
    const ack = await emitAck(browser, 'chat:session.close', { sessionId: start.sessionId });
    expect(ack).toEqual({ closed: true });
    const toDaemon = (await daemonCloseP) as { sessionId: string; reason?: string };
    expect(toDaemon.sessionId).toBe(start.sessionId);
    await selfClosedP;
  });

  it('daemon-initiated close (agent exited) reaches the viewer', async () => {
    const startP = once(daemon, 'chat:session.start');
    await openSession(browser, agentId);
    const start = (await startP) as { sessionId: string };
    const readyP = once(browser, 'chat:session.ready');
    readyFor(daemon, start);
    await readyP;

    const closedP = once(browser, 'chat:session.closed');
    daemon.emit('chat:session.closed', { sessionId: start.sessionId, reason: 'agent-exited' });
    const closed = (await closedP) as { reason: string };
    expect(closed.reason).toBe('agent-exited');
  });
});

it(
  '#10: the send queue parks, fills, cancels, flushes on idle, and replays on rejoin',
  { timeout: 15000 },
  async () => {
    const startP = once(daemon, 'chat:session.start');
    const res = await openSession(browser, agentId);
    const sessionId = res.sessionId!;
    const start = (await startP) as { sessionId: string };
    const readyP = once(browser, 'chat:session.ready');
    readyFor(daemon, start);
    await readyP;

    // Turn 1 running.
    daemon.emit('chat:event', { sessionId, event: { kind: 'session_status', state: 'active' } });
    await nextEvent(browser, (e) => e.kind === 'session_status' && e.state === 'active');

    // Park one message.
    const chipP = nextEvent(browser, (e) => e.kind === 'queue_state');
    const queued = await emitAck(browser, 'chat:message.send', {
      sessionId,
      content: 'follow-up question',
    });
    expect(queued).toEqual({ accepted: true, queued: true });
    expect(await chipP).toEqual({
      kind: 'queue_state',
      prompt: [{ type: 'text', text: 'follow-up question' }],
      flushed: false,
    });

    // Depth 1: a second parked send bounces with QUEUE_FULL.
    const full = await emitAck(browser, 'chat:message.send', {
      sessionId,
      content: 'another',
    });
    expect(full).toEqual({ error: 'QUEUE_FULL' });

    // Rejoin replays the chip (a second tab opening the same channel).
    const tab2 = io(`${baseUrl}/app`, { auth: { token: jwt }, transports: ['websocket'] });
    await once(tab2, 'connect');
    const replayP = nextEvent(tab2, (e) => e.kind === 'queue_state' && e.prompt !== null);
    await openSession(tab2, agentId, sessionId);
    expect(await replayP).toEqual({
      kind: 'queue_state',
      prompt: [{ type: 'text', text: 'follow-up question' }],
      flushed: false,
    });
    tab2.disconnect();

    // Turn 1 ends — the idle transition flushes: queue_state(null, flushed)
    // to the room AND the parked prompt forwarded to the daemon.
    const flushEvtP = nextEvent(
      browser,
      (e) => e.kind === 'queue_state' && e.prompt === null && e.flushed === true,
    );
    // #11 — the flush ALSO echoes the parked prompt to the room as a
    // user_message: every viewer paints the user row from the echo.
    // (Subscribed BEFORE the idle emission — the burst arrives together.)
    const flushUserMsgP = nextEvent(browser, (e) => e.kind === 'user_message');
    const flushPromptP = once(daemon, 'chat:message.send');
    daemon.emit('chat:event', { sessionId, event: { kind: 'session_status', state: 'idle' } });
    await nextEvent(browser, (e) => e.kind === 'session_status' && e.state === 'idle');
    expect(await flushEvtP).toEqual({ kind: 'queue_state', prompt: null, flushed: true });
    const flushed = (await flushPromptP) as { sessionId: string; prompt: unknown[] };
    expect(flushed.sessionId).toBe(sessionId);
    expect(flushed.prompt).toEqual([{ type: 'text', text: 'follow-up question' }]);
    expect(await flushUserMsgP).toEqual({
      kind: 'user_message',
      blocks: [{ type: 'text', text: 'follow-up question' }],
    });

    // A parked entry is DROPPED by turn cancel (not auto-sent).
    daemon.emit('chat:event', { sessionId, event: { kind: 'session_status', state: 'active' } });
    await nextEvent(browser, (e) => e.kind === 'session_status' && e.state === 'active');

    // #11 — a mid-turn history batch is followed by a synthetic active
    // status: the fold's history rebuild force-closes running rows, so the
    // server must re-assert turn state after the batch (refresh / rejoin).
    const resyncStatusP = nextEvent(
      browser,
      (e) => e.kind === 'session_status' && e.state === 'active',
    );
    daemon.emit('chat:history', {
      sessionId,
      items: [{ type: 'user', blocks: [{ type: 'text', text: 'resync me' }] }],
    });
    await once(browser, 'chat:history');
    expect(await resyncStatusP).toEqual({ kind: 'session_status', state: 'active' });

    let sendsAfterPark = 0;
    daemon.on('chat:message.send', () => {
      sendsAfterPark += 1;
    });
    await emitAck(browser, 'chat:message.send', { sessionId, content: 'park then stop' });
    const dropP = nextEvent(
      browser,
      (e) => e.kind === 'queue_state' && e.prompt === null && e.flushed === false,
    );
    const cancelP = once(daemon, 'chat:turn.cancel');
    await emitAck(browser, 'chat:turn.cancel', { sessionId });
    expect(await dropP).toEqual({ kind: 'queue_state', prompt: null, flushed: false });
    await cancelP;
    daemon.emit('chat:event', { sessionId, event: { kind: 'session_status', state: 'idle' } });
    await nextEvent(browser, (e) => e.kind === 'session_status' && e.state === 'idle');
    // No flush followed the cancel-idle: the parked 'park then stop' never
    // reached the daemon.
    await new Promise((r) => setTimeout(r, 150));
    expect(sendsAfterPark).toBe(0);
    daemon.off('chat:message.send', () => {
      sendsAfterPark += 1;
    });

    // #11 — an idle DIRECT send echoes to the room too (the sending tab is
    // just another viewer of the user_message broadcast).
    const directEchoP = nextEvent(browser, (e) => e.kind === 'user_message');
    const directP = once(daemon, 'chat:message.send');
    const direct = await emitAck(browser, 'chat:message.send', {
      sessionId,
      content: 'direct while idle',
    });
    expect(direct).toEqual({ accepted: true, queued: false });
    expect(await directEchoP).toEqual({
      kind: 'user_message',
      blocks: [{ type: 'text', text: 'direct while idle' }],
    });
    await directP;

    await emitAck(browser, 'chat:session.close', { sessionId });
  },
);

describe('REST surface', () => {
  // The 'user disconnect' test above (re)creates the suite daemon and leaves
  // it connected for this block; nothing after here uses it. Without this,
  // the machine shows online for the REST of the file — the first test to
  // assert true offline (9 W11 C gates) then hangs on a leaked socket.
  afterAll(async () => {
    daemon?.disconnect();
    await new Promise((r) => setTimeout(r, 150));
  });

  it('requires the sessions capability on the (online) daemon', async () => {
    // The full gating matrix lives in sessions-route.test.ts; here just the
    // shared daemon (online, 'chat' only) against the native listing.
    const res = await app.inject({
      method: 'GET',
      url: `/api/agent-instances/${agentId}/sessions`,
      headers: authed(jwt),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('DAEMON_NO_SESSIONS');
  });
});

describe('session config (9 W9 A)', () => {
  it(
    'ready carries promptCapabilities; config.set forwards to the daemon; session_config relays',
    { timeout: 15000 },
    async () => {
      // LOCAL daemon: reassigning the module-level var would orphan the
      // connection an earlier describe left for afterAll to close.
      const d = await connectDaemon(['chat']);
      try {
        const startP = once(d, 'chat:session.start');
        const res = await openSession(browser, agentId);
        const sessionId = res.sessionId!;
        const start = (await startP) as { sessionId: string };

        const readyP = once(browser, 'chat:session.ready');
        void d.emit('chat:session.ready', {
          sessionId: start.sessionId,
          agentName: 'fixture-agent',
          promptCapabilities: { image: true, embeddedContext: true },
        });
        const ready = (await readyP) as { promptCapabilities?: { image: boolean } };
        expect(ready.promptCapabilities).toEqual({ image: true, embeddedContext: true });

        // Mode arm — forwarded verbatim over /ctl.
        const modeP = once(d, 'chat:config.set');
        const modeAck = await emitAck(browser, 'chat:config.set', {
          sessionId,
          kind: 'mode',
          modeId: 'acceptEdits',
        });
        expect(modeAck).toEqual({ accepted: true });
        expect(await modeP).toEqual({ sessionId, kind: 'mode', modeId: 'acceptEdits' });

        // Option arm (empty value allowed — dsh provider-default reasoning).
        const optP = once(d, 'chat:config.set');
        const optAck = await emitAck(browser, 'chat:config.set', {
          sessionId,
          kind: 'option',
          configId: 'reasoning_effort',
          value: '',
        });
        expect(optAck).toEqual({ accepted: true });
        expect(await optP).toEqual({
          sessionId,
          kind: 'option',
          configId: 'reasoning_effort',
          value: '',
        });

        // The daemon's session_config snapshots relay to the channel room.
        const configP = nextEvent(browser, (e) => e.kind === 'session_config');
        void d.emit('chat:event', {
          sessionId,
          event: {
            kind: 'session_config',
            modes: { currentModeId: 'acceptEdits' },
            configOptions: [
              {
                id: 'model',
                name: 'Model',
                category: 'model',
                currentValue: 'fx-opus',
                options: [{ value: 'fx-opus', name: 'Fixture Opus' }],
              },
            ],
          },
        });
        expect(await configP).toEqual({
          kind: 'session_config',
          modes: { currentModeId: 'acceptEdits' },
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              currentValue: 'fx-opus',
              options: [{ value: 'fx-opus', name: 'Fixture Opus' }],
            },
          ],
        });

        // Ownership: a config.set for an unknown session bounces.
        const bad = await emitAck(browser, 'chat:config.set', {
          sessionId: 'nope',
          kind: 'mode',
          modeId: 'x',
        });
        expect(bad).toEqual({ error: 'SESSION_NOT_FOUND' });

        await emitAck(browser, 'chat:session.close', { sessionId, reason: 'user' });
      } finally {
        d.disconnect();
        await new Promise((r) => setTimeout(r, 150));
      }
    },
  );

  it('rejects config.set while the channel is still starting', { timeout: 15000 }, async () => {
    const d = await connectDaemon(['chat']);
    try {
      const startP = once(d, 'chat:session.start');
      const res = await openSession(browser, agentId);
      const sessionId = res.sessionId!;
      await startP; // deliberately NO ready yet
      const early = await emitAck(browser, 'chat:config.set', {
        sessionId,
        kind: 'mode',
        modeId: 'acceptEdits',
      });
      expect(early).toEqual({ error: 'SESSION_NOT_READY' });
      await emitAck(browser, 'chat:session.close', { sessionId, reason: 'user' });
    } finally {
      d.disconnect();
      await new Promise((r) => setTimeout(r, 150));
    }
  });
});

describe('live-channel snapshot + close-all (9 W11 B)', () => {
  interface SnapChannel {
    sessionId: string;
    phase: 'starting' | 'ready';
    busy: boolean;
    deferred: boolean;
    target?: string;
    nativeSessionId?: string;
  }
  type Snap = { channels: SnapChannel[] };

  /** Attach a snapshot collector to a browser socket. */
  function collectSnaps(sock: Socket): { snaps: Snap[]; last: () => Snap | undefined } {
    const snaps: Snap[] = [];
    sock.on('chat:channels', (s: Snap) => snaps.push(s));
    return { snaps, last: () => snaps[snaps.length - 1] };
  }

  it('pushes the snapshot on open, ready, and close — and on fresh /app connect', async () => {
    const d = await connectDaemon(['chat']);
    const { last } = collectSnaps(browser);
    try {
      const startP = once(d, 'chat:session.start');
      const res = await openSession(browser, agentId);
      const sessionId = res.sessionId!;
      await startP;
      await waitFor(() => last()?.channels.some((c) => c.sessionId === sessionId));
      expect(last()?.channels.find((c) => c.sessionId === sessionId)?.phase).toBe('starting');
      expect(last()?.channels.find((c) => c.sessionId === sessionId)?.target).toBe('hermes');

      void d.emit('chat:session.ready', { sessionId, agentName: 'fixture-agent' });
      await waitFor(
        () => last()?.channels.find((c) => c.sessionId === sessionId)?.phase === 'ready',
      );

      // A freshly connected /app socket gets the snapshot unprompted.
      const b2 = io(`${baseUrl}/app`, { auth: { token: jwt }, transports: ['websocket'] });
      try {
        const first = await once(b2, 'chat:channels');
        expect((first as Snap).channels.some((c) => c.sessionId === sessionId)).toBe(true);
      } finally {
        b2.disconnect();
      }

      await emitAck(browser, 'chat:session.close', { sessionId, reason: 'user' });
      await waitFor(() => !last()?.channels.some((c) => c.sessionId === sessionId));
    } finally {
      d.disconnect();
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 15000);

  it('close-all closes idle channels now and defers busy ones until their turn ends', async () => {
    const d = await connectDaemon(['chat']);
    const { last } = collectSnaps(browser);
    try {
      const s1 = (await openSession(browser, agentId)).sessionId!;
      const s2 = (await openSession(browser, agentId)).sessionId!;
      void d.emit('chat:session.ready', { sessionId: s1, agentName: 'fixture-agent' });
      void d.emit('chat:session.ready', { sessionId: s2, agentName: 'fixture-agent' });
      await waitFor(
        () =>
          last()?.channels.filter((c) => [s1, s2].includes(c.sessionId)).length === 2 &&
          last()!.channels.every((c) => c.phase === 'ready'),
      );

      // s1 goes mid-turn; s2 stays idle.
      void d.emit('chat:event', {
        sessionId: s1,
        event: { kind: 'session_status', state: 'active' },
      });
      await waitFor(() => last()?.channels.find((c) => c.sessionId === s1)?.busy === true);

      const ack = await emitAck(browser, 'chat:channels.closeAll', {});
      expect(ack).toEqual({ closed: 1, deferred: 1 });
      await waitFor(() => !last()?.channels.some((c) => c.sessionId === s2));
      expect(last()?.channels.find((c) => c.sessionId === s1)?.deferred).toBe(true);

      // The deferred channel survives until its turn ends, then closes.
      void d.emit('chat:event', {
        sessionId: s1,
        event: { kind: 'session_status', state: 'idle' },
      });
      await waitFor(() => last()?.channels.length === 0);
    } finally {
      d.disconnect();
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 15000);
});

describe('chat:channels.sync (9 W11 B mount catch-up)', () => {
  it('acks the current snapshot to a freshly mounted viewer', async () => {
    const d = await connectDaemon(['chat']);
    try {
      const startP = once(d, 'chat:session.start');
      const res = await openSession(browser, agentId);
      const sessionId = res.sessionId!;
      await startP;
      void d.emit('chat:session.ready', { sessionId, agentName: 'fixture-agent' });

      // A viewer connecting AFTER the open (the SPA-navigation case: the
      // connect-time push predates this socket) asks and gets the truth.
      const b2 = io(`${baseUrl}/app`, { auth: { token: jwt }, transports: ['websocket'] });
      try {
        await once(b2, 'connect');
        const snap = await emitAck(b2, 'chat:channels.sync', {});
        const channels = (snap as { channels: { sessionId: string; phase: string }[] }).channels;
        expect(channels.some((c) => c.sessionId === sessionId && c.phase === 'ready')).toBe(true);
      } finally {
        b2.disconnect();
      }
      await emitAck(browser, 'chat:session.close', { sessionId, reason: 'user' });
    } finally {
      d.disconnect();
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 15000);
});

describe('user-scoped channel liveness (9 W11)', () => {
  // The machine enrolls with remoteChatEnabled=false; the gating test flips
  // it, but each test here re-asserts it so the block is order-independent.
  beforeEach(async () => {
    await app.inject({
      method: 'PATCH',
      url: `/api/machines/${machineId}`,
      headers: authed(jwt),
      payload: { remoteChatEnabled: true },
    });
  });

  it("one window's refresh does not kill channels another window still shows", async () => {
    const d = await connectDaemon(['chat']);
    // Park the suite's own socket — the whole point is controlling which of
    // the USER's sockets remain.
    browser.disconnect();
    try {
      const w1 = io(`${baseUrl}/app`, { auth: { token: jwt }, transports: ['websocket'] });
      await once(w1, 'connect');
      const startP = once(d, 'chat:session.start');
      const res = await openSession(w1, agentId);
      expect(res.error).toBeUndefined();
      const sessionId = res.sessionId!;
      await startP;
      void d.emit('chat:session.ready', { sessionId, agentName: 'fixture-agent' });

      // A second window of the SAME user (any chat page — it only shows tabs).
      const w2 = io(`${baseUrl}/app`, { auth: { token: jwt }, transports: ['websocket'] });
      await once(w2, 'connect');
      await new Promise((r) => setTimeout(r, 200));

      // w1 goes away entirely (full page refresh → socket disconnect).
      w1.disconnect();
      await new Promise((r) => setTimeout(r, 300));
      let snap = (await emitAck(w2, 'chat:channels.sync', {})) as {
        channels: { sessionId: string }[];
      };
      expect(snap.channels.some((c) => c.sessionId === sessionId)).toBe(true);

      // The LAST window leaving closes the idle channel.
      w2.disconnect();
      await new Promise((r) => setTimeout(r, 400));
      const w3 = io(`${baseUrl}/app`, { auth: { token: jwt }, transports: ['websocket'] });
      await once(w3, 'connect');
      snap = (await emitAck(w3, 'chat:channels.sync', {})) as {
        channels: { sessionId: string }[];
      };
      expect(snap.channels.some((c) => c.sessionId === sessionId)).toBe(false);
      w3.disconnect();
    } finally {
      browser = io(`${baseUrl}/app`, { auth: { token: jwt }, transports: ['websocket'] });
      await once(browser, 'connect');
      d.disconnect();
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 15000);

  it('rejoining a STARTING channel reattaches instead of bouncing', async () => {
    const d = await connectDaemon(['chat']);
    try {
      const startP = once(d, 'chat:session.start');
      const res = await openSession(browser, agentId);
      expect(res.error).toBeUndefined();
      const sessionId = res.sessionId!;
      await startP; // deliberately NO ready yet — still starting

      const rejoin = await openSession(browser, agentId, sessionId);
      expect(rejoin.error).toBeUndefined();
      expect(rejoin.sessionId).toBe(sessionId);
      expect(rejoin.phase).toBe('starting');

      void d.emit('chat:session.ready', { sessionId, agentName: 'fixture-agent' });
      const ready = await once(browser, 'chat:session.ready');
      expect((ready as { sessionId: string }).sessionId).toBe(sessionId);
      await emitAck(browser, 'chat:session.close', { sessionId, reason: 'user' });
    } finally {
      d.disconnect();
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 15000);
});

describe('disconnect grace + reconcile (9 W11 E)', () => {
  /**
   * A daemon socket that CANNOT auto-reconnect — `engine.close()` on it is a
   * one-way TRANSPORT blip (the server sees 'transport close', not a
   * deliberate client disconnect), which is exactly the D5 shape.
   */
  const connectBlipDaemon = async (
    onReconcile?: (sessionIds: string[], ack?: (res: unknown) => void) => void,
  ): Promise<Socket> => {
    const sock = io(`${baseUrl}/ctl`, {
      auth: { token: machineToken, machineId },
      transports: ['websocket'],
      reconnection: false,
    });
    if (onReconcile !== undefined) {
      sock.on('chat:reconcile', (payload: unknown, ack?: (res: unknown) => void) => {
        const ids = (payload as { sessionIds?: string[] }).sessionIds ?? [];
        onReconcile(ids, ack);
      });
    }
    await once(sock, 'connect');
    await emitAck(sock, 'machine:hello', { daemonVersion: '0.14.0-test', capabilities: ['chat'] });
    return sock;
  };

  const engineKill = (sock: Socket): void => {
    (sock.io as unknown as { engine: { close(): void } }).engine.close();
  };

  const openReady = async (d: Socket): Promise<string> => {
    const startP = once(d, 'chat:session.start');
    const res = await openSession(browser, agentId);
    expect(res.error).toBeUndefined();
    const start = (await startP) as { sessionId: string };
    const readyP = once(browser, 'chat:session.ready');
    readyFor(d, start);
    await readyP;
    return start.sessionId;
  };

  it('a transport blip holds rows inside the grace window, then reaps past it', async () => {
    const d = await connectBlipDaemon();
    try {
      const sessionId = await openReady(d);
      engineKill(d);

      // Inside the window (suite grace 2000ms): the row survives.
      await new Promise((r) => setTimeout(r, 300));
      const snap1 = (await emitAck(browser, 'chat:channels.sync', {})) as {
        channels: { sessionId: string }[];
      };
      expect(snap1.channels.some((c) => c.sessionId === sessionId)).toBe(true);

      // Past the window: the delayed reap closes it.
      const closed = (await once(browser, 'chat:session.closed', 6000)) as { reason: string };
      expect(closed.reason).toBe('connection-lost');
    } finally {
      d.disconnect();
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 15000);

  it('a reconnect inside the window cancels the reap and reconcile KEEPS held rows', async () => {
    const held: string[] = [];
    const d = await connectBlipDaemon((ids, ack) => ack?.({ held: [...held] }));
    try {
      const sessionId = await openReady(d);
      held.push(sessionId);
      engineKill(d);
      await new Promise((r) => setTimeout(r, 150));

      // The daemon that came back acks the session as held — the row must
      // survive the blip end-to-end (grace canceled, reconcile confirms).
      const back = await connectDaemon(['chat'], { heldIds: () => [...held] });
      try {
        await new Promise((r) => setTimeout(r, 600));
        const snap = (await emitAck(browser, 'chat:channels.sync', {})) as {
          channels: { sessionId: string }[];
        };
        expect(snap.channels.some((c) => c.sessionId === sessionId)).toBe(true);
        await emitAck(browser, 'chat:session.close', { sessionId, reason: 'user' });
      } finally {
        back.disconnect();
        await new Promise((r) => setTimeout(r, 150));
      }
    } finally {
      d.disconnect();
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 15000);

  it('a daemon that does not answer reconcile (pre-W11) falls back to the delayed reap', async () => {
    // No reconcile handler — the old-daemon compatibility path.
    const d = await connectBlipDaemon();
    try {
      await openReady(d);
      engineKill(d);
      await new Promise((r) => setTimeout(r, 100));

      // The replacement never acks: the handshake times out (min(5000,
      // grace)=2000ms) and the fallback reaps through the SAME grace.
      const silent = await connectBlipDaemon();
      try {
        const closed = (await once(browser, 'chat:session.closed', 8000)) as { reason: string };
        expect(closed.reason).toBe('connection-lost');
      } finally {
        silent.disconnect();
        await new Promise((r) => setTimeout(r, 150));
      }
    } finally {
      d.disconnect();
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 15000);
});

describe('adapter report (9 W11 C)', () => {
  // The machine enrolls with remoteChatEnabled=false; re-assert it so the
  // operator-kill block is order-independent.
  beforeEach(async () => {
    await app.inject({
      method: 'PATCH',
      url: `/api/machines/${machineId}`,
      headers: authed(jwt),
      payload: { remoteChatEnabled: true },
    });
  });

  const reportRow = {
    wireSessionId: 'w-1',
    target: 'claude-code',
    pgid: 4242,
    nativeSessionId: 'native-1',
    startedAt: Date.now(),
    command: 'npx',
  };

  it('GET /api/machines/:id/adapters returns the daemon-reported rows', async () => {
    const d = await connectDaemon(['chat']);
    try {
      d.on('adapters:report', (payload: { requestId: string }, ack?: (r: unknown) => void) => {
        ack?.({ accepted: true });
        void d.emit('adapters:report:result', {
          requestId: payload.requestId,
          adapters: [reportRow],
        });
      });
      const res = await app.inject({
        method: 'GET',
        url: `/api/machines/${machineId}/adapters`,
        headers: authed(jwt),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { machineId: string; adapters: (typeof reportRow)[] };
      expect(body.machineId).toBe(machineId);
      expect(body.adapters).toHaveLength(1);
      expect(body.adapters[0]).toMatchObject({ wireSessionId: 'w-1', pgid: 4242, command: 'npx' });
    } finally {
      d.disconnect();
      await new Promise((r) => setTimeout(r, 150));
    }
  });

  it('gates: foreign user 404, no chat capability 409, offline 409', async () => {
    const other = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'adapterless', password: 'hunter2hunter2' },
    });
    const otherJwt = other.json().token as string;

    const res404 = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/adapters`,
      headers: authed(otherJwt),
    });
    expect(res404.statusCode).toBe(404);
    expect(res404.json().error).toBe('MACHINE_NOT_FOUND');

    const d = await connectDaemon(['inventory']); // online, no chat capability
    try {
      const res409 = await app.inject({
        method: 'GET',
        url: `/api/machines/${machineId}/adapters`,
        headers: authed(jwt),
      });
      expect(res409.statusCode).toBe(409);
      expect(res409.json().error).toBe('DAEMON_NO_CHAT');
    } finally {
      d.disconnect();
      await new Promise((r) => setTimeout(r, 150));
    }

    // Offline: d was disconnected in the finally above — wait until presence
    // actually flips (the same direct-read wait the gating block uses; a
    // deliberate close is immediate server-side, but the packet can land
    // late under a loaded worker).
    await waitFor(() => (app.realtime.presence.isOnline(machineId) ? undefined : true));
    const resOffline = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/adapters`,
      headers: authed(jwt),
    });
    expect(resOffline.statusCode).toBe(409);
    expect(resOffline.json().error).toBe('MACHINE_OFFLINE');
  }, 10000);

  it('a daemon that never answers (pre-W11) times out → 504', async () => {
    const d = await connectDaemon(['chat']); // no report handler
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/machines/${machineId}/adapters`,
        headers: authed(jwt),
      });
      expect(res.statusCode).toBe(504);
      expect(res.json().error).toBe('ADAPTERS_TIMEOUT');
    } finally {
      d.disconnect();
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 10000);

  it('POST …/adapters/:sessionId/close is the operator kill', async () => {
    const d = await connectDaemon(['chat']);
    try {
      const startP = once(d, 'chat:session.start');
      const res = await openSession(browser, agentId);
      expect(res.error).toBeUndefined();
      const start = (await startP) as { sessionId: string };
      const readyP = once(browser, 'chat:session.ready');
      readyFor(d, start);
      await readyP;

      const daemonCloseP = once(d, 'chat:session.close');
      const browserClosedP = once(browser, 'chat:session.closed');
      const kill = await app.inject({
        method: 'POST',
        url: `/api/machines/${machineId}/adapters/${start.sessionId}/close`,
        headers: authed(jwt),
      });
      expect(kill.statusCode).toBe(200);
      expect(kill.json()).toEqual({ closed: true });
      expect(((await daemonCloseP) as { sessionId: string }).sessionId).toBe(start.sessionId);
      expect(((await browserClosedP) as { reason: string }).reason).toBe('operator');

      // The row is gone — a second kill 404-hides.
      const again = await app.inject({
        method: 'POST',
        url: `/api/machines/${machineId}/adapters/${start.sessionId}/close`,
        headers: authed(jwt),
      });
      expect(again.statusCode).toBe(404);
      expect(again.json().error).toBe('ADAPTER_NOT_FOUND');
    } finally {
      d.disconnect();
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 15000);
});

describe('idle pressure + open dedupe (9 W11 D6 + user-found fixes)', () => {
  beforeEach(async () => {
    await app.inject({
      method: 'PATCH',
      url: `/api/machines/${machineId}`,
      headers: authed(jwt),
      payload: { remoteChatEnabled: true },
    });
  });

  it('a resume open while the SAME native session is establishing re-attaches it', async () => {
    const d = await connectDaemon(['chat']);
    try {
      let starts = 0;
      d.on('chat:session.start', () => {
        starts += 1;
      });
      const startP = once(d, 'chat:session.start');
      const first = await openSessionResume(browser, agentId, {
        sessionId: 'native-dup',
        cwd: '/home/tester/work',
      });
      expect(first.error).toBeUndefined();
      const start = (await startP) as { sessionId: string };
      expect(starts).toBe(1);

      // The rail double-click while the first is still establishing: the
      // second open must JOIN the same channel, not spawn a second adapter.
      const second = await openSessionResume(browser, agentId, {
        sessionId: 'native-dup',
        cwd: '/home/tester/work',
      });
      expect(second.error).toBeUndefined();
      expect(second.sessionId).toBe(first.sessionId);
      expect(second.phase).toBe('starting');
      await new Promise((r) => setTimeout(r, 300));
      expect(starts).toBe(1); // exactly one adapter spawn reached the daemon

      // Once ready (native id now known), a third resume still reattaches.
      void d.emit('chat:session.ready', {
        sessionId: start.sessionId,
        agentName: 'fixture-agent',
        nativeSessionId: 'native-dup',
      });
      await once(browser, 'chat:session.ready');
      const third = await openSessionResume(browser, agentId, {
        sessionId: 'native-dup',
        cwd: '/home/tester/work',
      });
      expect(third.error).toBeUndefined();
      expect(third.sessionId).toBe(first.sessionId);
      await emitAck(browser, 'chat:session.close', { sessionId: first.sessionId! });
    } finally {
      d.disconnect();
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 15000);

  it('closeAll idleOnly closes idle channels and leaves busy ones completely alone', async () => {
    const d = await connectDaemon(['chat']);
    try {
      const s1P = once(d, 'chat:session.start');
      const c1 = await openSession(browser, agentId);
      const s1 = (await s1P) as { sessionId: string };
      void d.emit('chat:session.ready', { sessionId: s1.sessionId, agentName: 'fixture-agent' });
      await once(browser, 'chat:session.ready');
      const s2P = once(d, 'chat:session.start');
      const c2 = await openSession(browser, agentId);
      const s2 = (await s2P) as { sessionId: string };
      void d.emit('chat:session.ready', { sessionId: s2.sessionId, agentName: 'fixture-agent' });
      await once(browser, 'chat:session.ready');
      expect(c1.sessionId).toBeDefined();
      expect(c2.sessionId).toBeDefined();

      // s2 goes mid-turn.
      void d.emit('chat:event', {
        sessionId: s2.sessionId,
        event: { kind: 'session_status', state: 'active' },
      });

      const idleRes = (await emitAck(browser, 'chat:channels.closeAll', {
        idleOnly: true,
      })) as { closed: number; deferred: number };
      expect(idleRes).toEqual({ closed: 1, deferred: 0 });
      // The busy channel is untouched — NOT even deferred.
      let snap = (await emitAck(browser, 'chat:channels.sync', {})) as {
        channels: { sessionId: string; deferred: boolean }[];
      };
      const busyRow = snap.channels.find((c) => c.sessionId === s2.sessionId);
      expect(busyRow).toBeDefined();
      expect(busyRow!.deferred).toBe(false);

      // The full close-all defers the busy one.
      const allRes = (await emitAck(browser, 'chat:channels.closeAll', {})) as {
        closed: number;
        deferred: number;
      };
      expect(allRes).toEqual({ closed: 0, deferred: 1 });
      snap = (await emitAck(browser, 'chat:channels.sync', {})) as {
        channels: { sessionId: string; deferred: boolean }[];
      };
      expect(snap.channels.find((c) => c.sessionId === s2.sessionId)?.deferred).toBe(true);

      // Let it finish so the table clears for the next test.
      void d.emit('chat:event', {
        sessionId: s2.sessionId,
        event: { kind: 'session_status', state: 'idle' },
      });
      await once(browser, 'chat:session.closed');
    } finally {
      d.disconnect();
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 15000);

  it('the snapshot carries lastActiveAt and the turn end advances it', async () => {
    const d = await connectDaemon(['chat']);
    try {
      const startP = once(d, 'chat:session.start');
      const res = await openSession(browser, agentId);
      const start = (await startP) as { sessionId: string };
      const readyP = once(browser, 'chat:session.ready');
      readyFor(d, start);
      await readyP;

      const before = (await emitAck(browser, 'chat:channels.sync', {})) as {
        channels: { sessionId: string; openedAt: number; lastActiveAt: number }[];
      };
      const row = before.channels.find((c) => c.sessionId === res.sessionId);
      expect(row).toBeDefined();
      expect(row!.lastActiveAt).toBe(row!.openedAt);

      await new Promise((r) => setTimeout(r, 30));
      void d.emit('chat:event', {
        sessionId: start.sessionId,
        event: { kind: 'session_status', state: 'active' },
      });
      void d.emit('chat:event', {
        sessionId: start.sessionId,
        event: { kind: 'session_status', state: 'idle' },
      });
      const after = (await emitAck(browser, 'chat:channels.sync', {})) as {
        channels: { sessionId: string; openedAt: number; lastActiveAt: number }[];
      };
      const row2 = after.channels.find((c) => c.sessionId === res.sessionId);
      expect(row2!.lastActiveAt).toBeGreaterThan(row2!.openedAt);
      await emitAck(browser, 'chat:session.close', { sessionId: res.sessionId! });
    } finally {
      d.disconnect();
      await new Promise((r) => setTimeout(r, 150));
    }
  }, 15000);

  it('CHAT_IDLE_TTL_MS (enabled) closes stale idle channels, never busy ones', async () => {
    const app2 = await buildApp(testConfig({ chatIdleTtlMs: 150 }));
    await app2.listen({ port: 0, host: '127.0.0.1' });
    const addr = app2.server.address() as { port: number };
    const base2 = `http://127.0.0.1:${addr.port}`;
    try {
      const reg = await app2.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: 'idler', password: 'hunter2hunter2' },
      });
      const jwt2 = reg.json().token as string;
      const enroll = await app2.inject({
        method: 'POST',
        url: '/api/machines',
        headers: { authorization: `Bearer ${jwt2}` },
        payload: { name: 'idle-box' },
      });
      const mid = enroll.json().machine.id as string;
      const mtoken = enroll.json().token as string;
      await app2.inject({
        method: 'PATCH',
        url: `/api/machines/${mid}`,
        headers: { authorization: `Bearer ${jwt2}` },
        payload: { remoteChatEnabled: true },
      });
      const now = new Date().toISOString();
      await app2.uow.agentInstances.save({
        id: 'agent-idle-1',
        machineId: mid,
        ownerId: (await app2.uow.users.findByUsername('idler'))!.id,
        target: 'hermes',
        profileId: 'p1',
        profileVersion: '1.0.0',
        name: 'idle agent',
        directory: '/home/tester/.hermes',
        jobId: 'j1',
        createdAt: now,
        updatedAt: now,
      });
      const b = io(`${base2}/app`, { auth: { token: jwt2 }, transports: ['websocket'] });
      const d = io(`${base2}/ctl`, {
        auth: { token: mtoken, machineId: mid },
        transports: ['websocket'],
      });
      d.on('chat:reconcile', (_p: unknown, ack?: (r: unknown) => void) => ack?.({ held: [] }));
      await Promise.all([once(b, 'connect'), once(d, 'connect')]);
      await emitAck(d, 'machine:hello', {
        daemonVersion: '0.15.0-test',
        capabilities: ['chat'],
      });
      try {
        const s1P = once(d, 'chat:session.start');
        const ack1 = (await emitAck(b, 'chat:session.open', {
          agentInstanceId: 'agent-idle-1',
        })) as { sessionId?: string };
        const s1 = (await s1P) as { sessionId: string };
        void d.emit('chat:session.ready', { sessionId: s1.sessionId, agentName: 'fixture-agent' });
        await once(b, 'chat:session.ready');
        // Second channel goes BUSY — the sweep must never touch it.
        const s2P = once(d, 'chat:session.start');
        const ack2 = (await emitAck(b, 'chat:session.open', {
          agentInstanceId: 'agent-idle-1',
        })) as { sessionId?: string };
        const s2 = (await s2P) as { sessionId: string };
        void d.emit('chat:session.ready', { sessionId: s2.sessionId, agentName: 'fixture-agent' });
        void d.emit('chat:event', {
          sessionId: s2.sessionId,
          event: { kind: 'session_status', state: 'active' },
        });
        expect(ack1.sessionId).toBeDefined();
        expect(ack2.sessionId).toBeDefined();

        const closedP = once(b, 'chat:session.closed', 6000);
        const closed = (await closedP) as { sessionId: string; reason: string };
        expect(closed.sessionId).toBe(s1.sessionId);
        expect(closed.reason).toBe('idle-timeout');
        await new Promise((r) => setTimeout(r, 400));
        const snap = (await emitAck(b, 'chat:channels.sync', {})) as {
          channels: { sessionId: string }[];
        };
        expect(snap.channels.some((c) => c.sessionId === s2.sessionId)).toBe(true);
      } finally {
        b.disconnect();
        d.disconnect();
        await new Promise((r) => setTimeout(r, 150));
      }
    } finally {
      await app2.close();
    }
  }, 20000);
});

describe('adapter pre-warm (issue #3)', () => {
  let prewarmDaemon: Socket;
  const prewarmEvents: { target: string }[] = [];

  beforeAll(async () => {
    // A deepseek agent (a PREWARM target — the hermes fixture agent is not)
    // and an opencode one (#4 — the fourth pool target, default OFF).
    const now = new Date().toISOString();
    await app.uow.agentInstances.save({
      id: 'agent-dsh-1',
      machineId,
      ownerId: (await app.uow.users.findByUsername('chatter'))!.id,
      target: 'deepseek',
      profileId: 'profile-dsh-1',
      profileVersion: '1.0.0',
      name: 'dsh agent',
      directory: '/home/tester/.dsh',
      jobId: 'job-dsh-1',
      createdAt: now,
      updatedAt: now,
    });
    await app.uow.agentInstances.save({
      id: 'agent-oc-1',
      machineId,
      ownerId: (await app.uow.users.findByUsername('chatter'))!.id,
      target: 'opencode',
      profileId: 'profile-oc-1',
      profileVersion: '1.0.0',
      name: 'opencode agent',
      directory: '/home/tester/.config/opencode',
      jobId: 'job-oc-1',
      createdAt: now,
      updatedAt: now,
    });
    prewarmDaemon = await connectDaemon(['chat']);
    prewarmDaemon.on('chat:adapter.prewarm', (payload: unknown) => {
      prewarmEvents.push(payload as { target: string });
    });
  });
  afterAll(() => {
    prewarmDaemon?.close();
  });

  it('machine PATCH: owner writes the map, foreign user 404s, other fields keep it', async () => {
    // Absent on untouched machines — readers apply the defaults.
    const read = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}`,
      headers: authed(jwt),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().machine.chatPrewarm).toBeUndefined();

    // A foreign (non-owner, non-admin) user cannot even see the machine.
    const second = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'prewarm-peasant', password: 'hunter2hunter2' },
    });
    expect(second.statusCode).toBe(201);
    const foreign = await app.inject({
      method: 'PATCH',
      url: `/api/machines/${machineId}`,
      headers: authed(second.json().token),
      payload: {
        chatPrewarm: { 'claude-code': true, codex: true, deepseek: true, opencode: true },
      },
    });
    expect(foreign.statusCode).toBe(404);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/machines/${machineId}`,
      headers: authed(jwt),
      payload: {
        chatPrewarm: { 'claude-code': false, codex: false, deepseek: false, opencode: false },
      },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().machine.chatPrewarm).toEqual({
      'claude-code': false,
      codex: false,
      deepseek: false,
      opencode: false,
    });

    // An unrelated machine PATCH must not drop the map.
    const rename = await app.inject({
      method: 'PATCH',
      url: `/api/machines/${machineId}`,
      headers: authed(jwt),
      payload: { name: 'chat-box-2' },
    });
    expect(rename.statusCode).toBe(200);
    expect(rename.json().machine.chatPrewarm.deepseek).toBe(false);
    // A legacy 3-key payload is a replace against a strict schema → rejected,
    // not silently defaulted (the web normalizes with defaults before sending).
    const legacy = await app.inject({
      method: 'PATCH',
      url: `/api/machines/${machineId}`,
      headers: authed(jwt),
      payload: { chatPrewarm: { 'claude-code': false, codex: false, deepseek: true } },
    });
    expect(legacy.statusCode).toBe(400);
  });

  it('prewarm socket: off → PREWARM_DISABLED; on → /ctl nudge; start stamped', async () => {
    // Switch is OFF from the previous test.
    const off = (await emitAck(browser, 'chat:adapter.prewarm', {
      agentInstanceId: 'agent-dsh-1',
    })) as { accepted: boolean; error?: string };
    expect(off.accepted).toBe(false);
    expect(off.error).toBe('PREWARM_DISABLED');
    expect(prewarmEvents.length).toBe(0);

    // Unsupported target never reaches the daemon either.
    const hermes = (await emitAck(browser, 'chat:adapter.prewarm', {
      agentInstanceId: agentId,
    })) as { accepted: boolean; error?: string };
    expect(hermes.accepted).toBe(false);
    expect(hermes.error).toBe('PREWARM_UNSUPPORTED_TARGET');

    // Foreign agent → hidden as not-found.
    expect(
      (
        (await emitAck(browser, 'chat:adapter.prewarm', {
          agentInstanceId: 'agent-of-nobody',
        })) as { accepted: boolean }
      ).accepted,
    ).toBe(false);

    // Switch ON → accepted and the daemon got the nudge.
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/machines/${machineId}`,
      headers: authed(jwt),
      payload: {
        chatPrewarm: { 'claude-code': false, codex: false, deepseek: true, opencode: false },
      },
    });
    expect(patch.statusCode).toBe(200);
    const on = (await emitAck(browser, 'chat:adapter.prewarm', {
      agentInstanceId: 'agent-dsh-1',
    })) as { accepted: boolean };
    expect(on.accepted).toBe(true);
    await waitFor(() => (prewarmEvents.length > 0 ? true : undefined));
    expect(prewarmEvents[0]).toEqual({ target: 'deepseek' });

    // #4 — opencode rides the same gate; its own switch is independent.
    const ocOff = (await emitAck(browser, 'chat:adapter.prewarm', {
      agentInstanceId: 'agent-oc-1',
    })) as { accepted: boolean; error?: string };
    expect(ocOff.accepted).toBe(false);
    expect(ocOff.error).toBe('PREWARM_DISABLED');
    const ocPatch = await app.inject({
      method: 'PATCH',
      url: `/api/machines/${machineId}`,
      headers: authed(jwt),
      payload: {
        chatPrewarm: { 'claude-code': false, codex: false, deepseek: true, opencode: true },
      },
    });
    expect(ocPatch.statusCode).toBe(200);
    const ocOn = (await emitAck(browser, 'chat:adapter.prewarm', {
      agentInstanceId: 'agent-oc-1',
    })) as { accepted: boolean };
    expect(ocOn.accepted).toBe(true);
    await waitFor(() => (prewarmEvents.length > 1 ? true : undefined));
    expect(prewarmEvents[1]).toEqual({ target: 'opencode' });

    // An open on a prewarm-ON target stamps `prewarm: true` on the start.
    const starts: { target: string; prewarm?: boolean }[] = [];
    prewarmDaemon.on('chat:session.start', (payload: unknown) => {
      starts.push(payload as { target: string; prewarm?: boolean });
    });
    const open = await openSession(browser, 'agent-dsh-1');
    expect(open.sessionId).toBeDefined();
    await waitFor(() => (starts.length > 0 ? true : undefined));
    expect(starts[0]!.target).toBe('deepseek');
    expect(starts[0]!.prewarm).toBe(true);
    await emitAck(browser, 'chat:session.close', { sessionId: open.sessionId });
  });

  it('restore the defaults for other suites', async () => {
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/machines/${machineId}`,
      headers: authed(jwt),
      payload: {
        chatPrewarm: { 'claude-code': false, codex: false, deepseek: true, opencode: false },
      },
    });
    expect(patch.statusCode).toBe(200);
  });
});
