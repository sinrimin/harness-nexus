// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { User, UserDefaultModels } from '@harness-nexus/core';
import {
  AppError,
  type CreateUserInput,
  type UpdateRoleInput,
  type UserDefaultModelsInput,
} from '@harness-nexus/shared';
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

/**
 * #95 — the user-level default model slots (provider page 默认模型 dialog).
 * Full-replace semantics, mirroring the other settings maps: PATCH sends the
 * whole object; an empty object clears every slot.
 */
export async function getUserDefaultModels(
  deps: ServiceDeps,
  principal: Principal,
): Promise<UserDefaultModels> {
  const user = await deps.uow.users.findById(principal.userId);
  if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');
  return user.defaultModels ?? {};
}

/** The api kind each slot must point at; `rerank` has no wire yet (reserved). */
const DEFAULT_SLOT_KIND = {
  embedding: 'openai-embedding',
  decision: 'systemone',
} as const;

export async function setUserDefaultModels(
  deps: ServiceDeps,
  principal: Principal,
  input: UserDefaultModelsInput,
): Promise<UserDefaultModels> {
  const user = await deps.uow.users.findById(principal.userId);
  if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');
  const next = input as UserDefaultModels;
  for (const slot of ['embedding', 'rerank', 'decision'] as const) {
    const ref = next[slot];
    if (ref === undefined) continue;
    if (slot === 'rerank') {
      throw new AppError('The rerank slot is reserved — no rerank wire exists yet', 400, 'DEFAULT_MODELS_RERANK_RESERVED');
    }
    const provider = await deps.uow.llmProviders.findById(ref.providerId);
    if (!provider || !(provider.scope === 'global' || provider.ownerId === principal.userId)) {
      throw new AppError('Provider not found', 404, 'DEFAULT_MODEL_PROVIDER_NOT_FOUND');
    }
    const kind = DEFAULT_SLOT_KIND[slot];
    if (!provider.models.some((m) => m.id === ref.modelId && m.apiKind === kind)) {
      throw new AppError(
        `Model "${ref.modelId}" is not a ${kind} model on that provider`,
        400,
        'DEFAULT_MODEL_KIND_MISMATCH',
      );
    }
  }
  await deps.uow.users.save({
    ...user,
    defaultModels: next,
    updatedAt: new Date().toISOString(),
  });
  return next;
}
