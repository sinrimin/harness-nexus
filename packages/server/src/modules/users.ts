// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { FastifyInstance } from 'fastify';
import {
  createUserSchema,
  updateRoleSchema,
  type CreateUserInput,
  type UpdateRoleInput,
} from '@harness-nexus/shared';
import { publicUser } from './serialize.js';
import { principalOf } from './principal.js';
import { createUser, deleteUser, listUsers, updateUserRole } from '../services/users.js';

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

  // ---- PATCH /api/users/:id/role ----
  app.patch<{ Params: { id: string } }>('/api/users/:id/role', adminGuard, async (req) => {
    const input = updateRoleSchema.parse(req.body) as UpdateRoleInput;
    const user = await updateUserRole(deps(), principalOf(req), req.params.id, input);
    return { user: publicUser(user) };
  });
}
