// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { User } from '@harness-nexus/core';
import { AppError, type CreateUserInput, type UpdateRoleInput } from '@harness-nexus/shared';
import { hashPassword, generateId } from '../infra/crypto.js';
import type { Principal, ServiceDeps } from './principal.js';

/**
 * User administration domain service (#53 slice 9) — the admin door over
 * accounts (contrast `services/auth.ts`, the anonymous register/login door).
 * Admin CRUD; bypasses the registration switch. Extracted verbatim from the
 * route handlers; the safety rails moved with it:
 *   - last-admin protection (delete + demote, 409 LAST_ADMIN),
 *   - no self-delete (409 NO_SELF_DELETE).
 *
 * Admin-only is enforced HERE (settings precedent): the routes keep
 * `requireAdmin` as the 401/403 transport mapping, and in-process callers
 * share this one door.
 */

function requireAdminRole(principal: Principal): void {
  if (principal.role !== 'admin') {
    throw new AppError('Admin role required', 403, 'FORBIDDEN');
  }
}

export async function createUser(
  deps: ServiceDeps,
  principal: Principal,
  input: CreateUserInput,
): Promise<User> {
  requireAdminRole(principal);
  if (await deps.uow.users.findByUsername(input.username)) {
    throw new AppError('Username already exists', 409, 'USERNAME_TAKEN');
  }

  const now = new Date().toISOString();
  return deps.uow.users.save({
    id: generateId(),
    username: input.username,
    ...(input.email ? { email: input.email } : {}),
    passwordHash: await hashPassword(input.password),
    role: input.role,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
}

export async function listUsers(deps: ServiceDeps, principal: Principal): Promise<User[]> {
  requireAdminRole(principal);
  return deps.uow.users.list();
}

export async function deleteUser(
  deps: ServiceDeps,
  principal: Principal,
  id: string,
): Promise<void> {
  requireAdminRole(principal);
  const target = await deps.uow.users.findById(id);
  if (!target) throw new AppError('User not found', 404, 'USER_NOT_FOUND');

  if (target.id === principal.userId) {
    throw new AppError('You cannot delete your own account', 409, 'NO_SELF_DELETE');
  }
  if (target.role === 'admin') {
    const adminCount = await deps.uow.users.countByRole('admin');
    if (adminCount <= 1) {
      throw new AppError('Cannot delete the last admin', 409, 'LAST_ADMIN');
    }
  }
  await deps.uow.users.delete(target.id);
}

export async function updateUserRole(
  deps: ServiceDeps,
  principal: Principal,
  id: string,
  input: UpdateRoleInput,
): Promise<User> {
  requireAdminRole(principal);
  const target = await deps.uow.users.findById(id);
  if (!target) throw new AppError('User not found', 404, 'USER_NOT_FOUND');

  // Demoting the last admin is blocked.
  if (target.role === 'admin' && input.role !== 'admin') {
    const adminCount = await deps.uow.users.countByRole('admin');
    if (adminCount <= 1) {
      throw new AppError('Cannot demote the last admin', 409, 'LAST_ADMIN');
    }
  }

  return deps.uow.users.save({
    ...target,
    role: input.role,
    updatedAt: new Date().toISOString(),
  });
}
