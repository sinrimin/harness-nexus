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
