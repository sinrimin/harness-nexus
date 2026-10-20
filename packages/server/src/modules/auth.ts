// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { FastifyInstance } from 'fastify';
import {
  loginSchema,
  registerSchema,
  type LoginInput,
  type RegisterInput,
} from '@harness-nexus/shared';
import { publicUser } from './serialize.js';
import { principalOf } from './principal.js';
import { getCurrentUser, loginUser, registerUser } from '../services/auth.js';

/**
 * Auth routes — thin HTTP adapters over the domain service
 * (`services/auth.ts`, #53 slice 10). The registration switch, bootstrap-admin
 * pick, and disabled-account rules live in the service; this file parses,
 * shapes replies, and rate-limits (transport concerns).
 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  const deps = () => ({ uow: app.uow, jwt: app.jwt });

  // #21: the bootstrap role pick (first user = admin) is check-then-act;
  // serializing registrations keeps two concurrent registers from both
  // reading count() === 0 and minting two admins. The chain is per-instance
  // transport state, so it stays HERE, serializing calls into the stateless
  // service.
  let registerQueue: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(run: () => Promise<T>): Promise<T> => {
    const next = registerQueue.then(run, run);
    registerQueue = next.catch(() => {});
    return next;
  };

  // ---- POST /api/auth/register ----
  app.post(
    '/api/auth/register',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) =>
      enqueue(async () => {
        const input = registerSchema.parse(req.body) as RegisterInput;
        const { user, token } = await registerUser(deps(), input);
        req.log.info({ userId: user.id, role: user.role }, 'user registered');
        return reply.code(201).send({ token, user: publicUser(user) });
      }),
  );

  // ---- POST /api/auth/login ----
  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, _reply) => {
      const input = loginSchema.parse(req.body) as LoginInput;
      const { user, token } = await loginUser(deps(), input);
      return { token, user: publicUser(user) };
    },
  );

  // ---- GET /api/auth/me ----
  app.get('/api/auth/me', { preHandler: [app.requireAuth] }, async (req) => {
    const user = await getCurrentUser({ uow: app.uow }, principalOf(req));
    return { user: publicUser(user) };
  });
}
