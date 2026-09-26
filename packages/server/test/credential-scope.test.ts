import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { testConfig } from './helpers.js';

/**
 * #21 — credential names resolve within ONE owner's namespace.
 * A same-named credential owned by another tenant must never decrypt (no
 * shadowing), duplicate names within one (scope, owner) are rejected, and a
 * locked global secret cannot be pointed at a caller-chosen endpoint.
 */

async function setup() {
  const app = await buildApp(testConfig());

  const reg = async (username: string) =>
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username, password: 'hunter2hunter2' },
      })
    ).json().token as string;

  const rootToken = await reg('root');
  const aliceJwt = await reg('alice');
  const bobJwt = await reg('bob');
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  return { app, rootToken, aliceJwt, bobJwt, auth };
}

async function createCred(
  app: ReturnType<Awaited<ReturnType<typeof setup>>>['app'],
  token: string,
  body: unknown,
): Promise<number> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/credentials',
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
  return res.statusCode;
}

/** A personal HTTP MCP row + profile referencing `${cred:<name>}` for a user. */
async function seedProfileReferencing(
  app: ReturnType<Awaited<ReturnType<typeof setup>>>['app'],
  token: string,
  credName: string,
): Promise<string> {
  const server = (
    await app.inject({
      method: 'POST',
      url: '/api/mcp-servers',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: `srv-${credName}`,
        transport: {
          type: 'streamable-http',
          url: `https://upstream.example/mcp?key=\${cred:${credName}}`,
        },
        dialSite: 'auto',
        scope: 'personal',
      },
    })
  ).json().mcpServer;
  const profile = (
    await app.inject({
      method: 'POST',
      url: '/api/profiles',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: `prof-${credName}`,
        target: 'claude-code',
        scope: 'personal',
        entries: [{ mcpServerId: server.id }],
      },
    })
  ).json().profile;
  return profile.id as string;
}

describe('credential scoping (#21)', () => {
  it('resolves same-named personal credentials per owner — no cross-tenant shadowing', async () => {
    const { app, aliceJwt, bobJwt, auth } = await setup();
    expect(
      await createCred(app, aliceJwt, { name: 'dup', secret: 'ALICE-SECRET', scope: 'personal' }),
    ).toBe(201);
    expect(
      await createCred(app, bobJwt, { name: 'dup', secret: 'BOB-SECRET', scope: 'personal' }),
    ).toBe(201);

    for (const [token, expected] of [
      [aliceJwt, 'ALICE-SECRET'],
      [bobJwt, 'BOB-SECRET'],
    ] as const) {
      const profileId = await seedProfileReferencing(app, token, 'dup');
      const res = await app.inject({
        method: 'GET',
        url: `/api/client/mcp-config?profile=${profileId}`,
        headers: auth(token),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(JSON.stringify(body)).toContain(expected);
      expect(JSON.stringify(body)).not.toContain(
        expected === 'ALICE-SECRET' ? 'BOB-SECRET' : 'ALICE-SECRET',
      );
    }
  });

  it("a name that only exists in another tenant's namespace never decrypts", async () => {
    const { app, aliceJwt, bobJwt, auth } = await setup();
    expect(
      await createCred(app, aliceJwt, {
        name: 'only-alice',
        secret: 'ALICE-ONLY-SECRET',
        scope: 'personal',
      }),
    ).toBe(201);

    // Bob references the name with NO credential of his own and no global
    // row: the dial site derives 'server' (missing ⇒ non-distributable) and
    // the shim config must carry NO transport — pre-#21 the bare-name lookup
    // found Alice's row and shipped her plaintext to Bob.
    const profileId = await seedProfileReferencing(app, bobJwt, 'only-alice');
    const res = await app.inject({
      method: 'GET',
      url: `/api/client/mcp-config?profile=${profileId}`,
      headers: auth(bobJwt),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(JSON.stringify(body)).not.toContain('ALICE-ONLY-SECRET');
    expect(body.platform).not.toBeNull();
    const entry = body.servers.find((s: { name: string }) => s.name === 'srv-only-alice');
    expect(entry.dialSite).toBe('server');
    expect(entry.transport).toBeUndefined();
    void aliceJwt;
  });

  it('rejects duplicate names within one (scope, owner) on create and rename', async () => {
    const { app, rootToken, aliceJwt } = await setup();
    expect(await createCred(app, aliceJwt, { name: 'dup', secret: 's1', scope: 'personal' })).toBe(
      201,
    );
    const again = await createCred(app, aliceJwt, { name: 'dup', secret: 's2', scope: 'personal' });
    expect(again).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/credentials',
          headers: { authorization: `Bearer ${rootToken}` },
          payload: { name: 'corp', secret: 's', scope: 'global' },
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/credentials',
          headers: { authorization: `Bearer ${rootToken}` },
          payload: { name: 'corp', secret: 's2', scope: 'global' },
        })
      ).statusCode,
    ).toBe(409);

    // Rename Alice's other credential onto the taken name → 409 as well.
    expect(
      await createCred(app, aliceJwt, { name: 'other', secret: 's3', scope: 'personal' }),
    ).toBe(201);
    const list = (
      await app.inject({
        method: 'GET',
        url: '/api/credentials',
        headers: { authorization: `Bearer ${aliceJwt}` },
      })
    ).json().credentials as { id: string; name: string }[];
    const other = list.find((c) => c.name === 'other')!;
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/credentials/${other.id}`,
      headers: { authorization: `Bearer ${aliceJwt}` },
      payload: { name: 'dup' },
    });
    expect(patch.statusCode).toBe(409);
    expect(patch.json().error).toBe('CREDENTIAL_NAME_TAKEN');
  });

  it('locked global secrets cannot reach a caller-chosen endpoint', async () => {
    const { app, rootToken, bobJwt } = await setup();
    expect(
      await createCred(app, rootToken, { name: 'corp', secret: 'CORP-LOCKED', scope: 'global' }),
    ).toBe(201);

    // A personal provider's baseUrl is caller-chosen → blocked at create.
    const create = await app.inject({
      method: 'POST',
      url: '/api/llm-providers',
      headers: { authorization: `Bearer ${bobJwt}` },
      payload: { name: 'stealer', api: 'openai-chat', credentialName: 'corp', scope: 'personal' },
    });
    expect(create.statusCode).toBe(403);
    expect(create.json().error).toBe('CREDENTIAL_NOT_DISTRIBUTABLE');

    // The query-models manual arm (arbitrary baseUrl) → blocked too.
    const query = await app.inject({
      method: 'POST',
      url: '/api/llm-providers/query-models',
      headers: { authorization: `Bearer ${bobJwt}` },
      payload: {
        api: 'openai-chat',
        baseUrl: 'https://attacker.example/v1',
        credentialName: 'corp',
      },
    });
    expect(query.statusCode).toBe(403);
    expect(query.json().error).toBe('CREDENTIAL_NOT_DISTRIBUTABLE');

    // The admin who owns the secret may still reference it (global provider).
    const adminCreate = await app.inject({
      method: 'POST',
      url: '/api/llm-providers',
      headers: { authorization: `Bearer ${rootToken}` },
      payload: {
        name: 'official',
        api: 'openai-chat',
        credentialName: 'corp',
        scope: 'global',
        baseUrl: 'https://official.example/v1',
      },
    });
    expect(adminCreate.statusCode).toBe(201);
  });
});

describe('server-dial failures are actionable (#25)', () => {
  it('a global row referencing a personal-only credential answers 409 with the scope rule, not a 500', async () => {
    const { app, rootToken, aliceJwt, auth } = await setup();
    expect(
      await createCred(app, aliceJwt, {
        name: 'alice-key',
        secret: 'ALICE-KEY',
        scope: 'personal',
      }),
    ).toBe(201);

    // Admin-created GLOBAL row whose header references ALICE's personal
    // credential — resolvable pre-#21 (bare-name lookup), out of scope now.
    const created = await app.inject({
      method: 'POST',
      url: '/api/mcp-servers',
      headers: auth(rootToken),
      payload: {
        name: 'global-needs-personal',
        transport: {
          type: 'streamable-http',
          url: 'https://upstream.example/mcp',
          headers: { Authorization: 'Bearer ${cred:alice-key}' },
        },
        dialSite: 'server',
        scope: 'global',
      },
    });
    expect(created.statusCode).toBe(201);
    const id: string = created.json().mcpServer.id;

    const connect = await app.inject({
      method: 'POST',
      url: `/api/mcp-servers/${id}/connect`,
      headers: auth(rootToken),
    });
    expect(connect.statusCode).toBe(409);
    expect(connect.json().error).toBe('NOT_SERVER_DIALED');
    expect(connect.json().message).toContain('alice-key');
    expect(connect.json().message).toContain('global credentials only');
    await app.close();
  });
});
