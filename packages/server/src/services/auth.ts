// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { User } from '@harness-nexus/core';
import { AppError, type LoginInput, type RegisterInput } from '@harness-nexus/shared';
import { hashPassword, verifyPassword, generateId } from '../infra/crypto.js';
import type { JwtService } from '../infra/jwt.js';
import type { Principal, ServiceDeps } from './principal.js';

/**
 * Auth domain service (#53 slice 10) — the ANONYMOUS door: register (toggleable,
 * first-user bootstrap admin) and login (verify + status checks), plus the
 * authenticated caller's own row. Extracted verbatim from the route handlers;
 * every decision (who may register via SystemSettings.allowRegistration,
 * bootstrap-admin, disabled rejection) lives here — no principal, these flows
 * precede one.
 *
 * Token minting moved in with the domain (deps carry the app-configured
 * JwtService — secret/issuer/TTL stay env-free here), so register/login return
 * the complete `{ user, token }` pair and both doors share one implementation.
 */

/**
 * Per-call deps: the app-configured JWT service (infra/jwt.ts wraps
 * JWT_SECRET + TTL) — threaded by the caller, services stay env-free.
 */
export interface AuthDeps extends ServiceDeps {
  jwt: JwtService;
}

/** What register/login hand back: the row + the freshly minted access token. */
export interface AuthResult {
  user: User;
  token: string;
}

/**
 * One argon2id hash computed at boot. Verifying an unknown username against
 * it keeps the login path's timing indistinguishable from a wrong password —
 * otherwise the early return enumerates accounts (#21).
 */
const dummyHashPromise = hashPassword('harness-nexus-timing-equalizer');

export async function registerUser(deps: AuthDeps, input: RegisterInput): Promise<AuthResult> {
  const settings = await deps.uow.settings.get();
  if (!settings.allowRegistration) {
    throw new AppError('Registration is disabled', 403, 'REGISTRATION_DISABLED');
  }

  if (await deps.uow.users.findByUsername(input.username)) {
    throw new AppError('Username already exists', 409, 'USERNAME_TAKEN');
  }

  const now = new Date().toISOString();
  const total = await deps.uow.users.count();
  // First user becomes the bootstrap admin.
  const role = total === 0 ? 'admin' : 'user';

  const user = await deps.uow.users.save({
    id: generateId(),
    username: input.username,
    ...(input.email ? { email: input.email } : {}),
    passwordHash: await hashPassword(input.password),
    role,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });

  const token = await deps.jwt.signAccessToken(user);
  return { user, token };
}

export async function loginUser(deps: AuthDeps, input: LoginInput): Promise<AuthResult> {
  const user = await deps.uow.users.findByUsername(input.username);
  if (!user || !user.passwordHash) {
    // Burn the same argon2 work a real verify would (#21).
    await verifyPassword(input.password, await dummyHashPromise);
    throw new AppError('Invalid credentials', 401, 'INVALID_CREDENTIALS');
  }
  if (!(await verifyPassword(input.password, user.passwordHash))) {
    throw new AppError('Invalid credentials', 401, 'INVALID_CREDENTIALS');
  }
  // Post-verification only: a disabled account's existence is revealed
  // solely to callers that already hold the password (#21).
  if (user.status !== 'active') {
    throw new AppError('Account is disabled', 403, 'ACCOUNT_DISABLED');
  }
  const token = await deps.jwt.signAccessToken(user);
  return { user, token };
}

/** The authenticated caller's own row (GET /api/auth/me). */
export async function getCurrentUser(deps: ServiceDeps, principal: Principal): Promise<User> {
  const user = await deps.uow.users.findById(principal.userId);
  if (!user) throw new AppError('User not found', 404, 'USER_NOT_FOUND');
  return user;
}
