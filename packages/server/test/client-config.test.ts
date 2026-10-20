// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { testConfig } from './helpers.js';

/**
 * Client config fetch (Phase 8 C2) — the `hnx mcp serve` shim's world model.
 * The load-bearing assertions: resolved transports (plaintext included) are
 * returned for CLIENT-dialed servers only; a non-distributable credential's
 * plaintext NEVER appears in any response; machine PATs authenticate as their
 * machine's owner (the one REST exception).
 */

async function setup() {
  const app = await buildApp(testConfig());

  // root = bootstrap admin; alice = plain user.
  const regRoot = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'root', password: 'hunter2hunter2' },
  });
  const rootToken: string = regRoot.json().token;
  const regAlice = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'alice', password: 'hunter2hunter2' },
  });
  const aliceJwt: string = regAlice.json().token;

  // An api PAT for alice (machine PATs are REST-rejected everywhere else).
  const pat = await app.inject({
    method: 'POST',
    url: '/api/pats',
    headers: { authorization: `Bearer ${aliceJwt}` },
    payload: { name: 'cli' },
  });
  const alicePat: string = pat.json().token;

  return {
    app,
    rootToken,
    aliceJwt,
    alicePat,
    auth: (t: string) => ({ authorization: `Bearer ${t}` }),
  };
}

async function seedMcpWorld(
  app: ReturnType<Awaited<ReturnType<typeof setup>>>['app'],
  aliceJwt: string,
  rootToken: string,
  auth: (t: string) => { authorization: string },
) {
  // Credentials: personal (always distributable), global locked (default),
  // global distributable (admin opt-in).
  await app.inject({
    method: 'POST',
    url: '/api/credentials',
    headers: auth(aliceJwt),
    payload: { name: 'mine', secret: 'my-personal-secret', scope: 'personal' },
  });
  await app.inject({
    method: 'POST',
    url: '/api/credentials',
    headers: auth(rootToken),
    payload: { name: 'corp', secret: 'CORP-LOCKED-SECRET', scope: 'global' },
  });
  await app.inject({
    method: 'POST',
    url: '/api/credentials',
    headers: auth(rootToken),
    payload: {
      name: 'shared',
      secret: 'shared-distributable-secret',
      scope: 'global',
      distributable: true,
    },
  });

  const post = async (token: string, body: unknown) =>
    (
      await app.inject({
        method: 'POST',
        url: '/api/mcp-servers',
        headers: auth(token),
        payload: body,
      })
    ).json();

  const stdio = await post(aliceJwt, {
    name: 'local echo',
    transport: { type: 'stdio', command: 'echo-bin', args: ['${cred:mine}'] },
    dialSite: 'auto',
    scope: 'personal',
  });
  const httpMine = await post(aliceJwt, {
    name: 'api mine',
    transport: { type: 'streamable-http', url: 'https://api.example/mcp?key=${cred:mine}' },
    dialSite: 'auto',
    scope: 'personal',
  });
  const httpCorp = await post(aliceJwt, {
    name: 'corp api',
    transport: {
      type: 'streamable-http',
      url: 'https://corp.example/mcp',
      headers: { Authorization: 'Bearer ${cred:corp}' },
    },
    dialSite: 'auto',
    scope: 'personal',
  });
  const httpShared = await post(aliceJwt, {
    name: 'shared api',
    transport: { type: 'sse', url: 'https://shared.example/mcp?t=${cred:shared}' },
    dialSite: 'auto',
    scope: 'personal',
  });

  const profile = (
    await app.inject({
      method: 'POST',
      url: '/api/profiles',
      headers: auth(aliceJwt),
      payload: {
        name: 'mixed',
        target: 'claude-code',
        scope: 'personal',
        entries: [
          { mcpServerId: stdio.mcpServer.id },
          { mcpServerId: httpMine.mcpServer.id },
          { mcpServerId: httpCorp.mcpServer.id },
          { mcpServerId: httpShared.mcpServer.id },
        ],
      },
    })
  ).json();

  return { servers: { stdio, httpMine, httpCorp, httpShared }, profileId: profile.profile.id };
}

describe('GET /api/client/mcp-config', () => {
  it('returns resolved transports for client-dialed servers only; never leaks locked plaintext', async () => {
    const ctx = await setup();
    const { profileId } = await seedMcpWorld(ctx.app, ctx.aliceJwt, ctx.rootToken, ctx.auth);

    const res = await ctx.app.inject({
      method: 'GET',
      url: `/api/client/mcp-config?profile=${profileId}`,
      headers: ctx.auth(ctx.alicePat),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    const byName = new Map(body.servers.map((s: { name: string }) => [s.name, s]));

    // Client-dialed: stdio (placeholders in args resolved to the personal secret).
    const stdio = byName.get('local echo');
    expect(stdio.dialSite).toBe('client');
    expect(stdio.transport.type).toBe('stdio');
    expect(stdio.transport.args).toEqual(['my-personal-secret']);

    // Client-dialed: personal-cred HTTP (url resolved).
    expect(byName.get('api mine').transport.url).toBe(
      'https://api.example/mcp?key=my-personal-secret',
    );

    // Client-dialed: distributable GLOBAL cred (admin opt-in).
    expect(byName.get('shared api').transport.url).toBe(
      'https://shared.example/mcp?t=shared-distributable-secret',
    );

    // Server-dialed: non-distributable global cred — name only, NO transport,
    // and the outlet block is present.
    const corp = byName.get('corp api');
    expect(corp.dialSite).toBe('server');
    expect(corp.transport).toBeUndefined();
    expect(body.platform).toEqual({ baseUrl: 'http://127.0.0.1:1' });

    // THE load-bearing assertion: the locked secret never appears anywhere.
    expect(res.body.includes('CORP-LOCKED-SECRET')).toBe(false);
    await ctx.app.close();
  });

  it('accepts a machine PAT as its machine owner (the one REST exception)', async () => {
    const ctx = await setup();
    const { profileId } = await seedMcpWorld(ctx.app, ctx.aliceJwt, ctx.rootToken, ctx.auth);

    const enroll = await ctx.app.inject({
      method: 'POST',
      url: '/api/machines',
      headers: ctx.auth(ctx.aliceJwt),
      payload: { name: 'alice-laptop' },
    });
    const machineToken: string = enroll.json().token;

    const ok = await ctx.app.inject({
      method: 'GET',
      url: `/api/client/mcp-config?profile=${profileId}`,
      headers: ctx.auth(machineToken),
    });
    expect(ok.statusCode).toBe(200);

    // A machine PAT from ANOTHER user cannot see alice's personal profile.
    const regBob = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'bob', password: 'hunter2hunter2' },
    });
    const bobEnroll = await ctx.app.inject({
      method: 'POST',
      url: '/api/machines',
      headers: ctx.auth(regBob.json().token),
      payload: { name: 'bob-box' },
    });
    const bobMachineToken: string = bobEnroll.json().token;
    const denied = await ctx.app.inject({
      method: 'GET',
      url: `/api/client/mcp-config?profile=${profileId}`,
      headers: ctx.auth(bobMachineToken),
    });
    expect(denied.statusCode).toBe(404);
    await ctx.app.close();
  });

  it('rejects anonymous callers and marketplace tokens', async () => {
    const ctx = await setup();
    const { profileId } = await seedMcpWorld(ctx.app, ctx.aliceJwt, ctx.rootToken, ctx.auth);

    const anon = await ctx.app.inject({
      method: 'GET',
      url: `/api/client/mcp-config?profile=${profileId}`,
    });
    expect(anon.statusCode).toBe(401);

    const mk = await ctx.app.inject({
      method: 'POST',
      url: '/api/pats',
      headers: ctx.auth(ctx.aliceJwt),
      payload: { name: 'emit', kind: 'marketplace' },
    });
    const denied = await ctx.app.inject({
      method: 'GET',
      url: `/api/client/mcp-config?profile=${profileId}`,
      headers: ctx.auth(mk.json().token),
    });
    expect(denied.statusCode).toBe(401);
    await ctx.app.close();
  });
});

describe('dial-site matrix enforcement at create (409s)', () => {
  it('rejects explicit server dial for stdio, and client dial with a locked credential', async () => {
    const ctx = await setup();
    await ctx.app.inject({
      method: 'POST',
      url: '/api/credentials',
      headers: ctx.auth(ctx.rootToken),
      payload: { name: 'corp', secret: 'CORP-LOCKED-SECRET', scope: 'global' },
    });

    const stdioServer = await ctx.app.inject({
      method: 'POST',
      url: '/api/mcp-servers',
      headers: ctx.auth(ctx.aliceJwt),
      payload: {
        name: 'bad stdio',
        transport: { type: 'stdio', command: 'x' },
        dialSite: 'server',
        scope: 'personal',
      },
    });
    expect(stdioServer.statusCode).toBe(409);
    expect(stdioServer.json().error).toBe('STDIO_REQUIRES_CLIENT');

    const clientLocked = await ctx.app.inject({
      method: 'POST',
      url: '/api/mcp-servers',
      headers: ctx.auth(ctx.aliceJwt),
      payload: {
        name: 'bad client',
        transport: { type: 'streamable-http', url: 'https://x/${cred:corp}' },
        dialSite: 'client',
        scope: 'personal',
      },
    });
    expect(clientLocked.statusCode).toBe(409);
    expect(clientLocked.json().error).toBe('CREDENTIAL_NOT_DISTRIBUTABLE');
    await ctx.app.close();
  });
});
