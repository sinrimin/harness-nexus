import type { SystemSettings } from '@harness-nexus/core';
import { AppError, type UpdateRegistrationInput } from '@harness-nexus/shared';
import type { Principal, ServiceDeps } from './principal.js';

/**
 * System settings domain service (#53 slice 4) — the single-row settings
 * aggregate (Phase 1: the registration toggle). Deliberately boring.
 *
 * The read is anonymous (the register page needs the switch before login —
 * no principal); the write carries authority: admin-only, enforced here so
 * in-process callers cannot bypass the route's requireAdmin guard.
 */

/** The current settings row. */
export async function getSystemSettings(deps: ServiceDeps): Promise<SystemSettings> {
  return deps.uow.settings.get();
}

/** Flip the registration switch. Admin-only (#36: role checks live in services). */
export async function updateRegistrationSettings(
  deps: ServiceDeps,
  principal: Principal,
  input: UpdateRegistrationInput,
): Promise<SystemSettings> {
  if (principal.role !== 'admin') {
    throw new AppError('Admin role required', 403, 'FORBIDDEN');
  }
  return deps.uow.settings.save({
    allowRegistration: input.allowRegistration,
    updatedAt: new Date().toISOString(),
  });
}
