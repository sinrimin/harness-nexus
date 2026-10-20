// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { testConfig, waitFor } from './helpers.js';

/**
 * McpRegistry reload resilience (surfaced by the 8 T1 smoke): a stdio row
 * whose `auto` dial site derives SERVER (a `${cred:...}` placeholder whose
 * credential does not exist — the C3 import shape) must be SKIPPED with a
 * warning, never crash the fire-and-forget reload (Phase 2.2 rule:
 * unreachable/misconfigured upstreams never block the pool).
 */
let app: FastifyInstance;
let jwt: string;
let rootId: string;
let baseUrl: string;

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
  rootId = reg.json().user.id;
}, 20000);

afterAll(async () => {
  await app?.close();
});

describe('server-dial pool resilience', () => {
  it('skips an unresolvable stdio row instead of crashing the reload', async () => {
    // stdio + auto + a placeholder whose credential does not exist ⇒ derives
    // SERVER ⇒ resolveTransport throws ⇒ must be skipped with a warning.
    // The route layer rejects this shape at CREATE time (409 STDIO_REQUIRES_
    // CLIENT) — the only producer is the C3 import, which saves rows directly
    // through the UnitOfWork, so the fixture does the same.
    const now = new Date().toISOString();
    await app.uow.mcpServers.save({
      id: 'm-poisoned',
      name: 'imported-stdio',
      transport: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'smoke-mcp'],
        env: { SMOKE_KEY: '${cred:DOES_NOT_EXIST}' },
      },
      dialSite: 'auto',
      scope: 'personal',
      ownerId: rootId,
      createdAt: now,
      updatedAt: now,
    });

    // Any later mutation re-runs the fire-and-forget reload over ALL rows —
    // pre-fix this crashed the process with an unhandled rejection.
    const trigger = await app.inject({
      method: 'POST',
      url: '/api/mcp-servers',
      headers: authed(jwt),
      payload: {
        name: 'unrelated-http',
        transport: { type: 'streamable-http', url: 'https://unreachable.example.invalid/mcp' },
        dialSite: 'server',
        scope: 'personal',
      },
    });
    expect(trigger.statusCode).toBe(201);

    // Give the fire-and-forget reload a moment; then prove the server (and
    // the registry) are still alive and the poisoned row never pooled.
    await waitFor(async () => {
      const statuses = await app.inject({
        method: 'GET',
        url: '/api/mcp-servers/status',
        headers: authed(jwt),
      });
      if (statuses.statusCode !== 200) return false;
      const rows = statuses.json().statuses as { id: string; name: string }[];
      return rows.some((s) => s.name === 'unrelated-http');
    });

    const after = await app.inject({
      method: 'GET',
      url: '/api/mcp-servers/status',
      headers: authed(jwt),
    });
    expect(after.statusCode).toBe(200);
    const names = (after.json().statuses as { name: string }[]).map((s) => s.name);
    expect(names).toContain('unrelated-http');
    expect(names).not.toContain('imported-stdio');
  });

  it('connectServer on such a row → 409 not_dialable (config error, not a crash)', async () => {
    const rows = await app.inject({
      method: 'GET',
      url: '/api/mcp-servers',
      headers: authed(jwt),
    });
    const target = (rows.json().mcpServers as { id: string; name: string }[]).find(
      (m) => m.name === 'imported-stdio',
    );
    expect(target).toBeDefined();
    const res = await app.inject({
      method: 'POST',
      url: `/api/mcp-servers/${target!.id}/connect`,
      headers: authed(jwt),
    });
    expect(res.statusCode).toBe(409);
  });
});
