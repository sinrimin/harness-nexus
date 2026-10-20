// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import { DetectedInstanceSync } from '../src/realtime/runtime-instances.js';
import type { Machine } from '@harness-nexus/core';
import type { RuntimeInfo } from '@harness-nexus/shared';
import { emitAck, once, testConfig } from './helpers.js';

/**
 * Phase 9 W1 — Agent-first inventory: the runtime arm on inventory reports
 * (storage + REST view), DetectedInstanceSync auto-registration with
 * hysteresis and deploy-precedence, capture-as-profile, and chat keying off a
 * DETECTED instance (the emitter-installed claude-code gap C5 could not close).
 */

// ---- unit: DetectedInstanceSync over the memory uow ----

const machine = (id: string): Machine => ({
  id,
  ownerId: 'owner-1',
  name: 'laptop',
  hostname: null,
  os: null,
  arch: null,
  daemonVersion: null,
  capabilities: [],
  remoteChatEnabled: false,
  enrollmentPatId: `pat-${id}`,
  enrolledAt: new Date().toISOString(),
  lastSeenAt: null,
});

const RUNTIME_CC: RuntimeInfo = {
  target: 'claude-code',
  installed: true,
  binPath: '/home/me/.local/bin/claude',
  version: '2.1.211 (Claude Code)',
  installMethod: 'native',
};

describe('DetectedInstanceSync (unit)', () => {
  it('registers exactly one detected instance and never duplicates it', async () => {
    const uow = createMemoryUnitOfWork();
    const sync = new DetectedInstanceSync(uow);
    await sync.onReport(machine('m1'), RUNTIME_CC, '/home/me/.claude');
    await sync.onReport(machine('m1'), RUNTIME_CC, '/home/me/.claude');
    const rows = await uow.agentInstances.listByMachine('m1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      target: 'claude-code',
      source: 'detected',
      profileId: null,
      jobId: null,
      name: 'claude-code',
      directory: '/home/me/.claude',
      ownerId: 'owner-1',
    });
  });

  it('keeps the row on the first not-installed report, removes it on the second', async () => {
    const uow = createMemoryUnitOfWork();
    const sync = new DetectedInstanceSync(uow);
    await sync.onReport(machine('m1'), RUNTIME_CC, '/home/me/.claude');
    await sync.onReport(machine('m1'), { target: 'claude-code', installed: false }, undefined);
    expect(await uow.agentInstances.listByMachine('m1')).toHaveLength(1);
    await sync.onReport(machine('m1'), { target: 'claude-code', installed: false }, undefined);
    expect(await uow.agentInstances.listByMachine('m1')).toHaveLength(0);
  });

  it('re-registers after removal (flaky probe recovery) and clears the miss counter', async () => {
    const uow = createMemoryUnitOfWork();
    const sync = new DetectedInstanceSync(uow);
    await sync.onReport(machine('m1'), RUNTIME_CC, '/home/me/.claude');
    await sync.onReport(machine('m1'), { target: 'claude-code', installed: false }, undefined);
    // one miss only — row survives, and the counter resets on the next hit
    await sync.onReport(machine('m1'), RUNTIME_CC, '/home/me/.claude');
    expect(await uow.agentInstances.listByMachine('m1')).toHaveLength(1);
  });

  it('treats a null runtime arm (old daemon / unmanaged target) as NO signal', async () => {
    const uow = createMemoryUnitOfWork();
    const sync = new DetectedInstanceSync(uow);
    await sync.onReport(machine('m1'), RUNTIME_CC, '/home/me/.claude');
    await sync.onReport(machine('m1'), null, undefined);
    expect(await uow.agentInstances.listByMachine('m1')).toHaveLength(1);
    // and without a prior row, null never registers one
    await sync.onReport(machine('m2'), null, undefined);
    expect(await uow.agentInstances.listByMachine('m2')).toHaveLength(0);
  });

  it('never registers when a deploy row already owns the target', async () => {
    const uow = createMemoryUnitOfWork();
    const sync = new DetectedInstanceSync(uow);
    const now = new Date().toISOString();
    await uow.agentInstances.save({
      id: 'deploy-1',
      machineId: 'm1',
      ownerId: 'owner-1',
      target: 'claude-code',
      profileId: 'profile-1',
      profileVersion: '1.0.0',
      source: 'deploy',
      name: 'my-kit',
      directory: '/home/me/.claude',
      jobId: 'job-1',
      createdAt: now,
      updatedAt: now,
    });
    await sync.onReport(machine('m1'), RUNTIME_CC, '/home/me/.claude');
    const rows = await uow.agentInstances.listByMachine('m1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe('deploy');
  });

  it('updates the directory when the agent home moves', async () => {
    const uow = createMemoryUnitOfWork();
    const sync = new DetectedInstanceSync(uow);
    await sync.onReport(machine('m1'), RUNTIME_CC, '/home/me/.claude');
    await sync.onReport(machine('m1'), RUNTIME_CC, '/other/home/.claude');
    const rows = await uow.agentInstances.listByMachine('m1');
    expect(rows[0]!.directory).toBe('/other/home/.claude');
  });
});

// ---- integration: reports over /ctl → storage, REST, capture, chat ----

let app: FastifyInstance;
let baseUrl: string;
let jwt: string;
let machineId: string;
let machineToken: string;
let daemon: Socket;
const authed = (token: string): { authorization: string } => ({ authorization: `Bearer ${token}` });

const snap = (target: string, items: unknown[] = []) => ({
  target,
  scannedAt: new Date().toISOString(),
  agents: [
    {
      name: `~/.${target === 'claude-code' ? 'claude' : target}`,
      directory: `/home/tester/.${target === 'claude-code' ? 'claude' : target}`,
      profileApplied: false,
      items,
    },
  ],
});

const snapWithItem = (target: string) =>
  snap(target, [
    {
      kind: 'command',
      name: `${target}-cmd`,
      origin: 'local',
      path: `commands/${target}-cmd.md`,
      importable: true,
    },
  ]);

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
    headers: authed(jwt),
    payload: { name: 'w1-laptop' },
  });
  machineId = enroll.json().machine.id;
  machineToken = enroll.json().token;

  daemon = io(`${baseUrl}/ctl`, {
    auth: { token: machineToken, machineId },
    transports: ['websocket'],
  });
  await once(daemon, 'connect');
  await emitAck(daemon, 'machine:hello', {
    daemonVersion: '0.5.0-test',
    capabilities: ['inventory', 'chat', 'runtime'],
  });

  // W1 fake daemon: scan answers carry the runtimes arm; collect returns one
  // canned body per requested item.
  daemon.on(
    'inventory:scan',
    (payload: { requestId: string; targets: string[] }, ack?: (r: unknown) => void) => {
      ack?.({ accepted: true });
      const runtimes: RuntimeInfo[] = [
        { ...RUNTIME_CC, binPath: '/home/tester/.local/bin/claude' },
        { target: 'codex', installed: false },
        { target: 'deepseek', installed: false },
      ];
      for (const target of payload.targets) {
        daemon.emit('inventory:report', {
          requestId: payload.requestId,
          runtimes,
          snapshot: target === 'codex' ? snapWithItem('codex') : snap(target),
        });
      }
    },
  );
  daemon.on(
    'inventory:collect',
    (
      payload: { requestId: string; items: { kind: string; name: string }[] },
      ack?: (r: unknown) => void,
    ) => {
      ack?.({ accepted: true });
      daemon.emit('inventory:payload', {
        requestId: payload.requestId,
        items: payload.items.map((sel) => ({
          kind: sel.kind,
          name: sel.name,
          ok: true,
          artifact: { kind: sel.kind, content: `${sel.name} body` },
        })),
      });
    },
  );
}, 20000);

afterAll(async () => {
  daemon?.close();
  await app?.close();
});

describe('runtime arm storage + REST view', () => {
  it('scan stores per-target runtime and auto-registers the detected instance', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/machines/${machineId}/inventory/scan`,
      headers: authed(jwt),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().inventory as {
      target: string;
      runtime: RuntimeInfo | null;
    }[];
    expect(rows.find((r) => r.target === 'claude-code')!.runtime).toMatchObject({
      installed: true,
      version: '2.1.211 (Claude Code)',
    });
    expect(rows.find((r) => r.target === 'codex')!.runtime).toEqual({
      target: 'codex',
      installed: false,
    });
    // hermes is not a runtime target — its row carries null
    expect(rows.find((r) => r.target === 'hermes')!.runtime).toBeNull();

    const agents = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/agents`,
      headers: authed(jwt),
    });
    expect(
      agents.json().agents.filter((a: { source: string }) => a.source === 'detected'),
    ).toHaveLength(1);

    // GET inventory carries the same arm
    const list = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/inventory`,
      headers: authed(jwt),
    });
    const stored = list.json().inventory as { target: string; runtime: RuntimeInfo | null }[];
    expect(stored.find((r) => r.target === 'claude-code')!.runtime?.installMethod).toBe('native');
  });

  it('does not duplicate the detected row on a repeat scan', async () => {
    await app.inject({
      method: 'POST',
      url: `/api/machines/${machineId}/inventory/scan`,
      headers: authed(jwt),
      payload: { targets: ['claude-code'] },
    });
    const agents = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/agents`,
      headers: authed(jwt),
    });
    const detected = agents
      .json()
      .agents.filter((a: { source: string; target: string }) => a.source === 'detected');
    expect(detected).toHaveLength(1);
    expect(detected[0]).toMatchObject({ target: 'claude-code', profileId: null, jobId: null });
  });

  it('a report WITHOUT the runtimes arm is no signal — rows survive an old daemon', async () => {
    daemon.emit('inventory:report', { snapshot: snap('claude-code') });
    await new Promise((r) => setTimeout(r, 150));
    const agents = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/agents`,
      headers: authed(jwt),
    });
    expect(
      agents.json().agents.filter((a: { source: string }) => a.source === 'detected'),
    ).toHaveLength(1);
  });

  it('hysteresis: two consecutive not-installed reports remove the detected row', async () => {
    const report = (installed: boolean): void =>
      daemon.emit('inventory:report', {
        runtimes: [{ target: 'claude-code', installed }],
        snapshot: snap('claude-code'),
      });
    const agentsNow = async (): Promise<unknown[]> => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/machines/${machineId}/agents`,
        headers: authed(jwt),
      });
      return res.json().agents.filter((a: { source: string }) => a.source === 'detected');
    };

    report(false);
    await new Promise((r) => setTimeout(r, 150));
    expect(await agentsNow()).toHaveLength(1); // first miss keeps the row

    report(false);
    await new Promise((r) => setTimeout(r, 150));
    expect(await agentsNow()).toHaveLength(0); // second miss removes it

    // and a fresh installed report re-registers (flaky-probe recovery)
    report(true);
    await new Promise((r) => setTimeout(r, 150));
    expect(await agentsNow()).toHaveLength(1);
  });
});

describe('capture-as-profile', () => {
  it('bundles every importable item of the latest snapshot (no baseline)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/machines/${machineId}/inventory/capture`,
      headers: authed(jwt),
      payload: { target: 'codex', profileName: 'codex-default' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profile).toMatchObject({ name: 'codex-default', target: 'codex' });
    expect(body.profile.entries).toHaveLength(1);
    expect(body.created).toHaveLength(1);
  });

  it('captures an Agent in default state as a zero-entry profile', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/machines/${machineId}/inventory/capture`,
      headers: authed(jwt),
      payload: { target: 'hermes', profileName: 'hermes-empty' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().profile.entries).toHaveLength(0);
  });

  it('is idempotent on re-capture (reuse-or-create)', async () => {
    const again = await app.inject({
      method: 'POST',
      url: `/api/machines/${machineId}/inventory/capture`,
      headers: authed(jwt),
      payload: { target: 'codex', profileName: 'codex-default-2' },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().reused).toHaveLength(1);
    expect(again.json().created).toHaveLength(0);
  });
});

describe('chat keys off the detected Agent (re-gating)', () => {
  it('opens a channel against the detected claude-code instance', async () => {
    const enable = await app.inject({
      method: 'PATCH',
      url: `/api/machines/${machineId}`,
      headers: authed(jwt),
      payload: { remoteChatEnabled: true },
    });
    expect(enable.statusCode).toBe(200);

    const agents = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/agents`,
      headers: authed(jwt),
    });
    const detected = agents
      .json()
      .agents.find((a: { source: string; target: string }) => a.source === 'detected');
    expect(detected).toBeDefined();

    const browser = io(`${baseUrl}/app`, { auth: { token: jwt }, transports: ['websocket'] });
    await once(browser, 'connect');

    const startP = once(daemon, 'chat:session.start') as Promise<{
      sessionId: string;
      target: string;
      cwd: string;
    }>;
    const openAck = (await emitAck(browser, 'chat:session.open', {
      agentInstanceId: detected.id,
    })) as { sessionId?: string; error?: string };
    expect(openAck.error).toBeUndefined();
    expect(openAck.sessionId).toBeDefined();

    const start = await startP;
    expect(start.target).toBe('claude-code');
    expect(start.cwd).toBe('/home/tester/.claude');

    daemon.emit('chat:session.ready', {
      sessionId: start.sessionId,
      agentName: 'claude-code',
      agentVersion: '2.1.211',
    });
    const ready = (await once(browser, 'chat:session.ready')) as { sessionId: string };
    expect(ready.sessionId).toBe(start.sessionId);

    await emitAck(browser, 'chat:session.close', { sessionId: start.sessionId, reason: 'user' });
    browser.close();
  });
});
