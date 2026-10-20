// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { SystemSettings } from '@harness-nexus/core';
import { IMAGE_RETENTION_MAX, IMAGE_RETENTION_MIN } from '@harness-nexus/core';
import {
  AppError,
  type UpdateImageRetentionInput,
  type UpdateRegistrationInput,
} from '@harness-nexus/shared';
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
  const current = await deps.uow.settings.get();
  return deps.uow.settings.save({
    ...current,
    allowRegistration: input.allowRegistration,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * #59 — set the image retention window (days). The value only ever affects
 * FUTURE ingests: each blob carries the expiresAt stamped at its own write
 * time, and nothing rewrites it. Admin-only, like every settings write.
 */
export async function updateImageRetentionSettings(
  deps: ServiceDeps,
  principal: Principal,
  input: UpdateImageRetentionInput,
): Promise<SystemSettings> {
  if (principal.role !== 'admin') {
    throw new AppError('Admin role required', 403, 'FORBIDDEN');
  }
  if (
    !Number.isInteger(input.imageRetentionDays) ||
    input.imageRetentionDays < IMAGE_RETENTION_MIN ||
    input.imageRetentionDays > IMAGE_RETENTION_MAX
  ) {
    throw new AppError(
      `imageRetentionDays must be an integer between ${IMAGE_RETENTION_MIN} and ${IMAGE_RETENTION_MAX}`,
      400,
      'VALIDATION',
    );
  }
  const current = await deps.uow.settings.get();
  return deps.uow.settings.save({
    ...current,
    imageRetentionDays: input.imageRetentionDays,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * #59 — the expiry stamp for a blob ingested `now`, under the CURRENT
 * retention setting. The single place the setting turns into a deadline;
 * everything downstream reads the stamp, never the setting.
 */
export function imageExpiryFrom(settings: SystemSettings, now: Date): string {
  return new Date(now.getTime() + settings.imageRetentionDays * 86_400_000).toISOString();
}
