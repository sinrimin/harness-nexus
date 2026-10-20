// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { PersonalAccessToken } from '@harness-nexus/core';
import { AppError, type CreatePatInput } from '@harness-nexus/shared';
import { generatePat, hashToken, patDisplayPrefix, generateId } from '../infra/crypto.js';
import type { Principal, ServiceDeps } from './principal.js';

/**
 * Personal access token domain service (#53 slice 11) — each user manages
 * their own. Generation/hashing (infra/crypto), the SERVER-assigned scope
 * rules, and revocation live here; the shown-once raw token crosses back to
 * the caller exactly once.
 */

/**
 * Per-call deps: the public origin the Agent tool reaches this server at —
 * a marketplace (emit) token's usable URL embeds it, so building that URL is
 * part of the token's lifecycle, not reply framing.
 */
export interface PatDeps extends ServiceDeps {
  publicBaseUrl: string;
}

/** What createPat hands back: the stored row, the raw token (shown once), and — for a marketplace (emit) token — its ready-to-consume catalog URL. */
export interface CreatePatResult {
  pat: PersonalAccessToken;
  token: string;
  marketplaceUrl?: string;
}

export async function createPat(
  deps: PatDeps,
  principal: Principal,
  input: CreatePatInput,
): Promise<CreatePatResult> {
  const rawToken = generatePat();
  const now = new Date().toISOString();
  // Scopes are SERVER-assigned (#21): an api token carries none, a
  // marketplace (emit) token exactly ['marketplace']. Client-supplied
  // scope lists are ignored — capability tags must never be self-issued
  // (today every acceptance path re-derives the user, but the tag should
  // not be forgeable in the first place).
  const scopes: string[] = input.kind === 'marketplace' ? ['marketplace'] : [];

  const pat = await deps.uow.tokens.save({
    id: generateId(),
    userId: principal.userId,
    name: input.name,
    tokenHash: hashToken(rawToken),
    prefix: patDisplayPrefix(rawToken),
    scopes,
    expiresAt: input.expiresAt ?? null,
    lastUsedAt: null,
    createdAt: now,
  });

  // The raw token is returned exactly once. For marketplace tokens the
  // emit URL rides along — the server is the only side that knows
  // PUBLIC_BASE_URL.
  const marketplaceUrl =
    input.kind === 'marketplace'
      ? `${deps.publicBaseUrl}/api/marketplace/${rawToken}/marketplace.json`
      : undefined;
  return { pat, token: rawToken, ...(marketplaceUrl ? { marketplaceUrl } : {}) };
}

export async function listPats(
  deps: ServiceDeps,
  principal: Principal,
): Promise<PersonalAccessToken[]> {
  return deps.uow.tokens.listByUser(principal.userId);
}

/** Revoke — owner-only (404 existence-hiding, #36). */
export async function deletePat(
  deps: ServiceDeps,
  principal: Principal,
  id: string,
): Promise<void> {
  const pat = await deps.uow.tokens.findById(id);
  if (!pat || pat.userId !== principal.userId) {
    throw new AppError('Token not found', 404, 'PAT_NOT_FOUND');
  }
  await deps.uow.tokens.delete(pat.id);
}
