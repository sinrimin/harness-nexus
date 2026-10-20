// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { testConfig } from './helpers.js';

/**
 * Workspace listing round-trip (Phase 9 W6): the REST route validates
 * containment against the machine's baseWorkspace, emits `workspace:list`
 * over /ctl, and a fake daemon answers with one level of directories —
 * plus the gates (root unset, outside root, offline, capability, timeout,
 * daemon error arm, ownership).
 */

let app: FastifyInstance;
let baseUrl: string;
let ownerJwt: string;
let strangerJwt: string;
let machineId: string;
let machineToken: string;
let daemon: Socket;

const auth = (t: string): { authorization: string } => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  app = await buildApp(testConfig({ workspaceListTimeoutMs: 500 }));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;

  for (const [username, key] of [
    ['w6owner', 'ownerJwt'],
    ['w6stranger', 'strangerJwt'],
  ] as const) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username, password: 'hunter2hunter2' },
    });
    if (key === 'ownerJwt') ownerJwt = res.json().token;
    if (key === 'strangerJwt') strangerJwt = res.json().token;
  }
  const enroll = await app.inject({
    method: 'POST',
    url: '/api/machines',
    headers: auth(ownerJwt),
    payload: { name: 'w6-box' },
  });
  machineId = enroll.json().machine.id;
  machineToken = enroll.json().token;
});

afterAll(async () => {
  daemon?.disconnect();
  await app.close();
});

/** Connect a fake daemon with the given capabilities and list-responder. */
async function connectDaemon(
  capabilities: string[],
  respond: (requestId: string, path: string) => Record<string, unknown>,
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
  daemon.on('workspace:list', (payload: { requestId: string; path: string }) => {
    daemon.emit('workspace:list', {
      requestId: payload.requestId,
      ...respond(payload.requestId, payload.path),
    });
  });
}

async function setBase(path: string | null): Promise<void> {
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/machines/${machineId}`,
    headers: auth(ownerJwt),
    payload: { baseWorkspace: path },
  });
  expect(res.json().machine.baseWorkspace).toBe(path);
}

describe('GET /api/machines/:id/workspace (9 W6)', () => {
  it('400s while no base workspace is configured', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/workspace`,
      headers: auth(ownerJwt),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('WORKSPACE_ROOT_NOT_SET');
    await setBase('/home/w6/projects');
  });

  it('400s for paths outside the root (after resolution)', async () => {
    for (const path of ['/home/w6/other', '/home/w6/projects/../secret', '/etc']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/machines/${machineId}/workspace?path=${encodeURIComponent(path)}`,
        headers: auth(ownerJwt),
      });
      expect(res.statusCode, path).toBe(400);
      expect(res.json().error).toBe('WORKSPACE_OUTSIDE_ROOT');
    }
  });

  it('404s for strangers and 409s while offline', async () => {
    const stranger = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/workspace`,
      headers: auth(strangerJwt),
    });
    expect(stranger.statusCode).toBe(404);
    const offline = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/workspace`,
      headers: auth(ownerJwt),
    });
    expect(offline.statusCode).toBe(409);
    expect(offline.json().error).toBe('MACHINE_OFFLINE');
  });

  it('409s when the daemon lacks the workspace capability', async () => {
    await connectDaemon(['chat'], () => ({ directories: [] }));
    const res = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/workspace`,
      headers: auth(ownerJwt),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('DAEMON_NO_WORKSPACE');
    daemon.disconnect();
    await new Promise((r) => setTimeout(r, 150));
  });

  it('round-trips one level of directories (and files, 9 W9 C) through the daemon', async () => {
    await connectDaemon(['workspace'], (requestId, path) => ({
      directories:
        path === '/home/w6/projects'
          ? [
              { name: 'alpha', path: '/home/w6/projects/alpha' },
              { name: 'beta', path: '/home/w6/projects/beta' },
            ]
          : [],
      files:
        path === '/home/w6/projects'
          ? [{ name: 'notes.md', path: '/home/w6/projects/notes.md' }]
          : [],
    }));
    const root = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/workspace`,
      headers: auth(ownerJwt),
    });
    expect(root.statusCode).toBe(200);
    expect(root.json()).toEqual({
      path: '/home/w6/projects',
      directories: [
        { name: 'alpha', path: '/home/w6/projects/alpha' },
        { name: 'beta', path: '/home/w6/projects/beta' },
      ],
      files: [{ name: 'notes.md', path: '/home/w6/projects/notes.md' }],
    });
    // Subdirectory listing — still under the root.
    const sub = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/workspace?path=${encodeURIComponent('/home/w6/projects/alpha')}`,
      headers: auth(ownerJwt),
    });
    expect(sub.statusCode).toBe(200);
    expect(sub.json().directories).toEqual([]);
    // An old daemon omitting the files arm degrades to an empty list.
    daemon.disconnect();
    await new Promise((r) => setTimeout(r, 150));
    await connectDaemon(['workspace'], () => ({ directories: [] }));
    const legacy = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/workspace`,
      headers: auth(ownerJwt),
    });
    expect(legacy.statusCode).toBe(200);
    expect(legacy.json().files).toEqual([]);
    daemon.disconnect();
    await new Promise((r) => setTimeout(r, 150));
  });

  it('maps the daemon error arm to 502 and silence to 504', async () => {
    await connectDaemon(['workspace'], () => ({ error: 'ENOENT' }));
    const failed = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/workspace`,
      headers: auth(ownerJwt),
    });
    expect(failed.statusCode).toBe(502);
    expect(failed.json().error).toBe('DAEMON_WORKSPACE_FAILED');
    daemon.disconnect();
    await new Promise((r) => setTimeout(r, 150));

    // Silent daemon → 504 (timeout 500ms via testConfig).
    await connectDaemon(['workspace'], () => ({ directories: [] }));
    daemon.removeAllListeners('workspace:list');
    const timeout = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/workspace`,
      headers: auth(ownerJwt),
    });
    expect(timeout.statusCode).toBe(504);
    expect(timeout.json().error).toBe('WORKSPACE_TIMEOUT');
  });
});
