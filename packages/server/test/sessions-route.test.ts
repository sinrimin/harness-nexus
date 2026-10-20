// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { testConfig } from './helpers.js';

/**
 * Native session listing round-trip (Phase 9 W7): the REST route rides
 * `sessions:list` over /ctl to the daemon and returns the AGENT'S OWN
 * sessions — plus the gates (offline, capability, timeout, daemon error arm,
 * unsupported target, ownership).
 */

let app: FastifyInstance;
let baseUrl: string;
let ownerJwt: string;
let strangerJwt: string;
let machineId: string;
let machineToken: string;
let agentId: string;
let daemon: Socket;

const auth = (t: string): { authorization: string } => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  app = await buildApp(testConfig({ sessionsListTimeoutMs: 500 }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;

  for (const [username, key] of [
    ['w7owner', 'ownerJwt'],
    ['w7stranger', 'strangerJwt'],
  ] as const) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username, password: 'hunter2hunter2' },
    });
    if (key === 'ownerJwt') ownerJwt = res.json().token;
    else strangerJwt = res.json().token;
  }
  const enroll = await app.inject({
    method: 'POST',
    url: '/api/machines',
    headers: auth(ownerJwt),
    payload: { name: 'w7-box' },
  });
  machineId = enroll.json().machine.id;
  machineToken = enroll.json().token;

  const now = new Date().toISOString();
  const ownerId = (await app.uow.users.findByUsername('w7owner'))!.id;
  await app.uow.agentInstances.save({
    id: 'agent-w7-1',
    machineId,
    ownerId,
    target: 'claude-code',
    profileId: null,
    profileVersion: null,
    name: 'w7 agent',
    directory: '/home/w7/.claude',
    jobId: null,
    source: 'detected',
    createdAt: now,
    updatedAt: now,
  });
  agentId = 'agent-w7-1';
});

afterAll(async () => {
  daemon?.disconnect();
  await app.close();
});

/** Connect a fake daemon with the given capabilities + sessions responder. */
async function connectDaemon(
  capabilities: string[],
  respond: (target: string) => Record<string, unknown>,
  onDelete?: (payload: { requestId: string; target: string; sessionId: string }) => void,
): Promise<void> {
  daemon = io(`${baseUrl}/ctl`, {
    auth: { token: machineToken, machineId },
    transports: ['websocket'],
  });
  await new Promise<void>((resolve) => {
    daemon.on('connect', () => {
      daemon.emit('machine:hello', { daemonVersion: 'test', capabilities }, () => resolve());
    });
  });
  daemon.on('sessions:list', (payload: { requestId: string; target: string }) => {
    daemon.emit('sessions:list:result', {
      requestId: payload.requestId,
      ...respond(payload.target),
    });
  });
  if (onDelete !== undefined) {
    daemon.on(
      'sessions:delete',
      (payload: { requestId: string; target: string; sessionId: string }) => {
        onDelete(payload);
        daemon.emit('sessions:delete:result', { requestId: payload.requestId });
      },
    );
  }
}

describe('GET /api/agent-instances/:id/sessions (9 W7)', () => {
  it('404s for strangers and 409s while offline', async () => {
    const stranger = await app.inject({
      method: 'GET',
      url: `/api/agent-instances/${agentId}/sessions`,
      headers: auth(strangerJwt),
    });
    expect(stranger.statusCode).toBe(404);
    const offline = await app.inject({
      method: 'GET',
      url: `/api/agent-instances/${agentId}/sessions`,
      headers: auth(ownerJwt),
    });
    expect(offline.statusCode).toBe(409);
    expect(offline.json().error).toBe('MACHINE_OFFLINE');
  });

  it('409s when the daemon lacks the sessions capability', async () => {
    await connectDaemon(['chat'], () => ({ sessions: [] }));
    const res = await app.inject({
      method: 'GET',
      url: `/api/agent-instances/${agentId}/sessions`,
      headers: auth(ownerJwt),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('DAEMON_NO_SESSIONS');
    daemon.disconnect();
    await new Promise((r) => setTimeout(r, 150));
  });

  it('round-trips the daemon listing (target rides the /ctl event)', async () => {
    await connectDaemon(['sessions'], (target) => ({
      sessions: [
        {
          sessionId: `native-${target}-1`,
          cwd: '/home/w7/projects/alpha',
          title: 'prior turn',
          updatedAt: '2026-09-10T00:00:00.000Z',
        },
      ],
    }));
    const res = await app.inject({
      method: 'GET',
      url: `/api/agent-instances/${agentId}/sessions`,
      headers: auth(ownerJwt),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      agent: expect.objectContaining({ id: agentId }),
      supported: true,
      sessions: [
        {
          sessionId: 'native-claude-code-1',
          cwd: '/home/w7/projects/alpha',
          title: 'prior turn',
          updatedAt: '2026-09-10T00:00:00.000Z',
          // Post-W8: every row carries the server-computed channel flag.
          open: false,
        },
      ],
    });
    daemon.disconnect();
    await new Promise((r) => setTimeout(r, 150));
  });

  it('rides ?refresh=1 through to the daemon as `refresh` (9 W11 D cache bypass)', async () => {
    const seen: { refresh?: boolean }[] = [];
    await connectDaemon(['sessions'], () => ({ sessions: [] }));
    daemon.removeAllListeners('sessions:list');
    daemon.on('sessions:list', (payload: { requestId: string; refresh?: boolean }) => {
      seen.push({ ...('refresh' in payload ? { refresh: payload.refresh } : {}) });
      daemon.emit('sessions:list:result', { requestId: payload.requestId, sessions: [] });
    });
    const plain = await app.inject({
      method: 'GET',
      url: `/api/agent-instances/${agentId}/sessions`,
      headers: auth(ownerJwt),
    });
    expect(plain.statusCode).toBe(200);
    const bypass = await app.inject({
      method: 'GET',
      url: `/api/agent-instances/${agentId}/sessions?refresh=1`,
      headers: auth(ownerJwt),
    });
    expect(bypass.statusCode).toBe(200);
    expect(seen).toEqual([{}, { refresh: true }]);
    daemon.disconnect();
    await new Promise((r) => setTimeout(r, 150));
  });

  it('accepts an RFC3339 +00:00 updatedAt (codex-acp/chrono dialect, rig-found)', async () => {
    // codex-acp serializes timestamps as `…+00:00`, not `…Z`. The strict
    // datetime schema used to reject the WHOLE result payload, the waiter
    // resolved nothing, and the route 504'd with "Daemon did not answer the
    // listing in time" while the daemon had actually answered in ~2s.
    await connectDaemon(['sessions'], () => ({
      sessions: [
        {
          sessionId: 'native-codex-1',
          cwd: '/root/projects/demo-api',
          title: '你好',
          updatedAt: '2026-09-14T07:32:10.868+00:00',
        },
      ],
    }));
    const res = await app.inject({
      method: 'GET',
      url: `/api/agent-instances/${agentId}/sessions`,
      headers: auth(ownerJwt),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sessions[0]).toMatchObject({
      sessionId: 'native-codex-1',
      updatedAt: '2026-09-14T07:32:10.868+00:00',
    });
    daemon.disconnect();
    await new Promise((r) => setTimeout(r, 150));
  });

  it('marks rows whose native session holds a live channel (open/openChannelId)', async () => {
    await connectDaemon(['sessions', 'chat'], () => ({
      sessions: [
        { sessionId: 'native-live', cwd: '/home/w7/projects/alpha', title: 'live one' },
        { sessionId: 'native-idle', cwd: '/home/w7/projects/alpha', title: 'idle one' },
      ],
    }));
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/machines/${machineId}`,
      headers: auth(ownerJwt),
      payload: { remoteChatEnabled: true },
    });
    expect(patch.json().machine.remoteChatEnabled).toBe(true);

    // Open a channel whose native session is one of the listed rows.
    const browser = io(`${baseUrl}/app`, { auth: { token: ownerJwt }, transports: ['websocket'] });
    await new Promise<void>((resolve) => browser.on('connect', () => resolve()));
    const startP = new Promise<{ sessionId: string }>((resolve) => {
      daemon.on('chat:session.start', (p: { sessionId: string }) => resolve(p));
    });
    const openAck = (await new Promise((resolve) => {
      browser.emit('chat:session.open', { agentInstanceId: agentId }, resolve);
    })) as { sessionId: string };
    const start = await startP;
    const readyP = new Promise<void>((resolve) => {
      browser.on('chat:session.ready', () => resolve());
    });
    daemon.emit('chat:session.ready', {
      sessionId: start.sessionId,
      nativeSessionId: 'native-live',
    });
    await readyP;

    const res = await app.inject({
      method: 'GET',
      url: `/api/agent-instances/${agentId}/sessions`,
      headers: auth(ownerJwt),
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().sessions as {
      sessionId: string;
      open: boolean;
      openChannelId?: string;
    }[];
    expect(rows.find((s) => s.sessionId === 'native-live')).toMatchObject({
      open: true,
      openChannelId: openAck.sessionId,
    });
    expect(rows.find((s) => s.sessionId === 'native-idle')).toMatchObject({ open: false });

    // A channel whose native session has NO transcript yet (claude-code
    // materializes one only on the first message) still shows up: the route
    // synthesizes an open row from the channel itself.
    const startP2 = new Promise<{ sessionId: string }>((resolve) => {
      daemon.on('chat:session.start', (p: { sessionId: string }) => resolve(p));
    });
    const open2Ack = (await new Promise((resolve) => {
      browser.emit('chat:session.open', { agentInstanceId: agentId }, resolve);
    })) as { sessionId: string };
    const start2 = await startP2;
    const ready2P = new Promise<void>((resolve) => {
      browser.on('chat:session.ready', () => resolve());
    });
    daemon.emit('chat:session.ready', {
      sessionId: start2.sessionId,
      nativeSessionId: 'native-ghost',
    });
    await ready2P;

    const res2 = await app.inject({
      method: 'GET',
      url: `/api/agent-instances/${agentId}/sessions`,
      headers: auth(ownerJwt),
    });
    const ghost = (
      res2.json().sessions as {
        sessionId: string;
        open: boolean;
        openChannelId?: string;
        cwd: string;
      }[]
    ).find((s) => s.sessionId === 'native-ghost');
    expect(ghost).toMatchObject({
      open: true,
      openChannelId: open2Ack.sessionId,
      cwd: '/home/w7/.claude', // the agent's directory — where the channel was opened
    });

    await new Promise((resolve) => {
      browser.emit('chat:session.close', { sessionId: start.sessionId, reason: 'user' }, resolve);
    });
    await new Promise((resolve) => {
      browser.emit('chat:session.close', { sessionId: start2.sessionId, reason: 'user' }, resolve);
    });
    browser.close();
    daemon.disconnect();
    await new Promise((r) => setTimeout(r, 150));
  }, 20000);

  it('surfaces an unsupported target and maps the error/timeout arms', async () => {
    await connectDaemon(['sessions'], () => ({ supported: false }));
    const unsupported = await app.inject({
      method: 'GET',
      url: `/api/agent-instances/${agentId}/sessions`,
      headers: auth(ownerJwt),
    });
    expect(unsupported.statusCode).toBe(200);
    expect(unsupported.json().supported).toBe(false);
    daemon.disconnect();
    await new Promise((r) => setTimeout(r, 150));

    await connectDaemon(['sessions'], () => ({ error: 'npx failed' }));
    const failed = await app.inject({
      method: 'GET',
      url: `/api/agent-instances/${agentId}/sessions`,
      headers: auth(ownerJwt),
    });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error).toBe('DAEMON_SESSIONS_FAILED');
    daemon.disconnect();
    await new Promise((r) => setTimeout(r, 150));

    // Silent daemon → 504 (timeout 500ms via testConfig).
    await connectDaemon(['sessions'], () => ({ sessions: [] }));
    daemon.removeAllListeners('sessions:list');
    const timeout = await app.inject({
      method: 'GET',
      url: `/api/agent-instances/${agentId}/sessions`,
      headers: auth(ownerJwt),
    });
    expect(timeout.statusCode).toBe(504);
    expect(timeout.json().error).toBe('SESSIONS_TIMEOUT');
  });
});

describe('DELETE /api/agent-instances/:id/sessions/:sessionId (#55)', () => {
  it('404s for strangers and 409s while offline', async () => {
    // The GET suite's final test leaves its daemon connected (afterAll owns
    // it) — drop it first or the machine reads online here.
    daemon?.disconnect();
    await new Promise((r) => setTimeout(r, 150));
    const stranger = await app.inject({
      method: 'DELETE',
      url: `/api/agent-instances/${agentId}/sessions/native-1`,
      headers: auth(strangerJwt),
    });
    expect(stranger.statusCode).toBe(404);
    const offline = await app.inject({
      method: 'DELETE',
      url: `/api/agent-instances/${agentId}/sessions/native-1`,
      headers: auth(ownerJwt),
    });
    expect(offline.statusCode).toBe(409);
    expect(offline.json().error).toBe('MACHINE_OFFLINE');
  });

  it('409s when the daemon lacks the sessions-delete capability', async () => {
    await connectDaemon(['sessions'], () => ({ sessions: [] }));
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/agent-instances/${agentId}/sessions/native-1`,
      headers: auth(ownerJwt),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('DAEMON_NO_SESSIONS_DELETE');
    daemon.disconnect();
    await new Promise((r) => setTimeout(r, 150));
  });

  it('round-trips the delete (target + sessionId ride the /ctl event)', async () => {
    const seen: { target: string; sessionId: string }[] = [];
    await connectDaemon(
      ['sessions', 'sessions-delete'],
      () => ({ sessions: [] }),
      (p) => {
        seen.push({ target: p.target, sessionId: p.sessionId });
      },
    );
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/agent-instances/${agentId}/sessions/native-del-1`,
      headers: auth(ownerJwt),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(seen).toEqual([{ target: 'claude-code', sessionId: 'native-del-1' }]);
    daemon.disconnect();
    await new Promise((r) => setTimeout(r, 150));
  });

  it('refuses a native session holding a live channel (409 NATIVE_SESSION_LIVE)', async () => {
    await connectDaemon(['sessions', 'sessions-delete', 'chat'], () => ({ sessions: [] }));
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/machines/${machineId}`,
      headers: auth(ownerJwt),
      payload: { remoteChatEnabled: true },
    });
    expect(patch.json().machine.remoteChatEnabled).toBe(true);

    const browser = io(`${baseUrl}/app`, { auth: { token: ownerJwt }, transports: ['websocket'] });
    await new Promise<void>((resolve) => browser.on('connect', () => resolve()));
    const startP = new Promise<{ sessionId: string }>((resolve) => {
      daemon.on('chat:session.start', (p: { sessionId: string }) => resolve(p));
    });
    await new Promise((resolve) => {
      browser.emit('chat:session.open', { agentInstanceId: agentId }, resolve);
    });
    const start = await startP;
    const readyP = new Promise<void>((resolve) => {
      browser.on('chat:session.ready', () => resolve());
    });
    daemon.emit('chat:session.ready', {
      sessionId: start.sessionId,
      nativeSessionId: 'native-occupied',
    });
    await readyP;

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/agent-instances/${agentId}/sessions/native-occupied`,
      headers: auth(ownerJwt),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('NATIVE_SESSION_LIVE');

    await new Promise((resolve) => {
      browser.emit('chat:session.close', { sessionId: start.sessionId, reason: 'user' }, resolve);
    });
    browser.close();
    daemon.disconnect();
    await new Promise((r) => setTimeout(r, 150));
  }, 20000);

  it('maps the error arm and the silent-daemon timeout', async () => {
    await connectDaemon(['sessions', 'sessions-delete'], () => ({ sessions: [] }));
    daemon.removeAllListeners('sessions:delete');
    daemon.on('sessions:delete', (payload: { requestId: string }) => {
      daemon.emit('sessions:delete:result', { requestId: payload.requestId, error: 'boom' });
    });
    const failed = await app.inject({
      method: 'DELETE',
      url: `/api/agent-instances/${agentId}/sessions/native-1`,
      headers: auth(ownerJwt),
    });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error).toBe('DAEMON_SESSION_DELETE_FAILED');
    daemon.disconnect();
    await new Promise((r) => setTimeout(r, 150));

    // Silent daemon → 504 (timeout 500ms via testConfig).
    await connectDaemon(['sessions', 'sessions-delete'], () => ({ sessions: [] }));
    daemon.removeAllListeners('sessions:delete');
    const timeout = await app.inject({
      method: 'DELETE',
      url: `/api/agent-instances/${agentId}/sessions/native-1`,
      headers: auth(ownerJwt),
    });
    expect(timeout.statusCode).toBe(504);
    expect(timeout.json().error).toBe('SESSIONS_DELETE_TIMEOUT');
  });
});
