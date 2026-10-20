// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { InventoryUpdatedEvent } from '@harness-nexus/shared';
import { emitAck, once, testConfig } from './helpers.js';

/**
 * Inventory integration (Phase 8 C3) against a listening server with a FAKE
 * daemon on /ctl: scan round-trip (REST waits for the daemon's reports),
 * inventory:updated pushes on /app, the full import flow (collect →
 * reuse-or-create → profile), idempotent re-import, and the gates
 * (offline / no-capability / cross-user 404 / stale-snapshot 409s).
 */

let app: FastifyInstance;
let baseUrl: string;
let jwt: string;
let machineId: string;
let machineToken: string;
let daemon: Socket;
let appSock: Socket;
const updated: InventoryUpdatedEvent[] = [];

/** Snapshot fixtures the fake daemon reports. */
const CC_SNAPSHOT = {
  target: 'claude-code',
  scannedAt: new Date().toISOString(),
  agents: [
    {
      name: '~/.claude',
      directory: '/home/tester/.claude',
      profileApplied: false,
      items: [
        {
          kind: 'skill',
          name: 'docx',
          origin: 'local',
          path: 'skills/docx',
          importable: true,
          summary: 'Work with Word documents',
          meta: { multi: true },
        },
        {
          kind: 'command',
          name: 'deploy',
          origin: 'local',
          path: 'commands/deploy.md',
          importable: true,
        },
        {
          kind: 'mcp',
          name: 'github',
          origin: 'local',
          path: '~/.claude.json#mcpServers',
          importable: true,
          meta: { transport: 'stdio', command: 'npx' },
        },
      ],
    },
  ],
} as const;

const CODEX_SNAPSHOT = {
  target: 'codex',
  scannedAt: new Date().toISOString(),
  agents: [
    {
      name: '~/.codex',
      directory: '/home/tester/.codex',
      profileApplied: false,
      items: [
        {
          kind: 'command',
          name: 'prompt-a',
          origin: 'local',
          path: 'prompts/prompt-a.md',
          importable: true,
        },
      ],
    },
  ],
} as const;

/** Bodies the fake daemon returns for a collect (env already redacted daemon-side). */
function collectBodies(items: { kind: string; name: string }[]): unknown[] {
  return items.map((sel) => {
    if (sel.kind === 'skill' && sel.name === 'docx') {
      return {
        kind: 'skill',
        name: 'docx',
        ok: true,
        artifact: {
          kind: 'skill',
          files: { 'SKILL.md': '# docx\n\nWord documents.', 'references/formats.md': 'notes' },
        },
      };
    }
    if (sel.kind === 'command' && sel.name === 'deploy') {
      return {
        kind: 'command',
        name: 'deploy',
        ok: true,
        artifact: { kind: 'command', content: 'deploy it' },
      };
    }
    if (sel.kind === 'mcp' && sel.name === 'github') {
      return {
        kind: 'mcp',
        name: 'github',
        ok: true,
        artifact: {
          kind: 'mcp',
          transport: {
            type: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            env: { GITHUB_TOKEN: '${cred:GITHUB_TOKEN}' },
          },
        },
      };
    }
    return { kind: sel.kind, name: sel.name, ok: false, error: 'not found in fresh scan' };
  });
}

const authed = (token: string): { authorization: string } => ({ authorization: `Bearer ${token}` });

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
    payload: { name: 'laptop' },
  });
  machineId = enroll.json().machine.id;
  machineToken = enroll.json().token;

  daemon = io(`${baseUrl}/ctl`, {
    auth: { token: machineToken, machineId },
    transports: ['websocket'],
  });
  await once(daemon, 'connect');
  // Advertise the inventory capability like the real C3 daemon does.
  await emitAck(daemon, 'machine:hello', {
    daemonVersion: '0.2.0-test',
    capabilities: ['inventory'],
  });

  daemon.on(
    'inventory:scan',
    (payload: { requestId: string; targets: string[] }, ack?: (r: unknown) => void) => {
      ack?.({ accepted: true });
      for (const target of payload.targets) {
        const snapshot =
          target === 'codex'
            ? CODEX_SNAPSHOT
            : target === 'claude-code'
              ? CC_SNAPSHOT
              : // Absent home: the honest empty shape (this is what a real
                // daemon reports for a target that isn't installed).
                {
                  target,
                  scannedAt: new Date().toISOString(),
                  agents: [
                    {
                      name: `~/.${target}`,
                      directory: `/home/tester/.${target}`,
                      profileApplied: false,
                      items: [],
                    },
                  ],
                };
        daemon.emit('inventory:report', { requestId: payload.requestId, snapshot });
      }
    },
  );
  daemon.on(
    'inventory:collect',
    (payload: { requestId: string; items: unknown[] }, ack?: (r: unknown) => void) => {
      ack?.({ accepted: true });
      daemon.emit('inventory:payload', {
        requestId: payload.requestId,
        items: collectBodies(payload.items as { kind: string; name: string }[]),
      });
    },
  );

  appSock = io(`${baseUrl}/app`, { auth: { token: jwt }, transports: ['websocket'] });
  appSock.on('inventory:updated', (e: InventoryUpdatedEvent) => updated.push(e));
  await once(appSock, 'connect');
}, 20000);

afterAll(async () => {
  daemon?.close();
  appSock?.close();
  await app?.close();
});

describe('scan round-trip', () => {
  it('POST scan waits for the daemon reports and stores them', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/machines/${machineId}/inventory/scan`,
      headers: authed(jwt),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.inventory.map((i: { target: string }) => i.target).sort()).toEqual([
      'claude-code',
      'codex',
      'deepseek',
      'hermes',
      'opencode',
      'pi',
    ]);

    const list = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/inventory`,
      headers: authed(jwt),
    });
    const rows = list.json().inventory as { target: string; agents: { items: unknown[] }[] }[];
    expect(rows).toHaveLength(6); // 5 scannable + opencode (9 W12) + pi (9 W16)
    expect(rows.find((r) => r.target === 'claude-code')!.agents[0]!.items).toHaveLength(3);

    // /app got one freshness push per stored target. The push is emitted
    // asynchronously after the store (best-effort freshness signal), so wait
    // for the flush instead of asserting immediately — asserting inline raced
    // on slow CI runners (all pushes still in flight) and flaked.
    await vi.waitFor(
      () => {
        expect(updated.filter((e) => e.machineId === machineId).length).toBeGreaterThanOrEqual(3);
      },
      { timeout: 5000, interval: 50 },
    );
  });

  it('reports an empty snapshot for targets whose home is absent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/machines/${machineId}/inventory/scan`,
      headers: authed(jwt),
      payload: { targets: ['hermes'] },
    });
    expect(res.statusCode).toBe(200);
    // The fake daemon reports CC_SNAPSHOT for anything non-codex — this just
    // asserts the target fan-out contract, not the content.
    expect(res.json().inventory).toHaveLength(1);
  });
});

describe('import', () => {
  it('collects bodies, creates resources + an McpServer row, and bundles a profile', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/machines/${machineId}/inventory/import`,
      headers: authed(jwt),
      payload: {
        target: 'claude-code',
        profileName: 'Laptop import',
        items: [
          { kind: 'skill', name: 'docx' },
          { kind: 'command', name: 'deploy' },
          { kind: 'mcp', name: 'github' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profile.name).toBe('Laptop import');
    expect(body.profile.target).toBe('claude-code');
    expect(body.created).toHaveLength(3);
    expect(body.reused).toHaveLength(0);
    expect(body.warnings.some((w: string) => w.includes('GITHUB_TOKEN'))).toBe(true);

    // The McpServer landed with the placeholder, never a plaintext env value.
    const servers = await app.inject({
      method: 'GET',
      url: '/api/mcp-servers',
      headers: authed(jwt),
    });
    const github = servers.json().mcpServers.find((s: { name: string }) => s.name === 'github') as {
      transport: { env?: Record<string, string> };
    };
    expect(github.transport.env?.GITHUB_TOKEN).toBe('${cred:GITHUB_TOKEN}');

    // Resources: the multi-file skill is an inline-bundle, the command inline.
    const resources = await app.inject({
      method: 'GET',
      url: '/api/resources',
      headers: authed(jwt),
    });
    const docx = resources.json().resources.find((r: { key: string }) => r.key === 'skill:docx');
    expect(docx.source.type).toBe('inline-bundle');
    const deploy = resources
      .json()
      .resources.find((r: { key: string }) => r.key === 'command:deploy');
    expect(deploy.source.type).toBe('inline');
  });

  it('re-importing identical bodies is a full reuse', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/machines/${machineId}/inventory/import`,
      headers: authed(jwt),
      payload: {
        target: 'claude-code',
        profileName: 'Laptop import again',
        items: [
          { kind: 'skill', name: 'docx' },
          { kind: 'command', name: 'deploy' },
          { kind: 'mcp', name: 'github' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().created).toHaveLength(0);
    expect(res.json().reused).toHaveLength(3);
  });

  it('diff shows local-name matches as applied and the mcp arm as missing until installed', async () => {
    const profiles = await app.inject({
      method: 'GET',
      url: '/api/profiles',
      headers: authed(jwt),
    });
    const profile = profiles
      .json()
      .profiles.find((p: { name: string }) => p.name === 'Laptop import');
    const res = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/inventory/diff?profile=${profile.id}`,
      headers: authed(jwt),
    });
    expect(res.statusCode).toBe(200);
    const diff = res.json().diff;
    // skill + command match by name (local origin); the profile's own mcp
    // entry has no harness-nexus shim on the machine yet → missing.
    expect(diff.upToDate.map((u: { name: string }) => u.name).sort()).toEqual(['deploy', 'docx']);
    expect(diff.missingOnMachine.map((m: { name: string }) => m.name)).toEqual(['github']);
    // The remaining local mcp item is NOT a candidate (mcp items never are).
    expect(diff.notInProfile.map((n: { name: string }) => n.name)).toEqual([]);
  });
});

describe('gates', () => {
  it('scan on an offline machine → 409 MACHINE_OFFLINE', async () => {
    const enroll = await app.inject({
      method: 'POST',
      url: '/api/machines',
      headers: authed(jwt),
      payload: { name: 'offline-box' },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/machines/${enroll.json().machine.id}/inventory/scan`,
      headers: authed(jwt),
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('MACHINE_OFFLINE');
  });

  it('scan from an online daemon without the inventory capability → 409 DAEMON_NO_INVENTORY', async () => {
    const enroll = await app.inject({
      method: 'POST',
      url: '/api/machines',
      headers: authed(jwt),
      payload: { name: 'old-daemon-box' },
    });
    const { machine, token } = enroll.json();
    const oldDaemon = io(`${baseUrl}/ctl`, {
      auth: { token, machineId: machine.id },
      transports: ['websocket'],
    });
    try {
      await once(oldDaemon, 'connect');
      const res = await app.inject({
        method: 'POST',
        url: `/api/machines/${machine.id}/inventory/scan`,
        headers: authed(jwt),
        payload: {},
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('DAEMON_NO_INVENTORY');
    } finally {
      oldDaemon.close();
    }
  });

  it('another user sees 404 (existence hiding) on every inventory endpoint', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'other', password: 'hunter2hunter2' },
    });
    const otherJwt = reg.json().token;
    for (const [method, url] of [
      ['GET', `/api/machines/${machineId}/inventory`],
      ['POST', `/api/machines/${machineId}/inventory/scan`],
      ['POST', `/api/machines/${machineId}/inventory/import`],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: authed(otherJwt),
        ...(method === 'POST'
          ? {
              payload: {
                target: 'codex',
                profileName: 'x',
                items: [{ kind: 'command', name: 'prompt-a' }],
              },
            }
          : {}),
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it('import of an item not in the latest snapshot → 409 INVENTORY_ITEM_MISSING', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/machines/${machineId}/inventory/import`,
      headers: authed(jwt),
      payload: {
        target: 'codex',
        profileName: 'ghost',
        items: [{ kind: 'skill', name: 'never-scanned' }],
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('INVENTORY_ITEM_MISSING');
  });

  it('import for a target never scanned → 404 INVENTORY_NOT_SCANNED', async () => {
    const enroll = await app.inject({
      method: 'POST',
      url: '/api/machines',
      headers: authed(jwt),
      payload: { name: 'partial-box' },
    });
    const { machine, token } = enroll.json();
    const sock = io(`${baseUrl}/ctl`, {
      auth: { token, machineId: machine.id },
      transports: ['websocket'],
    });
    try {
      await once(sock, 'connect');
      await emitAck(sock, 'machine:hello', {
        daemonVersion: '0.2.0-test',
        capabilities: ['inventory'],
      });
      sock.on(
        'inventory:scan',
        (payload: { requestId: string; targets: string[] }, ack?: (r: unknown) => void) => {
          ack?.({ accepted: true });
          for (const target of payload.targets) {
            sock.emit('inventory:report', {
              requestId: payload.requestId,
              snapshot: {
                target,
                scannedAt: new Date().toISOString(),
                agents: [
                  { name: `~/.${target}`, directory: '/x', profileApplied: false, items: [] },
                ],
              },
            });
          }
        },
      );
      // Scan ONLY claude-code; codex stays unscanned for this machine.
      const scan = await app.inject({
        method: 'POST',
        url: `/api/machines/${machine.id}/inventory/scan`,
        headers: authed(jwt),
        payload: { targets: ['claude-code'] },
      });
      expect(scan.statusCode).toBe(200);
      const res = await app.inject({
        method: 'POST',
        url: `/api/machines/${machine.id}/inventory/import`,
        headers: authed(jwt),
        payload: {
          target: 'codex',
          profileName: 'x',
          items: [{ kind: 'command', name: 'prompt-a' }],
        },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('INVENTORY_NOT_SCANNED');
    } finally {
      sock.close();
    }
  });
});
