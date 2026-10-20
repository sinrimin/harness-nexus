// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { testConfig } from './helpers.js';

/**
 * Outlet gate auth (#7): the /mcp mounts sit outside requireAuth and resolve
 * `req.user` themselves. A user PAT rides the root hook; a machine-ctl PAT is
 * NULLed by the root hook (REST blast radius) but the gate accepts it for the
 * `hnx mcp serve` shim — resolving the machine's OWNER, with the ordinary
 * profile-visibility check still applied. Found on the rig: a server-dialed
 * profile entry deployed to claude-code served 0 tools because the shim's
 * outlet passthrough 401'd on the machine PAT.
 */

let app: FastifyInstance;
let baseUrl: string;

let machineId: string;
let machineToken: string;
let marketplacePat: string;
let ownProfileId: string;
let foreignProfileId: string;

const authed = (token: string): { authorization: string } => ({
  authorization: `Bearer ${token}`,
});

/** A minimal streamable-HTTP initialize — enough to pass through the gate. */
const initialize = (profileId: string, token?: string) =>
  app.inject({
    method: 'POST',
    url: `/mcp?profile=${profileId}`,
    headers: {
      ...(token ? authed(token) : {}),
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
        clientInfo: { name: 'outlet-auth-test', version: '0' },
      },
    },
  });

beforeAll(async () => {
  app = await buildApp(testConfig());
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
  void baseUrl;

  // Bootstrap admin (registers first) — not used for the boundary tests: an
  // admin sees every profile, so the owner-visibility boundary needs a
  // REGULAR machine owner.
  await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'root', password: 'hunter2hunter2' },
  });

  const alice = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'alice', password: 'wonderlandwonderland' },
  });
  const aliceJwt = alice.json().token;

  // An EMPTY profile owned by alice — the gate only resolves entry visibility;
  // tool aggregation is out of scope here.
  const profile = await app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: authed(aliceJwt),
    payload: { name: 'outlet-kit', target: 'generic', scope: 'personal', entries: [] },
  });
  ownProfileId = profile.json().profile.id;

  // A third user's PERSONAL profile — invisible to alice (the machine owner).
  const bob = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'bob', password: 'builderbuilder11' },
  });
  const foreign = await app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: authed(bob.json().token),
    payload: { name: 'bob-kit', target: 'generic', scope: 'personal', entries: [] },
  });
  foreignProfileId = foreign.json().profile.id;

  const enroll = await app.inject({
    method: 'POST',
    url: '/api/machines',
    headers: authed(aliceJwt),
    payload: { name: 'outlet-box' },
  });
  machineId = enroll.json().machine.id;
  machineToken = enroll.json().token;

  const pat = await app.inject({
    method: 'POST',
    url: '/api/pats',
    headers: authed(aliceJwt),
    payload: { kind: 'marketplace' },
  });
  marketplacePat = pat.json().token;
}, 20000);

afterAll(async () => {
  await app?.close();
});

describe('outlet gate auth (#7)', () => {
  it('anonymous stays 401', async () => {
    const res = await initialize(ownProfileId);
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('UNAUTHORIZED');
  });

  it('the enrolled machine PAT passes the gate (the hnx mcp serve shim path)', async () => {
    const res = await initialize(ownProfileId, machineToken);
    // Past the gate = the MCP layer answers (initialize accepted). The exact
    // status is the SDK's (200); the point is it is NOT 401/403.
    expect(res.statusCode).toBe(200);
  });

  it('the machine PAT resolves to the OWNER — a foreign personal profile 403s', async () => {
    const res = await initialize(foreignProfileId, machineToken);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('PROFILE_ENTRY_NOT_ACCESSIBLE');
  });

  it('a marketplace-scope PAT is still refused by the outlet (URL-capability tokens only)', async () => {
    const res = await initialize(ownProfileId, marketplacePat);
    expect(res.statusCode).toBe(401);
  });

  it('the REST API still rejects the machine PAT (only the outlet accepts it)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/machines',
      headers: authed(machineToken),
    });
    expect(res.statusCode).toBe(401);
    void machineId;
  });
});
