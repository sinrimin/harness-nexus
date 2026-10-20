// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { testConfig } from './helpers.js';

/**
 * Two-stage delete (soft → hard) for MCP servers and resources:
 *   1. First DELETE soft-deletes — the row leaves the default list, shows via
 *      ?includeDeleted=1 (profile editor greys it), and a profile entry that
 *      references it can no longer be re-added (409).
 *   2. Deploy paths skip the dangling entry instead of failing (deploy-bundle).
 *   3. A second DELETE while a profile still references it → 409
 *      ASSET_STILL_REFERENCED; after the profile save strips the entry, the
 *      second DELETE physically removes the row (mode 'hard').
 */

async function setup() {
  const app = await buildApp(testConfig());
  const reg = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'alice', password: 'hunter2hunter2' },
  });
  const jwt: string = reg.json().token;
  const pat = await app.inject({
    method: 'POST',
    url: '/api/pats',
    headers: { authorization: `Bearer ${jwt}` },
    payload: { name: 'cli' },
  });
  return { app, jwt, pat: pat.json().token as string, auth: { authorization: `Bearer ${jwt}` } };
}

async function seedMcp(app: ReturnType<Awaited<ReturnType<typeof setup>>>['app'], auth: object) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/mcp-servers',
    headers: auth,
    payload: {
      name: 'upstream-a',
      dialSite: 'client',
      scope: 'personal',
      transport: { type: 'streamable-http', url: 'https://a.example.com/mcp' },
    },
  });
  return res.json().mcpServer.id as string;
}

async function seedSkill(app: ReturnType<Awaited<ReturnType<typeof setup>>>['app'], auth: object) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/resources',
    headers: auth,
    payload: {
      key: 'skill-soft',
      kind: 'skill',
      name: 'Soft Skill',
      source: { type: 'inline', content: '# hi' },
      scope: 'personal',
      targets: [],
    },
  });
  return res.json().resource.id as string;
}

async function seedProfile(
  app: ReturnType<Awaited<ReturnType<typeof setup>>>['app'],
  auth: object,
  mcpId: string,
  skillId: string,
) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/profiles',
    headers: auth,
    payload: {
      name: 'P1',
      target: 'claude-code',
      scope: 'personal',
      version: '0.1',
      entries: [{ mcpServerId: mcpId }, { resourceId: skillId, kind: 'skill' }],
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json().profile.id as string;
}

describe('two-stage delete', () => {
  it('soft-deletes on first DELETE, hides from the default list, survives via includeDeleted', async () => {
    const { app, auth } = await setup();
    const mcpId = await seedMcp(app, auth);
    const skillId = await seedSkill(app, auth);
    await seedProfile(app, auth, mcpId, skillId);

    const first = await app.inject({
      method: 'DELETE',
      url: `/api/mcp-servers/${mcpId}`,
      headers: auth,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().mode).toBe('soft');

    const listed = await app.inject({ method: 'GET', url: '/api/mcp-servers', headers: auth });
    expect(listed.json().mcpServers.map((s: { id: string }) => s.id)).not.toContain(mcpId);
    const withDeleted = await app.inject({
      method: 'GET',
      url: '/api/mcp-servers?includeDeleted=1',
      headers: auth,
    });
    const row = withDeleted.json().mcpServers.find((s: { id: string }) => s.id === mcpId);
    expect(row?.deletedAt).toBeTruthy();
    await app.close();
  });

  it('deploy-bundle skips soft-deleted entries instead of failing the profile', async () => {
    const { app, auth, pat } = await setup();
    const mcpId = await seedMcp(app, auth);
    const skillId = await seedSkill(app, auth);
    const profileId = await seedProfile(app, auth, mcpId, skillId);

    await app.inject({ method: 'DELETE', url: `/api/mcp-servers/${mcpId}`, headers: auth });
    await app.inject({ method: 'DELETE', url: `/api/resources/${skillId}`, headers: auth });

    const bundle = await app.inject({
      method: 'GET',
      url: `/api/client/deploy-bundle?profile=${profileId}`,
      headers: { authorization: `Bearer ${pat}` },
    });
    expect(bundle.statusCode).toBe(200);
    expect(bundle.json().artifacts).toHaveLength(0);
    await app.close();
  });

  it('rejects re-adding a soft-deleted entry, accepts the stripped save', async () => {
    const { app, auth } = await setup();
    const mcpId = await seedMcp(app, auth);
    const skillId = await seedSkill(app, auth);
    const profileId = await seedProfile(app, auth, mcpId, skillId);
    await app.inject({ method: 'DELETE', url: `/api/mcp-servers/${mcpId}`, headers: auth });

    // sending the dangling reference back is rejected (it cannot be re-added)
    const reject = await app.inject({
      method: 'PATCH',
      url: `/api/profiles/${profileId}`,
      headers: auth,
      payload: { entries: [{ mcpServerId: mcpId }, { resourceId: skillId, kind: 'skill' }] },
    });
    expect(reject.statusCode).toBe(409);
    expect(reject.json().error).toBe('ENTRY_TARGET_NOT_ACCESSIBLE');

    // the stripped save (what the greyed editor sends) succeeds
    const strip = await app.inject({
      method: 'PATCH',
      url: `/api/profiles/${profileId}`,
      headers: auth,
      payload: { entries: [{ resourceId: skillId, kind: 'skill' }] },
    });
    expect(strip.statusCode).toBe(200);
    expect(strip.json().profile.entries).toHaveLength(1);
    await app.close();
  });

  it('second DELETE: 409 while referenced, hard once the last reference is gone', async () => {
    const { app, auth } = await setup();
    const mcpId = await seedMcp(app, auth);
    const skillId = await seedSkill(app, auth);
    const profileId = await seedProfile(app, auth, mcpId, skillId);

    await app.inject({ method: 'DELETE', url: `/api/mcp-servers/${mcpId}`, headers: auth });
    const blocked = await app.inject({
      method: 'DELETE',
      url: `/api/mcp-servers/${mcpId}`,
      headers: auth,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error).toBe('ASSET_STILL_REFERENCED');
    expect(blocked.json().message).toContain('P1');

    // strip both entries from the profile
    await app.inject({
      method: 'PATCH',
      url: `/api/profiles/${profileId}`,
      headers: auth,
      payload: { entries: [] },
    });

    const hard = await app.inject({
      method: 'DELETE',
      url: `/api/mcp-servers/${mcpId}`,
      headers: auth,
    });
    expect(hard.statusCode).toBe(200);
    expect(hard.json().mode).toBe('hard');
    const withDeleted = await app.inject({
      method: 'GET',
      url: '/api/mcp-servers?includeDeleted=1',
      headers: auth,
    });
    expect(withDeleted.json().mcpServers.map((s: { id: string }) => s.id)).not.toContain(mcpId);

    // resources follow the same stages
    const softSkill = await app.inject({
      method: 'DELETE',
      url: `/api/resources/${skillId}`,
      headers: auth,
    });
    expect(softSkill.json().mode).toBe('soft');
    const hardSkill = await app.inject({
      method: 'DELETE',
      url: `/api/resources/${skillId}`,
      headers: auth,
    });
    expect(hardSkill.statusCode).toBe(200);
    expect(hardSkill.json().mode).toBe('hard');
    await app.close();
  });
});
