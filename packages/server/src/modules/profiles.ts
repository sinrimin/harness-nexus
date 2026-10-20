// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { FastifyInstance } from 'fastify';
import {
  createProfileSchema,
  updateProfileSchema,
  type CreateProfileInput,
  type UpdateProfileInput,
} from '@harness-nexus/shared';
import { principalOf } from './principal.js';
import {
  createProfile,
  deleteProfile,
  getProfile,
  listProfiles,
  updateProfile,
} from '../services/profiles.js';

/**
 * Profile management routes — thin HTTP adapters over the domain service
 * (`services/profiles.ts`, #53 slice 5). Every authorization and entry
 * validation decision lives in the service; this file only authenticates,
 * parses the wire shape, and frames the reply.
 */
export async function profilesRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth] };

  // ---- POST /api/profiles ----
  app.post('/api/profiles', guard, async (req, reply) => {
    const input = createProfileSchema.parse(req.body) as CreateProfileInput;
    const profile = await createProfile({ uow: app.uow }, principalOf(req), input);
    return reply.code(201).send({ profile });
  });

  // ---- GET /api/profiles ----
  app.get('/api/profiles', guard, async (req) => {
    const profiles = await listProfiles({ uow: app.uow }, principalOf(req));
    return { profiles };
  });

  // ---- GET /api/profiles/:id ----
  app.get<{ Params: { id: string } }>('/api/profiles/:id', guard, async (req) => {
    const profile = await getProfile({ uow: app.uow }, principalOf(req), req.params.id);
    return { profile };
  });

  // ---- PATCH /api/profiles/:id ----
  app.patch<{ Params: { id: string } }>('/api/profiles/:id', guard, async (req) => {
    const input = updateProfileSchema.parse(req.body) as UpdateProfileInput;
    const profile = await updateProfile(
      { uow: app.uow },
      principalOf(req),
      req.params.id,
      input,
      req.body,
    );
    return { profile };
  });

  // ---- DELETE /api/profiles/:id ----
  app.delete<{ Params: { id: string } }>('/api/profiles/:id', guard, async (req) => {
    await deleteProfile({ uow: app.uow }, principalOf(req), req.params.id);
    return { ok: true };
  });
}
