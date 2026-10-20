// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { harnessJobPayloadSchema } from '@harness-nexus/shared';
import { buildApp } from '../src/app.js';
import { createSqliteUnitOfWork } from '../src/infra/storage/sqlite/index.js';
import { testConfig } from './helpers.js';

/**
 * #21 hardening odds and ends: PAT scopes are server-assigned, harness job
 * npm specs are charset-restricted, the sqlite touchLastUsed bind-order bug
 * is fixed, and /mcp outlet sessions are bound to their creator.
 */

describe('PAT scopes are server-assigned (#21)', () => {
  it('ignores client-supplied capability scopes', async () => {
    const app = await buildApp(testConfig());
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'root', password: 'hunter2hunter2' },
    });
    const jwt: string = reg.json().token;

    const apiPat = await app.inject({
      method: 'POST',
      url: '/api/pats',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { name: 'forged', scopes: ['machine-ctl', 'marketplace'] },
    });
    expect(apiPat.statusCode).toBe(201);
    expect(apiPat.json().pat.scopes).toEqual([]);

    const mktPat = await app.inject({
      method: 'POST',
      url: '/api/pats',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { name: 'emit', kind: 'marketplace', scopes: ['machine-ctl'] },
    });
    expect(mktPat.statusCode).toBe(201);
    expect(mktPat.json().pat.scopes).toEqual(['marketplace']);
    await app.close();
  });
});

describe('harness job npm spec charset (#21)', () => {
  const base = { type: 'harness', action: 'pin', target: 'claude-code' } as const;
  it('accepts bare semver/dist-tag specs and rejects URL/git specs', () => {
    expect(harnessJobPayloadSchema.parse({ ...base, version: '1.2.3' }).version).toBe('1.2.3');
    expect(harnessJobPayloadSchema.parse({ ...base, version: 'latest' }).version).toBe('latest');
    expect(() =>
      harnessJobPayloadSchema.parse({ ...base, version: 'https://evil.example/x.tgz' }),
    ).toThrow();
    expect(() =>
      harnessJobPayloadSchema.parse({ ...base, version: 'git+ssh://evil/x#sec' }),
    ).toThrow();
  });
});

describe('touchLastUsed records the timestamp (#21 bug fix)', () => {
  it('sqlite driver updates last_used_at for the right row', async (ctx) => {
    // The better-sqlite3 native binding is per-NODE_MAJOR; on a dev box whose
    // binding was compiled for a different major than the running Node, load
    // throws — skip environmentally (CI builds it for its own Node and runs
    // this for real).
    let uow: ReturnType<typeof createSqliteUnitOfWork>;
    try {
      uow = createSqliteUnitOfWork(':memory:');
    } catch {
      return ctx.skip('better-sqlite3 native binding unavailable for this Node major');
    }
    const now = new Date().toISOString();
    await uow.users.save({
      id: 'u1',
      username: 'tester',
      email: undefined,
      passwordHash: 'x',
      role: 'user',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await uow.tokens.save({
      id: 'pat-1',
      userId: 'u1',
      name: 'cli',
      tokenHash: 'h',
      prefix: 'hnxpa',
      scopes: [],
      expiresAt: null,
      lastUsedAt: null,
      createdAt: now,
    });
    await uow.tokens.touchLastUsed('pat-1', '2026-09-23T00:00:00.000Z');
    const row = await uow.tokens.findById('pat-1');
    expect(row?.lastUsedAt).toBe('2026-09-23T00:00:00.000Z');
  });

  it('an authenticated request stamps lastUsedAt end-to-end', async () => {
    const app = await buildApp(testConfig());
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'root', password: 'hunter2hunter2' },
    });
    const jwt: string = reg.json().token;
    const pat = await app.inject({
      method: 'POST',
      url: '/api/pats',
      headers: { authorization: `Bearer ${jwt}` },
      payload: { name: 'cli' },
    });
    const raw: string = pat.json().token;
    const before = (
      await app.inject({
        method: 'GET',
        url: '/api/pats',
        headers: { authorization: `Bearer ${raw}` },
      })
    ).json().pats as { lastUsedAt: string | null }[];
    // The very request above authenticated via the PAT → the stamp is set.
    expect(before[0].lastUsedAt).not.toBeNull();
    await app.close();
  });
});

describe('/mcp outlet sessions bind to their creator (#21)', () => {
  it('rejects a foreign session id even with valid credentials', async () => {
    const app = await buildApp(testConfig());
    const regAlice = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'wonderlandwonderland' },
    });
    const aliceJwt: string = regAlice.json().token;
    const regBob = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'bob', password: 'builderbuilder11' },
    });
    const bobJwt: string = regBob.json().token;

    const mkProfile = async (token: string, name: string) =>
      (
        await app.inject({
          method: 'POST',
          url: '/api/profiles',
          headers: { authorization: `Bearer ${token}` },
          payload: { name, target: 'generic', scope: 'personal', entries: [] },
        })
      ).json().profile.id as string;
    const aliceProfile = await mkProfile(aliceJwt, 'alice-kit');
    const bobProfile = await mkProfile(bobJwt, 'bob-kit');

    const init = await app.inject({
      method: 'POST',
      url: `/mcp?profile=${aliceProfile}`,
      headers: {
        authorization: `Bearer ${aliceJwt}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      payload: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'session-bind-test', version: '0' },
        },
      },
    });
    expect(init.statusCode).toBe(200);
    const sessionId = init.headers['mcp-session-id'] as string | undefined;
    expect(sessionId).toBeTruthy();

    // Bob replays ALICE's session id against his own (valid) profile: the
    // gate passes, but the session must refuse to serve him.
    const replay = await app.inject({
      method: 'POST',
      url: `/mcp?profile=${bobProfile}`,
      headers: {
        authorization: `Bearer ${bobJwt}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId!,
      },
      payload: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      },
    });
    expect(replay.statusCode).toBe(404);
    expect(replay.json().error).toBe('SESSION_NOT_FOUND');
    await app.close();
  });
});
