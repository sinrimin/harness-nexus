// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { FastifyInstance } from 'fastify';
import {
  createUserSchema,
  modelCapabilitySlotSchema,
  updateRoleSchema,
  userDefaultModelsSchema,
  type CreateUserInput,
  type UpdateRoleInput,
  type UserDefaultModelsInput,
} from '@harness-nexus/shared';
import { publicUser } from './serialize.js';
import { principalOf } from './principal.js';
import {
  createUser,
  deleteUser,
  getUserDefaultModels,
  listUsers,
  setUserDefaultModels,
  updateUserRole,
} from '../services/users.js';
import { listModelCapabilities } from '../services/model-capabilities.js';

/**
 * User administration routes — thin HTTP adapters over the domain service
 * (`services/users.ts`, #53 slice 9). The admin gate, last-admin protection,
 * and no-self-delete rails all live in the service; this file authenticates
 * (`requireAdmin` is the 401/403 transport mapping), parses, and frames the
 * public user view.
 */
export async function usersRoutes(app: FastifyInstance): Promise<void> {
  const adminGuard = { preHandler: [app.requireAdmin] };
  const deps = () => ({ uow: app.uow });

  // ---- POST /api/users ----
  app.post('/api/users', adminGuard, async (req, reply) => {
    const input = createUserSchema.parse(req.body) as CreateUserInput;
    const user = await createUser(deps(), principalOf(req), input);
    return reply.code(201).send({ user: publicUser(user) });
  });

  // ---- GET /api/users ----
  app.get('/api/users', adminGuard, async (req) => {
    const users = await listUsers(deps(), principalOf(req));
    return { users: users.map(publicUser) };
  });

  // ---- DELETE /api/users/:id ----
  app.delete<{ Params: { id: string } }>('/api/users/:id', adminGuard, async (req) => {
    await deleteUser(deps(), principalOf(req), req.params.id);
    return { ok: true };
  });

  // ---- GET /api/users/me/default-models ---- (#95 — self-scoped, any user;
  // #100 — the response also carries the derived per-slot capability view)
  app.get('/api/users/me/default-models', async (req) => {
    const principal = principalOf(req);
    const [defaultModels, capabilities] = await Promise.all([
      getUserDefaultModels(deps(), principal),
      listModelCapabilities(deps(), principal.userId, app.modelCapabilities),
    ]);
    return { defaultModels, capabilities };
  });

  // ---- POST /api/users/me/default-models/:slot/retry ---- (#100 — manual
  // breaker clear: resets the counter + cooldown; the next real use probes)
  app.post<{ Params: { slot: string } }>(
    '/api/users/me/default-models/:slot/retry',
    async (req, reply) => {
      const parsed = modelCapabilitySlotSchema.safeParse(req.params.slot);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'unknown slot' });
      }
      const principal = principalOf(req);
      app.modelCapabilities.reset(principal.userId);
      return {
        capabilities: await listModelCapabilities(deps(), principal.userId, app.modelCapabilities),
      };
    },
  );

  // ---- PATCH /api/users/me/default-models ---- (full replace; {} clears)
  app.patch('/api/users/me/default-models', async (req) => {
    const input = userDefaultModelsSchema.parse(req.body) as UserDefaultModelsInput;
    const defaultModels = await setUserDefaultModels(deps(), principalOf(req), input);
    return { defaultModels };
  });

  // ---- PATCH /api/users/:id/role ----
  app.patch<{ Params: { id: string } }>('/api/users/:id/role', adminGuard, async (req) => {
    const input = updateRoleSchema.parse(req.body) as UpdateRoleInput;
    const user = await updateUserRole(deps(), principalOf(req), req.params.id, input);
    return { user: publicUser(user) };
  });
}
