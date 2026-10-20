// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { FastifyInstance } from 'fastify';
import { principalOf } from './principal.js';
import {
  listMarketplacePlugins,
  listSkillMarketplaces,
  searchSkills,
  type SkillsDeps,
} from '../services/skills.js';

/**
 * Skill hub routes (Phase 7.2/7.4) — thin HTTP adapters over the domain
 * service (`services/skills.ts`, #53 slice 2). Every decision (query required,
 * limit clamp, allowlist 404) lives in the service; this file only
 * authenticates, reads the query, and frames the reply.
 *
 * This is the server's only outbound-fetch surface. All fetches go through the
 * allowlist (parsed at boot from `MARKETPLACE_ALLOWLIST`) and the
 * `SkillCatalogService` cache. Scope: any authenticated user can browse —
 * marketplaces are public catalogs; saving a skill resource (7.3) still goes
 * through the normal `/api/resources` scope rules.
 */

export async function skillsRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth] };
  const deps = (): SkillsDeps => ({
    search: app.skillSearch,
    catalog: app.skillCatalog,
    allowlist: app.marketplaceAllowlist,
  });

  // ---- GET /api/skills/search ----
  // Multi-source search across all configured SkillSources (Phase 7.4). The
  // query is required (browse-without-query is the /marketplaces/:id/plugins
  // path). Returns merged/deduped results + the source ids that timed out or
  // errored (partial-results-first — the UI shows a notice).
  app.get<{ Querystring: { q?: string; limit?: string } }>(
    '/api/skills/search',
    guard,
    async (req) => {
      return searchSkills(deps(), principalOf(req), req.query);
    },
  );

  // ---- GET /api/skills/marketplaces ----
  // List the configured allowlist (no fetch — cheap).
  app.get('/api/skills/marketplaces', guard, async (req) => {
    const marketplaces = listSkillMarketplaces(deps(), principalOf(req));
    return { marketplaces: marketplaces.map((e) => ({ id: e.id })) };
  });

  // ---- GET /api/skills/marketplaces/:id/plugins ----
  // Fetch (with cache) and return a marketplace's plugins.
  app.get<{ Params: { id: string } }>(
    '/api/skills/marketplaces/:id/plugins',
    guard,
    async (req) => {
      const q = req.query as { category?: string; q?: string };
      const plugins = await listMarketplacePlugins(deps(), principalOf(req), req.params.id, {
        ...(q.category ? { category: q.category } : {}),
        ...(q.q ? { q: q.q } : {}),
      });
      return { plugins };
    },
  );
}
