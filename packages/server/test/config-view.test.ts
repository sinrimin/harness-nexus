import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { testConfig, waitFor } from './helpers.js';

/**
 * Redacted config-view round-trip (Phase 9 W4): the REST route emits
 * `runtime:config.get` over /ctl, a fake daemon answers `runtime:config`, and
 * the masked files flow back — plus the gates (offline, capability, timeout,
 * ownership) and the never-a-secret invariant.
 */

let app: FastifyInstance;
let baseUrl: string;
let ownerJwt: string;
let adminJwt: string;
let strangerJwt: string;
let machineId: string;
let machineToken: string;
let daemon: Socket;

const auth = (t: string): { authorization: string } => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  app = await buildApp(testConfig());
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;

  for (const [username, key] of [
    ['root', 'adminJwt'],
    ['owner', 'ownerJwt'],
    ['stranger', 'strangerJwt'],
  ] as const) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username, password: 'hunter2hunter2' },
    });
    if (key === 'adminJwt') adminJwt = res.json().token;
    if (key === 'ownerJwt') ownerJwt = res.json().token;
    if (key === 'strangerJwt') strangerJwt = res.json().token;
  }
  const enroll = await app.inject({
    method: 'POST',
    url: '/api/machines',
    headers: auth(ownerJwt),
    payload: { name: 'w4-box' },
  });
  machineId = enroll.json().machine.id;
  machineToken = enroll.json().token;
});

afterAll(async () => {
  daemon?.disconnect();
  await app.close();
});

/** Connect a fake daemon that says hello with the given capabilities. */
async function connectDaemon(capabilities: string[]): Promise<void> {
  daemon = io(`${baseUrl}/ctl`, {
    auth: { token: machineToken, machineId },
    transports: ['websocket'],
  });
  await new Promise<void>((resolve, reject) => {
    daemon.on('connect', () => {
      daemon.emit('machine:hello', { daemonVersion: 'test', capabilities }, () => resolve());
    });
    daemon.on('connect_error', reject);
  });
  await waitFor(async () => {
    const machine = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}`,
      headers: auth(ownerJwt),
    });
    return machine.json().machine?.online === true;
  });
}

describe('GET /api/machines/:id/runtimes/:target/config', () => {
  it('409s while the daemon is offline', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/runtimes/codex/config`,
      headers: auth(ownerJwt),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('MACHINE_OFFLINE');
  });

  it('409s when the daemon lacks the runtime-config-view capability', async () => {
    await connectDaemon(['inventory']);
    const res = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/runtimes/codex/config`,
      headers: auth(ownerJwt),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('DAEMON_NO_RUNTIME_CONFIG_VIEW');
    daemon.disconnect();
    await waitFor(async () => (await presence()).online === false);
  });

  it('round-trips the daemon-masked view (and hides foreign machines)', async () => {
    await connectDaemon(['runtime-config-view']);
    daemon.on('runtime:config.get', (payload: unknown, ack?: (r: unknown) => void) => {
      ack?.({ accepted: true });
      const { requestId, target } = payload as { requestId: string; target: string };
      daemon.emit('runtime:config', {
        requestId,
        target,
        files: [
          {
            path: `~/.${target === 'codex' ? 'codex' : 'dsh'}/x`,
            content: '{"OPENAI_API_KEY":"${redacted}"}',
          },
        ],
        redacted: ['~/.codex/auth.json:OPENAI_API_KEY'],
      });
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/runtimes/codex/config`,
      headers: auth(ownerJwt),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      target: 'codex',
      files: [{ path: '~/.codex/x', content: '{"OPENAI_API_KEY":"${redacted}"}' }],
      redacted: ['~/.codex/auth.json:OPENAI_API_KEY'],
    });

    // Viewing is owner-only (404 existence-hiding for strangers AND admins —
    // #36 removed the admin read bypass on personal machines).
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/machines/${machineId}/runtimes/codex/config`,
          headers: auth(adminJwt),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/machines/${machineId}/runtimes/codex/config`,
          headers: auth(strangerJwt),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/machines/${machineId}/runtimes/hermes/config`,
          headers: auth(ownerJwt),
        })
      ).statusCode,
    ).toBe(400);
  });

  it('504s when the daemon never answers (testConfig: 700ms)', async () => {
    daemon.off('runtime:config.get');
    daemon.on('runtime:config.get', (payload: unknown, ack?: (r: unknown) => void) => {
      ack?.({ accepted: true }); // accepted but never replies
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/runtimes/codex/config`,
      headers: auth(ownerJwt),
    });
    expect(res.statusCode).toBe(504);
    expect(res.json().error).toBe('VIEW_TIMEOUT');
  });

  it('a late reply after timeout is dropped, not crashed on', async () => {
    let release: ((v: unknown) => void) | null = null;
    daemon.off('runtime:config.get');
    daemon.on('runtime:config.get', (payload: unknown, ack?: (r: unknown) => void) => {
      ack?.({ accepted: true });
      const { requestId, target } = payload as { requestId: string; target: string };
      release = (v) => daemon.emit('runtime:config', { requestId, target, ...(v as object) });
    });
    // First a well-behaved handler again so the route works…
    daemon.removeAllListeners('runtime:config.get');
    daemon.on('runtime:config.get', (payload: unknown, ack?: (r: unknown) => void) => {
      ack?.({ accepted: true });
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/runtimes/codex/config`,
      headers: auth(ownerJwt),
    });
    expect(res.statusCode).toBe(504);
    // …then the late reply for the timed-out requestId lands on an empty waiter.
    release?.({ files: [], redacted: [] });
    const again = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/runtimes/codex/config`,
      headers: auth(ownerJwt),
    });
    expect(again.statusCode).toBe(504);
  });

  async function presence(): Promise<{ online: boolean }> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}`,
      headers: auth(ownerJwt),
    });
    return res.json().machine;
  }
});
