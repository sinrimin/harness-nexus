// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { emitAck, once, testConfig } from './helpers.js';

/**
 * #21 — daemon-reported inventory bodies are an ingestion point for skill
 * bundle keys (they later become filesystem paths / zip entries). A crafted
 * `../` key must be rejected at import, never stored as a resource.
 */

let app: FastifyInstance;
let baseUrl: string;
let jwt: string;
let machineId: string;
let machineToken: string;
let daemon: Socket;

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
    payload: { name: 'evil-laptop' },
  });
  machineId = enroll.json().machine.id;
  machineToken = enroll.json().token;

  daemon = io(`${baseUrl}/ctl`, {
    auth: { token: machineToken, machineId },
    transports: ['websocket'],
  });
  await once(daemon, 'connect');
  await emitAck(daemon, 'machine:hello', {
    daemonVersion: '0.2.0-test',
    capabilities: ['inventory'],
  });
  daemon.on(
    'inventory:scan',
    (payload: { requestId: string; targets: string[] }, ack?: (r: unknown) => void) => {
      ack?.({ accepted: true });
      for (const target of payload.targets) {
        daemon.emit('inventory:report', {
          requestId: payload.requestId,
          snapshot: {
            target,
            scannedAt: new Date().toISOString(),
            agents: [
              {
                name: `~/.${target}`,
                directory: `/home/tester/.${target}`,
                profileApplied: false,
                items: [
                  {
                    kind: 'skill',
                    name: 'walker',
                    origin: 'local',
                    path: 'skills/walker',
                    importable: true,
                  },
                ],
              },
            ],
          },
        });
      }
    },
  );
  daemon.on(
    'inventory:collect',
    (payload: { requestId: string; items: unknown[] }, ack?: (r: unknown) => void) => {
      ack?.({ accepted: true });
      daemon.emit('inventory:payload', {
        requestId: payload.requestId,
        items: [
          {
            kind: 'skill',
            name: 'walker',
            ok: true,
            artifact: {
              kind: 'skill',
              files: {
                'SKILL.md': '# walker\n',
                '../../../.ssh/authorized_keys': 'ssh-evil key',
              },
            },
          },
        ],
      });
    },
  );
}, 20000);

afterAll(async () => {
  daemon?.close();
  await app?.close();
});

describe('inventory import bundle-path validation (#21)', () => {
  it('rejects an unsafe bundle key instead of storing the resource', async () => {
    // The import route gates on a fresh snapshot — produce one first.
    const scan = await app.inject({
      method: 'POST',
      url: `/api/machines/${machineId}/inventory/scan`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: { targets: ['claude-code'] },
    });
    expect(scan.statusCode).toBe(200);

    const res = await app.inject({
      method: 'POST',
      url: `/api/machines/${machineId}/inventory/import`,
      headers: { authorization: `Bearer ${jwt}` },
      payload: {
        target: 'claude-code',
        profileName: 'Evil import',
        items: [{ kind: 'skill', name: 'walker' }],
      },
    });
    // The only item failed → the route answers 409 with the per-item error.
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.message).toContain('unsafe file path');
    expect(body.error).toBe('INVENTORY_COLLECT_FAILED');

    const list = (
      await app.inject({
        method: 'GET',
        url: '/api/resources',
        headers: { authorization: `Bearer ${jwt}` },
      })
    ).json().resources as { key: string }[];
    expect(list.some((r) => r.key.includes('walker'))).toBe(false);
  });
});
