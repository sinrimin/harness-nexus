// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { Profile } from '@harness-nexus/core';
import { AppError } from '@harness-nexus/shared';
import { hashToken, PAT_PREFIX } from '../infra/crypto.js';
import type { ServiceDeps } from './principal.js';

/**
 * Marketplace emitter domain service (#53 slice 13, Phase 3.5) — the
 * decisions behind the PAT-in-path surface Claude Code consumes. Auth is the
 * emit token embedded in the URL (claude plugin flows send no headers we can
 * rely on), so these operations resolve the token THEMSELVES rather than
 * taking a principal; unknown or revoked tokens answer 404 —
 * indistinguishable from a nonexistent path, the same no-existence-leak
 * posture as the rest of the API.
 *
 * The catalog/zip BUILDING stays in `marketplace/emitter.ts` (the
 * `MarketplaceEmitter` component, transport-free already — the mcp/registry
 * precedent) and is invoked by the routes; this service owns the token
 * lifecycle and archive-profile visibility decisions.
 */

/**
 * Resolve the emit token embedded in the URL path into the requesting user.
 * Mirrors the auth plugin's PAT path (sha256 lookup + expiry + active check +
 * touchLastUsed) with two accepted scopes:
 *  - `marketplace` — created via `POST /api/pats {kind:'marketplace'}`, the
 *    manual emit flow's URL-capability token;
 *  - `machine-ctl` (#6) — a daemon's machine PAT, so the daemon can drive
 *    `claude plugin marketplace add|install` with the token it already holds
 *    (no secret rides the job payload). The REST auth hook still rejects
 *    machine tokens, and reading the owner's marketplace is strictly weaker
 *    than the /ctl control the token already grants.
 * General API PATs remain rejected — they are not URL-capability tokens and
 * must not leak through URLs into logs. Unknown or revoked tokens answer 404.
 * Returns the full user identity — the emitter needs `username` for the name.
 */
export async function resolveMarketplaceTokenUser(
  deps: ServiceDeps,
  rawToken: string,
): Promise<{ id: string; username: string; role: 'admin' | 'user' }> {
  if (!rawToken.startsWith(PAT_PREFIX)) {
    throw new AppError('Marketplace not found', 404, 'MARKETPLACE_NOT_FOUND');
  }
  const record = await deps.uow.tokens.findByTokenHash(hashToken(rawToken));
  if (
    record &&
    (record.scopes.includes('marketplace') || record.scopes.includes('machine-ctl')) &&
    (!record.expiresAt || Date.parse(record.expiresAt) > Date.now())
  ) {
    const user = await deps.uow.users.findById(record.userId);
    if (user && user.status === 'active') {
      void deps.uow.tokens.touchLastUsed(record.id, new Date().toISOString());
      return { id: user.id, username: user.username, role: user.role };
    }
  }
  throw new AppError('Marketplace not found', 404, 'MARKETPLACE_NOT_FOUND');
}

/** The archive route's `<profileId>.zip` param, resolved + visibility-gated. */
export async function getMarketplaceArchiveProfile(
  deps: ServiceDeps,
  userId: string,
  file: string,
): Promise<{ profileId: string; profile: Profile }> {
  const profileId = file.replace(/\.zip$/, '');
  const profile = await deps.uow.profiles.findById(profileId);
  if (!profile || profile.target !== 'claude-code' || !visibleTo(profile, userId)) {
    throw new AppError('Profile not found', 404, 'PROFILE_NOT_FOUND');
  }
  return { profileId, profile };
}

/** A profile is visible iff global or personal + owned (#36). */
function visibleTo(p: Profile, userId: string): boolean {
  return p.scope === 'global' || p.ownerId === userId;
}
