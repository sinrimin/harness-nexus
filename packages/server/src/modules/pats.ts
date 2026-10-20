// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { FastifyInstance } from 'fastify';
import { createPatSchema, type CreatePatInput } from '@harness-nexus/shared';
import { principalOf } from './principal.js';
import { createPat, deletePat, listPats } from '../services/pats.js';

/**
 * PAT routes — thin HTTP adapters over the domain service
 * (`services/pats.ts`, #53 slice 11). Generation, hashing, server-assigned
 * scopes, and the emit-token URL live in the service; this file frames the
 * reply — the shown-once raw token and, for marketplace tokens, the
 * ready-to-paste `claude plugin marketplace add` line.
 */
export async function patsRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth] };
  const deps = () => ({ uow: app.uow, publicBaseUrl: app.publicBaseUrl });

  // ---- POST /api/pats ----
  app.post('/api/pats', guard, async (req, reply) => {
    const input = createPatSchema.parse(req.body) as CreatePatInput;
    const { pat, token, marketplaceUrl } = await createPat(deps(), principalOf(req), input);
    return reply.code(201).send({
      pat: stripSecret(pat),
      token,
      ...(marketplaceUrl
        ? {
            marketplaceUrl,
            addCommand: `claude plugin marketplace add ${marketplaceUrl}`,
          }
        : {}),
    });
  });

  // ---- GET /api/pats ----
  app.get('/api/pats', guard, async (req) => {
    const pats = await listPats({ uow: app.uow }, principalOf(req));
    return { pats: pats.map(stripSecret) };
  });

  // ---- DELETE /api/pats/:id ----
  app.delete<{ Params: { id: string } }>('/api/pats/:id', guard, async (req) => {
    await deletePat({ uow: app.uow }, principalOf(req), req.params.id);
    return { ok: true };
  });
}

type PatView = Omit<import('@harness-nexus/core').PersonalAccessToken, 'tokenHash'>;
function stripSecret(pat: import('@harness-nexus/core').PersonalAccessToken): PatView {
  const { tokenHash: _omit, ...rest } = pat;
  return rest;
}
