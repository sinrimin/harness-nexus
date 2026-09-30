import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { MachineStatusEvent } from '@harness-nexus/shared';
import { emitAck, once, testConfig, waitFor } from './helpers.js';

/**
 * Realtime channel integration (Phase 8 C1) against a listening server:
 * /ctl handshake + machine:hello, presence → machine:status pushes on /app,
 * and the auth rejections (wrong machineId, machine token on /app).
 */

let app: FastifyInstance;
let baseUrl: string;
let jwt: string;
let machineId: string;
let machineToken: string;
const statuses: MachineStatusEvent[] = [];
let appSock: Socket;

beforeAll(async () => {
  app = await buildApp(testConfig());
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;

  const reg = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'root', password: 'hunter2hunter2' },
  });
  jwt = reg.json().token;

  const enroll = await app.inject({
    method: 'POST',
    url: '/api/machines',
    headers: { authorization: `Bearer ${jwt}` },
    payload: { name: 'laptop' },
  });
  machineId = enroll.json().machine.id;
  machineToken = enroll.json().token;

  appSock = io(`${baseUrl}/app`, {
    auth: { token: jwt },
    transports: ['websocket'],
  });
  appSock.on('machine:status', (e: MachineStatusEvent) => statuses.push(e));
  await once(appSock, 'connect');
}, 20000);

afterAll(async () => {
  appSock?.close();
  await app?.close();
});

describe('/ctl namespace', () => {
  it('connects with a valid machine token and acks machine:hello', async () => {
    const ctl = io(`${baseUrl}/ctl`, {
      auth: { token: machineToken, machineId },
      transports: ['websocket'],
    });
    await once(ctl, 'connect');

    const ack = await emitAck(ctl, 'machine:hello', {
      daemonVersion: '0.1.0-test',
      os: 'linux',
      arch: 'x64',
      hostname: 'testbox',
      capabilities: [],
    });
    expect(ack).toEqual({
      proto: 1,
      machineId,
      // #37 — the ack carries the server build for client-side staleness
      // warnings; it equals the manifest version (e.g. 0.1.0-alpha.7).
      serverVersion: expect.stringMatching(/^\d+\.\d+\.\d+/),
    });

    // Presence: /app saw the online push, REST reports online + metadata.
    await waitFor(() => statuses.some((s) => s.machineId === machineId && s.online));
    const res = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    const machine = res.json().machine;
    expect(machine.online).toBe(true);
    expect(machine.daemonVersion).toBe('0.1.0-test');
    expect(machine.hostname).toBe('testbox');

    // Disconnect → offline push.
    ctl.close();
    await waitFor(() => statuses.some((s) => s.machineId === machineId && !s.online));
    const after = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}`,
      headers: { authorization: `Bearer ${jwt}` },
    });
    expect(after.json().machine.online).toBe(false);
  }, 15000);

  it('rejects a handshake whose machineId does not match the token', async () => {
    const bad = io(`${baseUrl}/ctl`, {
      auth: { token: machineToken, machineId: 'not-my-machine' },
      transports: ['websocket'],
    });
    const err = (await once(bad, 'connect_error')) as Error;
    expect(err).toBeInstanceOf(Error);
    bad.close();
  });

  it('rejects a machine hello with a malformed payload (proto:invalid)', async () => {
    const ctl = io(`${baseUrl}/ctl`, {
      auth: { token: machineToken, machineId },
      transports: ['websocket'],
    });
    await once(ctl, 'connect');
    const ack = await emitAck(ctl, 'machine:hello', { daemonVersion: '' });
    expect(ack).toEqual({ error: 'proto:invalid' });
    ctl.close();
  });

  // #45 — one daemon per machine, enforced at the handshake: a second live
  // socket would receive every room broadcast (prompts AND dispatched jobs
  // would run N×). The newcomer is refused; the incumbent keeps working; a
  // replacement connects once the old socket is gone (restart semantics).
  it('refuses a SECOND live socket for the same machine, incumbent unaffected', async () => {
    const first = io(`${baseUrl}/ctl`, {
      auth: { token: machineToken, machineId },
      transports: ['websocket'],
    });
    await once(first, 'connect');

    const second = io(`${baseUrl}/ctl`, {
      auth: { token: machineToken, machineId },
      transports: ['websocket'],
    });
    const err = (await once(second, 'connect_error')) as Error;
    expect(err.message).toBe('machine already connected');
    second.close();

    // The incumbent still works (hello acks normally).
    const ack = await emitAck(first, 'machine:hello', {
      daemonVersion: '0.1.0-test',
      os: 'linux',
      arch: 'x64',
      hostname: 'incumbent',
      capabilities: [],
    });
    expect(ack).toMatchObject({ proto: 1, machineId });
    first.close();
    await waitFor(() => !app.realtime.presence.isOnline(machineId));
  }, 15000);

  it('a replacement connects once the old socket is gone (restart semantics)', async () => {
    const old = io(`${baseUrl}/ctl`, {
      auth: { token: machineToken, machineId },
      transports: ['websocket'],
    });
    await once(old, 'connect');
    old.close();
    await waitFor(() => !app.realtime.presence.isOnline(machineId));

    const replacement = io(`${baseUrl}/ctl`, {
      auth: { token: machineToken, machineId },
      transports: ['websocket'],
    });
    await once(replacement, 'connect');
    const ack = await emitAck(replacement, 'machine:hello', {
      daemonVersion: '0.1.0-test',
      capabilities: [],
    });
    expect(ack).toMatchObject({ proto: 1, machineId });
    replacement.close();
    await waitFor(() => !app.realtime.presence.isOnline(machineId));
  }, 15000);

  it('a second socket for a DIFFERENT machine is fine (the guard is per machine)', async () => {
    const enroll = await app.inject({
      method: 'POST',
      url: '/api/machines',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { name: 'other-box' },
    });
    const otherId: string = enroll.json().machine.id;
    const otherToken: string = enroll.json().token;

    const a = io(`${baseUrl}/ctl`, {
      auth: { token: machineToken, machineId },
      transports: ['websocket'],
    });
    await once(a, 'connect');
    const b = io(`${baseUrl}/ctl`, {
      auth: { token: otherToken, machineId: otherId },
      transports: ['websocket'],
    });
    await once(b, 'connect');
    const ack = await emitAck(b, 'machine:hello', { daemonVersion: '0.1.0-test' });
    expect(ack).toMatchObject({ proto: 1, machineId: otherId });
    a.close();
    b.close();
    await waitFor(() => !app.realtime.presence.isOnline(otherId));
  }, 15000);
});

describe('/app namespace', () => {
  it('rejects a machine token (browser channel is JWT/api-PAT only)', async () => {
    const bad = io(`${baseUrl}/app`, {
      auth: { token: machineToken },
      transports: ['websocket'],
    });
    await once(bad, 'connect_error');
    bad.close();
  });

  it('rejects an anonymous handshake', async () => {
    const bad = io(`${baseUrl}/app`, { auth: {}, transports: ['websocket'] });
    await once(bad, 'connect_error');
    bad.close();
  });
});

describe('DELETE /api/machines force-disconnects the daemon', () => {
  it('drops the live socket when the machine is deleted', async () => {
    const enroll = await app.inject({
      method: 'POST',
      url: '/api/machines',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { name: 'ephemeral' },
    });
    const { machine, token } = enroll.json();
    const id: string = machine.id;

    const ctl = io(`${baseUrl}/ctl`, {
      auth: { token, machineId: id },
      transports: ['websocket'],
    });
    await once(ctl, 'connect');
    await waitFor(() => statuses.some((s) => s.machineId === id && s.online));

    await app.inject({
      method: 'DELETE',
      url: `/api/machines/${id}`,
      headers: { authorization: `Bearer ${jwt}` },
    });

    await once(ctl, 'disconnect');
    await waitFor(() => statuses.some((s) => s.machineId === id && !s.online));
    ctl.close();
  }, 15000);
});
