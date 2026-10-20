// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import type { Principal, ServiceDeps } from '../src/services/principal.js';
import {
  createResource,
  deleteResource,
  getResource,
  listResources,
  updateResource,
} from '../src/services/resources.js';
import { AppError } from '@harness-nexus/shared';

/**
 * #53 slice 1 — the resource domain service, tested DIRECTLY against the
 * memory driver (no HTTP, no Fastify). The route tests keep pinning the wire
 * end-to-end; these assert the #36 scope rules at the door both callers share.
 */

const owner: Principal = { userId: 'u-owner', role: 'user' };
const stranger: Principal = { userId: 'u-stranger', role: 'user' };
const admin: Principal = { userId: 'u-admin', role: 'admin' };

function deps(): ServiceDeps {
  return { uow: createMemoryUnitOfWork() };
}

const skillInput = (over: Record<string, unknown> = {}) =>
  ({
    key: 'skill:demo',
    kind: 'skill',
    name: 'Demo skill',
    version: 1,
    source: { type: 'inline', content: '# Demo\nSKILL.md body' },
    scope: 'personal',
    targets: ['claude-code'],
    ...over,
  }) as Parameters<typeof createResource>[2];

describe('svc resources — scope rules (#36, no HTTP)', () => {
  it('personal rows are owner-only: strangers and admins get the same 404', async () => {
    const d = deps();
    const created = await createResource(d, owner, skillInput());

    await expect(getResource(d, owner, created.id)).resolves.toBeTruthy();
    for (const p of [stranger, admin]) {
      await expect(getResource(d, p, created.id)).rejects.toMatchObject({
        statusCode: 404,
        code: 'RESOURCE_NOT_FOUND',
      });
    }
    // list() shows personal rows only to their owner.
    expect((await listResources(d, owner)).map((r) => r.id)).toContain(created.id);
    expect((await listResources(d, stranger)).map((r) => r.id)).not.toContain(created.id);
  });

  it('global create/update/delete is admin-only', async () => {
    const d = deps();
    await expect(createResource(d, owner, skillInput({ scope: 'global' }))).rejects.toMatchObject({
      statusCode: 403,
    });
    const global = await createResource(
      d,
      admin,
      skillInput({ scope: 'global', key: 'skill:shared' }),
    );
    // Reads via LIST are open to every authenticated principal; by-id reads
    // keep the original canManage gate (owner, or admin on a global row).
    expect((await listResources(d, stranger)).some((r) => r.id === global.id)).toBe(true);
    await expect(getResource(d, stranger, global.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(getResource(d, admin, global.id)).resolves.toBeTruthy();
    await expect(updateResource(d, stranger, global.id, { name: 'X' })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(updateResource(d, admin, global.id, { name: 'Renamed' })).resolves.toBeTruthy();
  });

  it('key uniqueness per (key, scope, owner); kind stays immutable', async () => {
    const d = deps();
    const created = await createResource(d, owner, skillInput());
    await expect(createResource(d, owner, skillInput())).rejects.toMatchObject({
      statusCode: 409,
      code: 'RESOURCE_KEY_TAKEN',
    });
    // The same key in ANOTHER owner's personal scope is fine.
    await expect(createResource(d, stranger, skillInput())).resolves.toBeTruthy();
    await expect(
      updateResource(d, owner, created.id, { kind: 'rule' } as never),
    ).rejects.toMatchObject({ statusCode: 409, code: 'RESOURCE_IMMUTABLE' });
  });

  it('two-stage delete: soft hides from lists, hard removes when unreferenced', async () => {
    const d = deps();
    const created = await createResource(d, owner, skillInput());
    expect((await deleteResource(d, owner, created.id)).mode).toBe('soft');
    expect((await listResources(d, owner)).some((r) => r.id === created.id)).toBe(false);
    expect(
      (await listResources(d, owner, { includeDeleted: true })).some((r) => r.id === created.id),
    ).toBe(true);
    expect((await deleteResource(d, owner, created.id)).mode).toBe('hard');
    await expect(getResource(d, owner, created.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('skill source variants gate at the service (bad bundle, bad source type)', async () => {
    const d = deps();
    await expect(
      createResource(d, owner, skillInput({ source: { type: 'inline-bundle', files: {} } })),
    ).rejects.toBeInstanceOf(AppError);
    await expect(
      createResource(d, owner, skillInput({ source: { type: 'git', repo: 'x' } as never })),
    ).rejects.toMatchObject({ code: 'INVALID_SKILL_SOURCE' });
  });
});
