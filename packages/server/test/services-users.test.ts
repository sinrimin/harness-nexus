// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import { verifyPassword } from '../src/infra/crypto.js';
import type { Principal, ServiceDeps } from '../src/services/principal.js';
import { createUser, deleteUser, listUsers, updateUserRole } from '../src/services/users.js';
import type { User } from '@harness-nexus/core';

/**
 * #53 slice 9 — the user administration service, tested DIRECTLY against the
 * memory driver (no HTTP). Route tests pin the wire; these assert the admin
 * gate and the safety rails (last-admin, no-self-delete) at the shared door.
 */

const admin: Principal = { userId: 'u-admin', role: 'admin' };
const pleb: Principal = { userId: 'u-pleb', role: 'user' };

function deps(): ServiceDeps {
  return { uow: createMemoryUnitOfWork() };
}

async function seedUser(d: ServiceDeps, over: Partial<User> & { id: string }): Promise<User> {
  const now = new Date().toISOString();
  const user: User = {
    username: over.id,
    passwordHash: 'x',
    role: 'user',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  return d.uow.users.save(user);
}

const createInput = (over: Record<string, unknown> = {}) => ({
  username: 'newbie',
  password: 'hunter2hunter2',
  role: 'user',
  ...over,
});

describe('svc users — admin gate lives in the service', () => {
  it('non-admin principals get 403 on every operation', async () => {
    const d = deps();
    const target = await seedUser(d, { id: 'u-target', username: 'target' });
    await expect(createUser(d, pleb, createInput())).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    });
    await expect(listUsers(d, pleb)).rejects.toMatchObject({ statusCode: 403 });
    await expect(deleteUser(d, pleb, target.id)).rejects.toMatchObject({ statusCode: 403 });
    await expect(updateUserRole(d, pleb, target.id, { role: 'admin' })).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('create hashes the password and enforces username uniqueness', async () => {
    const d = deps();
    await seedUser(d, { id: 'u-taken', username: 'taken' });
    const created = await createUser(d, admin, createInput());
    expect(created.role).toBe('user');
    expect(created.status).toBe('active');
    expect(created.passwordHash).not.toBe('hunter2hunter2');
    await expect(verifyPassword('hunter2hunter2', created.passwordHash)).resolves.toBe(true);

    await expect(createUser(d, admin, createInput({ username: 'taken' }))).rejects.toMatchObject({
      statusCode: 409,
      code: 'USERNAME_TAKEN',
    });
    expect((await listUsers(d, admin)).map((u) => u.username)).toContain('newbie');
  });
});

describe('svc users — safety rails', () => {
  it('no self-delete (409 NO_SELF_DELETE)', async () => {
    const d = deps();
    await seedUser(d, { id: 'u-admin', username: 'admin', role: 'admin' });
    await expect(deleteUser(d, admin, 'u-admin')).rejects.toMatchObject({
      statusCode: 409,
      code: 'NO_SELF_DELETE',
    });
  });

  it('the last admin cannot be demoted (409 LAST_ADMIN); self-delete 409s first', async () => {
    const d = deps();
    await seedUser(d, { id: 'u-admin', username: 'admin', role: 'admin' });
    // Sole admin demoting themselves is THE reachable last-admin case.
    await expect(updateUserRole(d, admin, 'u-admin', { role: 'user' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'LAST_ADMIN',
    });
    // Deleting themselves hits the self-delete rail (checked before count).
    await expect(deleteUser(d, admin, 'u-admin')).rejects.toMatchObject({
      statusCode: 409,
      code: 'NO_SELF_DELETE',
    });
    expect(await d.uow.users.findById('u-admin')).not.toBeNull(); // nothing happened
  });

  it('with two admins, delete and demote go through', async () => {
    const d = deps();
    await seedUser(d, { id: 'u-admin', username: 'admin', role: 'admin' });
    await seedUser(d, { id: 'u-admin2', username: 'admin2', role: 'admin' });
    const plebRow = await seedUser(d, { id: 'u-pleb', username: 'pleb' });

    await deleteUser(d, admin, 'u-admin2');
    expect(await d.uow.users.findById('u-admin2')).toBeNull();

    // Re-add a second admin, then demote one.
    await seedUser(d, { id: 'u-admin2', username: 'admin2', role: 'admin' });
    await expect(updateUserRole(d, admin, 'u-admin2', { role: 'user' })).resolves.toMatchObject({
      role: 'user',
    });
    await expect(updateUserRole(d, admin, plebRow.id, { role: 'admin' })).resolves.toMatchObject({
      role: 'admin',
    });
  });
});
