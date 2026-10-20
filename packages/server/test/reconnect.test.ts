// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import type { FastifyInstance } from 'fastify';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import { buildApp } from '../src/app.js';
import { ChatService, type ChatIO } from '../src/realtime/chat.js';
import { emitAck, once, testConfig, waitFor } from './helpers.js';

/**
 * #66 — reconnect recovery on the machine rail: the /app VIEWER grace (the
 * browser twin of the /ctl ReconnectGuard), the reattach defer-clear, the
 * control-verb presence gate, and the parked-prompt offline guard + reflush.
 *
 * The integration arm uses blip sockets (`reconnection: false`) —
 * `engine.close()` on them is a one-way transport drop, exactly the weak-
 * network/lock-screen shape; "the SPA reconnects" is modeled by a FRESH
 * socket (a new connection is what a socket.io reconnect is). The flush
 * guard is driven at the service level: the socket-level race it guards is
 * hair-thin (packets only arrive while connected), but the guard must hold
 * when it happens.
 */

const VIEWER_GRACE_MS = 400;

let app: FastifyInstance;
let baseUrl: string;
let jwt: string;
let userId: string;
let machineId: string;
let machineToken: string;
const agentId = 'agent-recon-1';
let daemon: Socket | null = null;

const authed = (token: string): { authorization: string } => ({ authorization: `Bearer ${token}` });

/** A socket that CANNOT auto-reconnect — engine.close() on it is a blip. */
const blip = async (ns: '/ctl' | '/app', token: string): Promise<Socket> => {
  const sock = io(`${baseUrl}${ns}`, {
    auth: ns === '/ctl' ? { token, machineId } : { token },
    transports: ['websocket'],
    reconnection: false,
    // socket.io-client caches Managers per URL — WITHOUT forceNew, the /app
    // and /ctl sockets of this suite would share ONE engine, and killing a
    // blipped viewer would take the daemon socket down with it.
    forceNew: true,
  });
  await once(sock, 'connect');
  return sock;
};

const engineKill = (sock: Socket): void => {
  (sock.io as unknown as { engine: { close(): void } }).engine.close();
};

/**
 * One daemon socket at a time (#45); always a blip socket, chat-capable.
 * `heldIds` feeds the reconcile ack — a reconnecting daemon that acks the
 * live channels as held keeps them alive (retainOnly drops only ghosts).
 */
const connectDaemon = async (heldIds: () => string[] = () => []): Promise<Socket> => {
  if (daemon !== null) {
    daemon.disconnect();
    await waitFor(() => !app.realtime.presence.isOnline(machineId));
  }
  const sock = await blip('/ctl', machineToken);
  sock.on('chat:reconcile', (_p: unknown, ack?: (res: unknown) => void) =>
    ack?.({ held: heldIds() }),
  );
  await emitAck(sock, 'machine:hello', {
    daemonVersion: '0.14.0-test',
    capabilities: ['chat'],
  });
  daemon = sock;
  return sock;
};

const openSession = async (
  sock: Socket,
  rejoinId?: string,
): Promise<{ sessionId?: string; phase?: string; error?: string }> =>
  (await emitAck(sock, 'chat:session.open', {
    agentInstanceId: agentId,
    ...(rejoinId !== undefined ? { sessionId: rejoinId } : {}),
  })) as {
    sessionId?: string;
    phase?: string;
    error?: string;
  };

/** Open a channel and drive it to ready against the current daemon socket. */
const openReady = async (sock: Socket, d: Socket): Promise<string> => {
  const startP = once(d, 'chat:session.start');
  const res = await openSession(sock);
  expect(res.error).toBeUndefined();
  const start = (await startP) as { sessionId: string };
  const readyP = once(sock, 'chat:session.ready');
  void d.emit('chat:session.ready', {
    sessionId: start.sessionId,
    agentName: 'fixture-agent',
    agentVersion: '0.1.0',
  });
  await readyP;
  return start.sessionId;
};

const statusEvent = (sessionId: string, state: 'active' | 'idle'): void => {
  void daemon?.emit('chat:event', { sessionId, event: { kind: 'session_status', state } });
};

/**
 * Record the daemon-told closes for ONE channel. Session-scoped on purpose:
 * a previous test's close packet can be delivered late (the ack and the
 * daemon-side emit ride different sockets — no ordering), and it must not
 * pollute this test's absence assertions.
 */
const trackCloses = (d: Socket, sessionId: string): { closed: () => string[]; off: () => void } => {
  const seen: string[] = [];
  const onClose = (p: unknown): void => {
    const row = p as { sessionId?: string; reason?: string };
    if (row.sessionId === sessionId) seen.push(row.reason ?? '');
  };
  d.on('chat:session.close', onClose);
  return { closed: () => seen, off: () => d.off('chat:session.close', onClose) };
};

beforeAll(async () => {
  app = await buildApp(
    testConfig({
      chatReadyTimeoutMs: 2500,
      // The /ctl axis must NEVER fire inside these tests — the viewer axis
      // under test is being isolated from daemon-blip reaping.
      chatReconnectGraceMs: 60_000,
      chatViewerGraceMs: VIEWER_GRACE_MS,
    }),
  );
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;

  const reg = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'reconnector', password: 'hunter2hunter2' },
  });
  jwt = reg.json().token;
  userId = (await app.uow.users.findByUsername('reconnector'))!.id;

  const enroll = await app.inject({
    method: 'POST',
    url: '/api/machines',
    headers: authed(jwt),
    payload: { name: 'recon-box' },
  });
  machineId = enroll.json().machine.id;
  machineToken = enroll.json().token;

  const now = new Date().toISOString();
  await app.uow.machines.save({
    ...(await app.uow.machines.findById(machineId))!,
    remoteChatEnabled: true,
    capabilities: ['chat'],
  });
  await app.uow.agentInstances.save({
    id: agentId,
    machineId,
    ownerId: userId,
    target: 'hermes',
    profileId: 'profile-recon-1',
    profileVersion: '1.0.0',
    name: 'recon agent',
    directory: '/home/tester/.hermes',
    jobId: 'job-recon-1',
    createdAt: now,
    updatedAt: now,
  });

  await connectDaemon();
}, 20000);

afterAll(async () => {
  daemon?.disconnect();
  await app.close();
});

describe('#66 /app viewer grace', () => {
  it('an idle channel survives a blip inside the window and is reaped at expiry', async () => {
    const d = daemon!;
    const b = await blip('/app', jwt);
    const sessionId = await openReady(b, d);
    const track = trackCloses(d, sessionId);

    // The blip: the user's last socket drops transport-side.
    engineKill(b);
    // Inside the window: no reap yet.
    await new Promise((r) => setTimeout(r, VIEWER_GRACE_MS / 2));
    expect(track.closed()).toEqual([]);
    // Past the window: the delayed reap closes the channel.
    await waitFor(() => track.closed().length > 0, 4000);
    expect(track.closed()).toEqual(['connection-lost']);
    track.off();
  }, 15000);

  it('a reconnect inside the window cancels the reap and the rejoin continues the channel', async () => {
    const d = daemon!;
    const b = await blip('/app', jwt);
    const sessionId = await openReady(b, d);
    const track = trackCloses(d, sessionId);
    engineKill(b);
    await new Promise((r) => setTimeout(r, VIEWER_GRACE_MS / 4));

    // The SPA "reconnects" — a fresh socket for the same user cancels the
    // armed reap (onViewerBack) and the tab bar snapshot shows the channel.
    const b2 = await blip('/app', jwt);
    const snap = (await emitAck(b2, 'chat:channels.sync', {})) as {
      channels: { sessionId: string }[];
    };
    expect(snap.channels.some((c) => c.sessionId === sessionId)).toBe(true);

    // Past the ORIGINAL expiry: still alive (canceled, not just delayed).
    await new Promise((r) => setTimeout(r, VIEWER_GRACE_MS));
    expect(track.closed()).toEqual([]);
    // Rejoin drives the resync round-trip and a send lands at the daemon.
    const resyncP = once(d, 'chat:session.resync');
    const rejoin = await openSession(b2, sessionId);
    expect(rejoin.sessionId).toBe(sessionId);
    expect(rejoin.phase).toBe('ready');
    expect(((await resyncP) as { sessionId: string }).sessionId).toBe(sessionId);
    const promptP = once(d, 'chat:message.send');
    const ack = await emitAck(b2, 'chat:message.send', { sessionId, content: 'back again' });
    expect(ack).toEqual({ accepted: true, queued: false });
    expect(((await promptP) as { sessionId: string }).sessionId).toBe(sessionId);

    await emitAck(b2, 'chat:session.close', { sessionId, reason: 'user' });
    b2.disconnect();
    track.off();
  }, 15000);

  it('a busy channel defers at expiry, and a reattaching viewer REVOKES the defer', async () => {
    const d = daemon!;
    const b = await blip('/app', jwt);
    const sessionId = await openReady(b, d);
    const track = trackCloses(d, sessionId);

    // Mid-turn: the viewer blips out; at expiry the busy channel only DEFERS.
    const busySeen = once(b, 'chat:event');
    statusEvent(sessionId, 'active');
    await busySeen;
    engineKill(b);
    await new Promise((r) => setTimeout(r, VIEWER_GRACE_MS * 2));
    // Deferred, not closed — nothing reached the daemon.
    expect(track.closed()).toEqual([]);

    // The viewer returns and rejoins — the defer flag must be CLEARED, so
    // the turn's end does NOT close the channel out from under them.
    const b2 = await blip('/app', jwt);
    const rejoin = await openSession(b2, sessionId);
    expect(rejoin.sessionId).toBe(sessionId);
    statusEvent(sessionId, 'idle');
    await new Promise((r) => setTimeout(r, 600));
    expect(track.closed()).toEqual([]);

    const snap = (await emitAck(b2, 'chat:channels.sync', {})) as {
      channels: { sessionId: string }[];
    };
    expect(snap.channels.some((c) => c.sessionId === sessionId)).toBe(true);

    await emitAck(b2, 'chat:session.close', { sessionId, reason: 'user' });
    b2.disconnect();
    track.off();
  }, 20000);
});

describe('#66 control-verb presence gate', () => {
  it('user verbs bounce MACHINE_OFFLINE while the daemon socket is down, then work again', async () => {
    const d = await connectDaemon();
    const b = await blip('/app', jwt);
    const sessionId = await openReady(b, d);
    const track = trackCloses(d, sessionId);

    // A permission card is live when the daemon blips out.
    const cardP = once(b, 'chat:event');
    void d.emit('chat:event', {
      sessionId,
      event: {
        kind: 'permission_request',
        requestId: 'perm-gate',
        toolCall: { toolCallId: 't1', title: 'run fixture tool', kind: 'execute' },
        options: [
          { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
        ],
      },
    });
    await cardP;

    // The daemon drops transport-side (channels survive the /ctl grace;
    // presence flips immediately).
    engineKill(d);
    await waitFor(() => !app.realtime.presence.isOnline(machineId));

    expect(await emitAck(b, 'chat:message.send', { sessionId, content: 'lost?' })).toEqual({
      error: 'MACHINE_OFFLINE',
    });
    expect(await emitAck(b, 'chat:turn.cancel', { sessionId })).toEqual({
      error: 'MACHINE_OFFLINE',
    });
    expect(
      await emitAck(b, 'chat:config.set', { sessionId, kind: 'mode', modeId: 'default' }),
    ).toEqual({ error: 'MACHINE_OFFLINE' });
    expect(
      await emitAck(b, 'chat:permission.respond', { sessionId, requestId: 'perm-gate' }),
    ).toEqual({ error: 'MACHINE_OFFLINE' });

    // The daemon returns: it acks the live channel as held (reconcile keeps
    // it), and the verbs work again.
    const d2 = await connectDaemon(() => [sessionId]);
    await waitFor(() => app.realtime.presence.isOnline(machineId));
    expect(track.closed()).toEqual([]);
    const resyncP = once(d2, 'chat:session.resync');
    const rejoin = await openSession(b, sessionId);
    expect(rejoin.sessionId).toBe(sessionId);
    expect(((await resyncP) as { sessionId: string }).sessionId).toBe(sessionId);
    const promptP = once(d2, 'chat:message.send');
    const ack = await emitAck(b, 'chat:message.send', { sessionId, content: 'works' });
    expect(ack).toEqual({ accepted: true, queued: false });
    expect(((await promptP) as { sessionId: string }).sessionId).toBe(sessionId);

    await emitAck(b, 'chat:session.close', { sessionId, reason: 'user' });
    b.disconnect();
    track.off();
  }, 20000);
});

describe('#66 queued-prompt offline guard + reflush (service level)', () => {
  const ctl: { machineId: string; event: string; payload: unknown }[] = [];
  let online = true;
  let svc: ChatService;

  beforeAll(async () => {
    const uow = createMemoryUnitOfWork();
    const now = '2026-01-01T00:00:00.000Z';
    await uow.users.save({
      id: 'u-flush',
      username: 'flusher',
      email: null,
      passwordHash: null,
      role: 'user',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await uow.machines.save({
      id: 'm-flush',
      ownerId: 'u-flush',
      name: 'flush-box',
      hostname: null,
      os: null,
      arch: null,
      daemonVersion: null,
      capabilities: ['chat'],
      remoteChatEnabled: true,
      baseWorkspace: null,
      enrollmentPatId: 'pat-flush',
      enrolledAt: now,
      lastSeenAt: null,
      createdAt: now,
      updatedAt: now,
    });
    await uow.agentInstances.save({
      id: 'a-flush',
      machineId: 'm-flush',
      ownerId: 'u-flush',
      target: 'hermes',
      profileId: 'p',
      profileVersion: '1',
      name: 'flush agent',
      directory: '/tmp',
      jobId: null,
      source: 'deploy',
      createdAt: now,
      updatedAt: now,
    });

    const ioStub: ChatIO = {
      toCtl: (machineId, event, payload) => ctl.push({ machineId, event, payload }),
      toChannel: () => undefined,
      toUser: () => undefined,
      joinChannel: () => undefined,
      isAppSocketLive: () => true,
      userSockets: async () => ['sock-1'],
    };
    svc = new ChatService(
      { uow, isOnline: () => online, io: ioStub },
      {
        maxSessionsPerMachine: 2,
        maxActiveSessionsPerMachine: 1,
        permissionTimeoutMs: 60_000,
        readyTimeoutMs: 5_000,
        idleTtlMs: 0,
        viewerGraceMs: 0,
      },
    );
  });

  it('an idle transition while offline re-parks the prompt; machine-online reflushes it', async () => {
    const opened = await svc.open('u-flush', 'a-flush', undefined, 'sock-1', undefined, undefined);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const sessionId = opened.sessionId;
    await svc.onReady('m-flush', { sessionId });

    await svc.onStream('m-flush', sessionId, { kind: 'session_status', state: 'active' });
    // Busy: the send parks in the depth-1 slot.
    expect(await svc.onMessageSend('u-flush', sessionId, 'parked prompt')).toEqual({
      ok: true,
      queued: true,
    });

    // The daemon drops; the idle transition is processed while OFFLINE. The
    // flush must NOT fire into a dead room emit — the prompt stays parked.
    online = false;
    await svc.onStream('m-flush', sessionId, { kind: 'session_status', state: 'idle' });
    const flushesBefore = ctl.filter(
      (c) =>
        c.event === 'chat:message.send' &&
        (c.payload as { sessionId: string }).sessionId === sessionId,
    ).length;
    expect(flushesBefore).toBe(0);

    // The daemon returns: the parked prompt flushes without a new prompt.
    online = true;
    svc.onMachineOnline('m-flush');
    const flushes = ctl.filter(
      (c) =>
        c.event === 'chat:message.send' &&
        (c.payload as { sessionId: string }).sessionId === sessionId,
    );
    expect(flushes.length).toBe(1);
    expect((flushes[0]!.payload as { prompt: { type: string; text: string }[] }).prompt).toEqual([
      { type: 'text', text: 'parked prompt' },
    ]);
  });
});
