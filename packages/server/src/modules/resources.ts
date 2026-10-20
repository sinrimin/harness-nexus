// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { FastifyInstance } from 'fastify';
import type { Resource, ResourceKind } from '@harness-nexus/core';
import {
  createResourceSchema,
  updateResourceSchema,
  type CreateResourceInput,
  type UpdateResourceInput,
} from '@harness-nexus/shared';
import { resourceView } from './serialize.js';
import { principalOf } from './principal.js';
import {
  createResource,
  deleteResource,
  getResource,
  listResources,
  updateResource,
} from '../services/resources.js';

/**
 * Resource management routes — thin HTTP adapters over the domain service
 * (`services/resources.ts`, #53 slice 1). Every authorization decision lives
 * in the service; this file only authenticates, parses the wire shape, and
 * frames the reply.
 */
export async function resourcesRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth] };

  // ---- POST /api/resources ----
  app.post('/api/resources', guard, async (req, reply) => {
    const input = createResourceSchema.parse(req.body) as CreateResourceInput;
    const resource = await createResource({ uow: app.uow }, principalOf(req), input);
    return reply.code(201).send({ resource: resourceView(resource) });
  });

  // ---- GET /api/resources ----
  // Returns the caller's personal resources + all global resources. Query params
  // (kind/scope/target) narrow the set; scope=global|personal filters the halves.
  app.get('/api/resources', guard, async (req) => {
    const q = req.query as {
      kind?: ResourceKind;
      scope?: 'global' | 'personal';
      target?: Resource['targets'][number];
      includeDeleted?: string;
    };
    const resource = await listResources({ uow: app.uow }, principalOf(req), {
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.scope ? { scope: q.scope } : {}),
      ...(q.target ? { target: q.target } : {}),
      includeDeleted: q.includeDeleted === '1',
    });
    return { resources: resource.map(resourceView) };
  });

  // ---- GET /api/resources/:id ----
  app.get<{ Params: { id: string } }>('/api/resources/:id', guard, async (req) => {
    const resource = await getResource({ uow: app.uow }, principalOf(req), req.params.id);
    return { resource: resourceView(resource) };
  });

  // ---- PATCH /api/resources/:id ----
  app.patch<{ Params: { id: string } }>('/api/resources/:id', guard, async (req) => {
    const input = updateResourceSchema.parse(req.body) as UpdateResourceInput;
    const resource = await updateResource({ uow: app.uow }, principalOf(req), req.params.id, input);
    return { resource: resourceView(resource) };
  });

  // ---- DELETE /api/resources/:id — two-stage (soft, then hard) ----
  app.delete<{ Params: { id: string } }>('/api/resources/:id', guard, async (req) => {
    const { mode } = await deleteResource({ uow: app.uow }, principalOf(req), req.params.id);
    return { ok: true, mode };
  });
}
