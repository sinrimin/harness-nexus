// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import type { McpServer, Resource } from '@harness-nexus/core';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import type { Principal, ServiceDeps } from '../src/services/principal.js';
import {
  createProfile,
  deleteProfile,
  getProfile,
  listProfiles,
  updateProfile,
} from '../src/services/profiles.js';

/**
 * #53 slice 5 — the profile domain service, tested DIRECTLY against the
 * memory driver (no HTTP, no Fastify). The route tests keep pinning the wire
 * end-to-end (auto-versioning in profile-version.test.ts); these assert the
 * #36 scope rules and entry-resolution gates at the door both callers share.
 */

const owner: Principal = { userId: 'u-owner', role: 'user' };
const stranger: Principal = { userId: 'u-stranger', role: 'user' };
const admin: Principal = { userId: 'u-admin', role: 'admin' };

function deps(): ServiceDeps {
  return { uow: createMemoryUnitOfWork() };
}

const now = '2026-10-14T00:00:00.000Z';

/** Seed a live MCP server row (the mcpServerId entry arm resolves these). */
async function seedServer(d: ServiceDeps, over: Partial<McpServer> = {}): Promise<McpServer> {
  const server: McpServer = {
    id: 'srv-' + Math.random().toString(36).slice(2, 8),
    name: 'upstream',
    transport: { type: 'streamable-http', url: 'https://x.example.com/mcp' },
    dialSite: 'client',
    scope: 'personal',
    ownerId: owner.userId,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  await d.uow.mcpServers.save(server);
  return server;
}

async function seedRule(d: ServiceDeps, over: Partial<Resource> = {}): Promise<Resource> {
  const resource: Resource = {
    id: 'res-' + Math.random().toString(36).slice(2, 8),
    key: 'rule:demo',
    kind: 'rule',
    name: 'Demo rule',
    version: '1',
    source: { type: 'inline', content: 'Be nice' },
    scope: 'personal',
    ownerId: owner.userId,
    targets: ['claude-code'],
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  await d.uow.resources.save(resource);
  return resource;
}

const profileInput = (serverId: string, over: Record<string, unknown> = {}) =>
  ({
    name: 'P',
    target: 'claude-code',
    scope: 'personal',
    entries: [{ mcpServerId: serverId }],
    ...over,
  }) as Parameters<typeof createProfile>[2];

describe('svc profiles — scope rules (#36, no HTTP)', () => {
  it('personal rows are owner-only: strangers and admins get the same 404', async () => {
    const d = deps();
    const server = await seedServer(d);
    const created = await createProfile(d, owner, profileInput(server.id));

    await expect(getProfile(d, owner, created.id)).resolves.toBeTruthy();
    for (const p of [stranger, admin]) {
      await expect(getProfile(d, p, created.id)).rejects.toMatchObject({
        statusCode: 404,
        code: 'PROFILE_NOT_FOUND',
      });
      await expect(updateProfile(d, p, created.id, { name: 'hijack' })).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(deleteProfile(d, p, created.id)).rejects.toMatchObject({
        statusCode: 404,
      });
    }
    expect((await listProfiles(d, owner)).map((x) => x.id)).toContain(created.id);
    expect((await listProfiles(d, stranger)).map((x) => x.id)).not.toContain(created.id);
    expect((await listProfiles(d, admin)).map((x) => x.id)).not.toContain(created.id);
  });

  it('global create is admin-only; global rows are readable by everyone', async () => {
    const d = deps();
    const server = await seedServer(d, { scope: 'global', ownerId: null });
    await expect(
      createProfile(d, owner, profileInput(server.id, { scope: 'global' })),
    ).rejects.toMatchObject({ statusCode: 403 });
    const global = await createProfile(d, admin, profileInput(server.id, { scope: 'global' }));
    expect(global.ownerId).toBeNull();
    // visibleTo: any authenticated principal READS a global row; managing it
    // stays admin-only (a stranger's PATCH 404-hides).
    await expect(getProfile(d, stranger, global.id)).resolves.toBeTruthy();
    await expect(updateProfile(d, stranger, global.id, { name: 'x' })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(updateProfile(d, admin, global.id, { name: 'renamed' })).resolves.toBeTruthy();
  });
});

describe('svc profiles — entry resolution gates', () => {
  it('rejects another user’s personal MCP server and soft-deleted rows', async () => {
    const d = deps();
    const foreign = await seedServer(d, { ownerId: stranger.userId });
    const softDeleted = await seedServer(d, { deletedAt: now });

    for (const serverId of [foreign.id, softDeleted.id]) {
      await expect(createProfile(d, owner, profileInput(serverId))).rejects.toMatchObject({
        statusCode: 409,
        code: 'ENTRY_TARGET_NOT_ACCESSIBLE',
      });
    }
  });

  it('resource arm: kind must match and the row must be visible; mcp kind is refused', async () => {
    const d = deps();
    const rule = await seedRule(d);
    const ok = await createProfile(d, owner, {
      name: 'P',
      target: 'claude-code',
      scope: 'personal',
      entries: [{ resourceId: rule.id, kind: 'rule' }],
    });
    expect(ok.entries).toEqual([{ resourceId: rule.id, kind: 'rule' }]);

    // kind mismatch → 409
    await expect(
      updateProfile(d, owner, ok.id, {
        entries: [{ resourceId: rule.id, kind: 'skill' }],
      }),
    ).rejects.toMatchObject({ code: 'ENTRY_TARGET_NOT_ACCESSIBLE' });
  });
});

describe('svc profiles — immutability + auto-version (#18)', () => {
  it('target is immutable via the raw body; versions bump only on entry changes', async () => {
    const d = deps();
    const a = await seedServer(d);
    const b = await seedServer(d);
    const created = await createProfile(d, owner, profileInput(a.id));
    expect(created.version).toBe('0.1');

    await expect(
      updateProfile(d, owner, created.id, { name: 'P2' }, { target: 'zcode' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'TARGET_IMMUTABLE' });

    const renamed = await updateProfile(d, owner, created.id, { name: 'P2' }, { name: 'P2' });
    expect(renamed.version).toBe('0.1');

    const bumped = await updateProfile(d, owner, created.id, {
      entries: [{ mcpServerId: b.id }],
    });
    expect(bumped.version).toBe('0.2');
  });
});
