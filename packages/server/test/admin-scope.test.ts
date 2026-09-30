import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { testConfig } from './helpers.js';

/**
 * #36 — admin scope tightening. Personal resources are owner-ONLY: an admin
 * gets the same 404 as anyone else on another tenant's machines, credentials
 * and MCP servers, and the mcp status list filters like everyone else's. What
 * an admin keeps over a normal user: creating/mutating GLOBAL rows.
 */

async function setup() {
  const app = await buildApp(testConfig());
  // root registers first → bootstrap admin.
  const regRoot = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'root', password: 'hunter2hunter2' },
  });
  const regAlice = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'alice', password: 'wonderlandwonderland' },
  });
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  return {
    app,
    adminAuth: auth(regRoot.json().token as string),
    aliceAuth: auth(regAlice.json().token as string),
  };
}

describe('#36 admin scope tightening', () => {
  it('machine-scoped routes 404 for an admin on a foreign machine', async () => {
    const { app, adminAuth, aliceAuth } = await setup();
    const enroll = await app.inject({
      method: 'POST',
      url: '/api/machines',
      headers: aliceAuth,
      payload: { name: 'alice-box' },
    });
    const machineId: string = enroll.json().machine.id;

    // Reads and writes alike — existence itself is hidden.
    const reads = [
      { method: 'GET', url: `/api/machines/${machineId}/jobs` },
      { method: 'GET', url: `/api/machines/${machineId}/agents` },
      { method: 'GET', url: `/api/machines/${machineId}/runtime-config/claude-code` },
      { method: 'GET', url: `/api/machines/${machineId}/workspace` },
    ];
    for (const r of reads) {
      const res = await app.inject({ method: r.method, url: r.url, headers: adminAuth });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(404);
    }
    const write = await app.inject({
      method: 'POST',
      url: `/api/machines/${machineId}/jobs`,
      headers: adminAuth,
      payload: { type: 'harness', action: 'install', target: 'codex' },
    });
    expect(write.statusCode).toBe(404);
    await app.close();
  });

  it('another user’s personal credential/mcp-server is unmanageable for an admin; global rows remain admin-only turf', async () => {
    const { app, adminAuth, aliceAuth } = await setup();

    const aliceCred = await app.inject({
      method: 'POST',
      url: '/api/credentials',
      headers: aliceAuth,
      payload: { name: 'alice-secret', secret: 's3cret-value', scope: 'personal' },
    });
    expect(aliceCred.statusCode).toBe(201);
    const aliceMcp = await app.inject({
      method: 'POST',
      url: '/api/mcp-servers',
      headers: aliceAuth,
      payload: {
        name: 'alice-mcp',
        transport: { type: 'streamable-http', url: 'http://127.0.0.1:9/mcp' },
        scope: 'personal',
      },
    });
    expect(aliceMcp.statusCode).toBe(201);

    // Admin gets 404 (not 403 — no existence leak) on the personal rows.
    const patchCred = await app.inject({
      method: 'PATCH',
      url: `/api/credentials/${aliceCred.json().credential.id}`,
      headers: adminAuth,
      payload: { name: 'renamed' },
    });
    expect(patchCred.statusCode).toBe(404);
    const delMcp = await app.inject({
      method: 'DELETE',
      url: `/api/mcp-servers/${aliceMcp.json().mcpServer.id}`,
      headers: adminAuth,
    });
    expect(delMcp.statusCode).toBe(404);

    // The global library is exactly where the admin's extra power lives.
    const globalMcp = await app.inject({
      method: 'POST',
      url: '/api/mcp-servers',
      headers: adminAuth,
      payload: {
        name: 'shared-mcp',
        transport: { type: 'streamable-http', url: 'http://127.0.0.1:9/mcp' },
        scope: 'global',
      },
    });
    expect(globalMcp.statusCode).toBe(201);
    const delGlobal = await app.inject({
      method: 'DELETE',
      url: `/api/mcp-servers/${globalMcp.json().mcpServer.id}`,
      headers: adminAuth,
    });
    expect(delGlobal.statusCode).toBe(200);
    await app.close();
  });

  it('mcp status list filters to own personal + global for admins too', async () => {
    const { app, adminAuth, aliceAuth } = await setup();
    await app.inject({
      method: 'POST',
      url: '/api/mcp-servers',
      headers: aliceAuth,
      payload: {
        name: 'alice-mcp',
        transport: { type: 'streamable-http', url: 'http://127.0.0.1:9/mcp' },
        dialSite: 'server',
        scope: 'personal',
      },
    });
    const globalMcp = await app.inject({
      method: 'POST',
      url: '/api/mcp-servers',
      headers: adminAuth,
      payload: {
        name: 'shared-mcp',
        transport: { type: 'streamable-http', url: 'http://127.0.0.1:9/mcp' },
        dialSite: 'server',
        scope: 'global',
      },
    });
    const globalId: string = globalMcp.json().mcpServer.id;

    // The pool's reload is fire-and-forget — poll until the global row's
    // status lands (dead port → an `error` status still lists the row).
    const statusIds = async (): Promise<string[]> =>
      (
        (
          await app.inject({
            method: 'GET',
            url: '/api/mcp-servers/status',
            headers: adminAuth,
          })
        ).json().statuses as { id: string }[]
      ).map((s) => s.id);
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !(await statusIds()).includes(globalId)) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const ids = await statusIds();
    expect(ids).toContain(globalId);
    const aliceRow = (await app.uow.mcpServers.list()).find((s) => s.name === 'alice-mcp');
    expect(aliceRow).toBeDefined();
    expect(ids).not.toContain(aliceRow!.id);
    await app.close();
  });
});
