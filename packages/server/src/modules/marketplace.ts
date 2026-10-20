// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { FastifyInstance } from 'fastify';
import {
  getMarketplaceArchiveProfile,
  resolveMarketplaceTokenUser,
} from '../services/marketplace.js';

/**
 * Marketplace emitter routes (Phase 3.5) — the surface Claude Code consumes:
 *
 *   GET /api/marketplace/:token/marketplace.json
 *   GET /api/marketplace/:token/archives/:profileId.zip
 *
 * Thin HTTP adapters over `services/marketplace.ts` (#53 slice 13): the token
 * lifecycle and archive-visibility decisions live in the service; this file
 * assigns the resolved identity onto `req.user` (transport), invokes the
 * `MarketplaceEmitter` component for the catalog/zip BUILDING, and frames the
 * replies. Auth is PAT-in-path, NOT the Authorization header: claude plugin
 * flows send no headers we can rely on (spike §4), so these routes sit
 * outside `requireAuth` and the service resolves the token itself.
 */
export async function marketplaceRoutes(app: FastifyInstance): Promise<void> {
  const deps = () => ({ uow: app.uow });

  // ---- GET /api/marketplace/:token/marketplace.json ----
  app.get<{ Params: { token: string } }>(
    '/api/marketplace/:token/marketplace.json',
    async (req, reply) => {
      const user = await resolveMarketplaceTokenUser(deps(), req.params.token);
      req.user = { id: user.id, role: user.role };
      const catalog = await app.marketplaceEmitter.buildCatalog(
        user.id,
        user.username,
        req.params.token,
      );
      return reply.send(catalog);
    },
  );

  // ---- GET /api/marketplace/:token/archives/:file (<profileId>.zip) ----
  app.get<{ Params: { token: string; file: string } }>(
    '/api/marketplace/:token/archives/:file',
    async (req, reply) => {
      const user = await resolveMarketplaceTokenUser(deps(), req.params.token);
      req.user = { id: user.id, role: user.role };
      const { profileId, profile } = await getMarketplaceArchiveProfile(
        deps(),
        user.id,
        req.params.file,
      );
      const zip = await app.marketplaceEmitter.buildPluginZip(profile);
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', `attachment; filename="${profileId}.zip"`)
        .send(zip);
    },
  );
}
