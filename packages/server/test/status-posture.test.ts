import { describe, expect, it } from 'vitest';
import type { AgentInstance, Job } from '@harness-nexus/core';
import { buildApp } from '../src/app.js';
import { testConfig } from './helpers.js';

/**
 * #23 D2 — GET /api/status/posture. The readout strip's numbers must mean what
 * the list pages mean, per viewer, and each figure declares its own scope
 * (admin-sees-all is NOT uniform: chat is owner-only, MCP/LLM lists are
 * own-personal + global for every role).
 */

type PostureJson = {
  scope: string;
  scopes: Record<string, string>;
  machines: { online: number; total: number };
  agents: number;
  mcp: { connected: number; total: number };
  llmProviders: number;
  queuedJobs: number;
  channels: number;
};

async function setup() {
  // ttl 0 = no caching, so each assertion reads fresh state.
  const app = await buildApp(testConfig({ postureCacheTtlMs: 0 }));
  const reg = async (username: string) => {
    const body = (
      await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username, password: 'hunter2hunter2' },
      })
    ).json();
    return { token: body.token as string, id: body.user.id as string };
  };
  const admin = await reg('root');
  const alice = await reg('alice');
  const adminJwt = admin.token;
  const aliceJwt = alice.token;
  const bobJwt = (await reg('bob')).token;
  const auth = (t: string) => ({ authorization: `Bearer ${t}` });
  const posture = async (t: string): Promise<PostureJson> =>
    (
      await app.inject({ method: 'GET', url: '/api/status/posture', headers: auth(t) })
    ).json() as PostureJson;
  return { app, adminJwt, aliceJwt, bobJwt, aliceId: alice.id, auth, posture };
}

describe('GET /api/status/posture (#23 D2)', () => {
  it('requires auth', async () => {
    const app = await buildApp(testConfig({ postureCacheTtlMs: 0 }));
    const res = await app.inject({ method: 'GET', url: '/api/status/posture' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('scopes each figure to what its own list page shows', async () => {
    const { app, adminJwt, aliceJwt, bobJwt, aliceId, auth, posture } = await setup();

    // Alice enrolls a machine (admin sees it under scope 'all'; bob sees none).
    const enrolled = await app.inject({
      method: 'POST',
      url: '/api/machines',
      headers: auth(aliceJwt),
      payload: { name: 'alice-box' },
    });
    expect(enrolled.statusCode).toBe(201);
    const machineId: string = enrolled.json().machine.id;

    // A queued job + an agent instance on that machine (repo-level: the route
    // needs a real profile; the aggregate only reads the rows).
    const now = new Date().toISOString();
    const job: Job = {
      id: 'job-queued-1',
      machineId,
      ownerId: aliceId,
      type: 'scan',
      status: 'queued',
      payload: {},
      result: null,
      error: null,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    await app.uow.jobs.save(job);
    const agent: AgentInstance = {
      id: 'agent-1',
      machineId,
      ownerId: aliceId,
      target: 'claude-code',
      profileId: null,
      profileVersion: null,
      name: 'claude-code',
      directory: '/home/alice',
      jobId: null,
      source: 'detected',
      createdAt: now,
      updatedAt: now,
    };
    await app.uow.agentInstances.save(agent);

    // Alice's personal MCP row + a global one (created by the admin) — the
    // MCP figure follows the LIST rule (own personal + global) for every role.
    await app.uow.mcpServers.save({
      id: 'mcp-alice',
      name: 'alice-private',
      transport: { type: 'streamable-http', url: 'http://127.0.0.1:9/mcp' },
      dialSite: 'server',
      scope: 'personal',
      ownerId: aliceId,
      createdAt: now,
      updatedAt: now,
    } as never);
    await app.uow.mcpServers.save({
      id: 'mcp-global',
      name: 'shared',
      transport: { type: 'streamable-http', url: 'http://127.0.0.1:9/mcp' },
      dialSite: 'server',
      scope: 'global',
      ownerId: null,
      createdAt: now,
      updatedAt: now,
    } as never);

    const alice = await posture(aliceJwt);
    const bob = await posture(bobJwt);
    const admin = await posture(adminJwt);

    // Machines: alice owns one; bob sees none; the admin sees the whole fleet.
    expect(alice.machines).toEqual({ online: 0, total: 1 });
    expect(bob.machines).toEqual({ online: 0, total: 0 });
    expect(admin.machines).toEqual({ online: 0, total: 1 });
    expect(alice.scope).toBe('self');
    expect(admin.scope).toBe('all');
    expect(admin.scopes.machines).toBe('all');

    // Agents + queued jobs ride the same visibility as machines.
    expect(alice.agents).toBe(1);
    expect(alice.queuedJobs).toBe(1);
    expect(bob.agents).toBe(0);
    expect(bob.queuedJobs).toBe(0);
    expect(admin.agents).toBe(1);
    expect(admin.queuedJobs).toBe(1);
    expect(admin.scopes.agents).toBe('all');
    expect(admin.scopes.queuedJobs).toBe('all');

    // MCP: alice sees her personal + the global row; bob sees only global.
    // Even the admin's MCP number stays 'self' — the MCP page shows own
    // personal + global, so a site-wide claim here would contradict it.
    expect(alice.mcp).toEqual({ connected: 0, total: 2 });
    expect(bob.mcp).toEqual({ connected: 0, total: 1 });
    expect(admin.mcp).toEqual({ connected: 0, total: 1 });
    expect(admin.scopes.mcp).toBe('self');

    // LLM providers + channels: owner-scoped for every role.
    expect(alice.llmProviders).toBe(0);
    expect(admin.scopes.llmProviders).toBe('self');
    expect(admin.scopes.channels).toBe('self');
    expect(admin.channels).toBe(0);

    await app.close();
  });

  it('caches per viewer and drops the cache on a presence transition', async () => {
    const app = await buildApp(testConfig({ postureCacheTtlMs: 60_000 }));
    const jwt = (await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'root', password: 'hunter2hunter2' },
    })).json().token as string;
    const auth = { authorization: `Bearer ${jwt}` };
    const posture = async () =>
      (await app.inject({ method: 'GET', url: '/api/status/posture', headers: auth })).json();

    expect((await posture()).machines.total).toBe(0);
    // Enrolling is not a presence event → the cached aggregate is unchanged.
    await app.inject({
      method: 'POST',
      url: '/api/machines',
      headers: auth,
      payload: { name: 'box' },
    });
    expect((await posture()).machines.total).toBe(0);
    // A presence transition invalidates it (the realtime plugin calls in).
    app.posture.invalidate();
    expect((await posture()).machines.total).toBe(1);
    await app.close();
  });
});