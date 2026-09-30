import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { testConfig } from './helpers.js';

/**
 * #21 — GET /api/mcp-servers/status spans every tenant's pooled upstreams;
 * every caller (admins included — #36) must only see rows visible to them
 * (names and upstream error details are tenant data).
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
  const adminJwt = await reg('root');
  const aliceJwt = await reg('alice');
  const bobJwt = await reg('bob');
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });

  // Alice's personal server-dialed row pointing at a dead local port (fast
  // refusal → the pool records an `error` status without network egress).
  const created = await app.inject({
    method: 'POST',
    url: '/api/mcp-servers',
    headers: auth(aliceJwt),
    payload: {
      name: 'alice-private',
      transport: { type: 'streamable-http', url: 'http://127.0.0.1:9/mcp' },
      dialSite: 'server',
      scope: 'personal',
    },
  });
  expect(created.statusCode).toBe(201);
  const serverId: string = created.json().mcpServer.id;

  // The route's reload() is fire-and-forget; poll until the row shows up in
  // the owner's own status view (the pool records `error` — dead local port).
  const statusFor = async (token: string) =>
    (
      await app.inject({
        method: 'GET',
        url: '/api/mcp-servers/status',
        headers: auth(token),
      })
    ).json().statuses as { id: string }[];
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !(await statusFor(aliceJwt)).some((s) => s.id === serverId)) {
    await new Promise((r) => setTimeout(r, 20));
  }
  expect((await statusFor(aliceJwt)).some((s) => s.id === serverId)).toBe(true);

  return { app, adminJwt, aliceJwt, bobJwt, serverId, statusFor };
}

describe('mcp-servers status visibility (#21)', () => {
  it("hides other tenants' rows from regular users and admins alike (#36)", async () => {
    const { app, adminJwt, aliceJwt, bobJwt, serverId, statusFor } = await setup();

    const aliceIds = (await statusFor(aliceJwt)).map((s) => s.id);
    expect(aliceIds).toContain(serverId);

    const bobIds = (await statusFor(bobJwt)).map((s) => s.id);
    expect(bobIds).not.toContain(serverId);

    const adminIds = (await statusFor(adminJwt)).map((s) => s.id);
    expect(adminIds).not.toContain(serverId);
    await app.close();
  });
});
