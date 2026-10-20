// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { AppError, type MarketplacePlugin } from '@harness-nexus/shared';
import { resolveAllowlistId, type MarketplaceEntry } from '../infra/source-fetchers/allowlist.js';
import type { SkillCatalogService } from '../infra/source-fetchers/catalog-service.js';
import type {
  SkillSearchRouter,
  SkillSearchResult,
} from '../infra/source-fetchers/search-router.js';
import type { Principal } from './principal.js';

/**
 * Skill hub domain service (#53 slice 2) — browse/search the marketplace
 * catalogs. Extracted verbatim from the route handlers; the only change is the
 * door: callers pass an explicit principal and per-call infra deps.
 *
 * Authority: any authenticated principal may browse — marketplaces are public
 * catalogs, but the outbound-fetch surface itself is gated to signed-in users
 * (egress hygiene), so every operation takes a principal; anonymous calls are
 * unrepresentable. Saving a skill resource still goes through the resources
 * service's scope rules.
 *
 * The outbound fetchers (infra/source-fetchers) are legitimate infra use from
 * a service: the allowlist bounds the egress surface and the catalog service
 * owns the TTL cache + in-flight dedup. No UnitOfWork is involved — this
 * domain reads no tables — so its deps do not extend `ServiceDeps`.
 */

/** Per-call dependencies for the skill hub (the app-decorated fetcher set). */
export interface SkillsDeps {
  search: SkillSearchRouter;
  catalog: SkillCatalogService;
  allowlist: MarketplaceEntry[];
}

/** Raw query-string shape of the search endpoint (validation is verbatim). */
export interface SkillSearchQuery {
  q?: string;
  limit?: string;
}

export async function searchSkills(
  deps: SkillsDeps,
  _principal: Principal,
  query: SkillSearchQuery,
): Promise<SkillSearchResult> {
  const q = query.q?.trim();
  if (!q) {
    throw new AppError('A search query (?q=) is required', 400, 'VALIDATION_ERROR');
  }
  // Clamp 1..200 — the value fans out to every source (#21).
  const raw = query.limit ? Number(query.limit) : 50;
  const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 200) : 50;
  return deps.search.search(q, limit);
}

/** The configured allowlist entries (no fetch — cheap). */
export function listSkillMarketplaces(deps: SkillsDeps, _principal: Principal): MarketplaceEntry[] {
  return deps.allowlist;
}

/**
 * A marketplace's plugins (fetched with cache). Optional `category` and `q`
 * filters narrow the list. Non-allowlisted id → 404 (not 403, to avoid leaking
 * which ids are configured). Fetch failure → 502 (thrown by the catalog).
 */
export async function listMarketplacePlugins(
  deps: SkillsDeps,
  _principal: Principal,
  id: string,
  filter: { category?: string; q?: string } = {},
): Promise<MarketplacePlugin[]> {
  const url = resolveAllowlistId(deps.allowlist, id);
  if (!url) {
    throw new AppError(
      `Marketplace "${id}" is not in the allowlist`,
      404,
      'MARKETPLACE_NOT_ALLOWED',
    );
  }
  return deps.catalog.listPlugins(id, url, {
    ...(filter.category ? { category: filter.category } : {}),
    ...(filter.q ? { q: filter.q } : {}),
  });
}
