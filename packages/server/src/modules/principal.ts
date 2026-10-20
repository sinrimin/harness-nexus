// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { FastifyRequest } from 'fastify';
import type { Principal } from '../services/principal.js';

/**
 * The HTTP door's principal adapter (#53): the root auth hook resolved
 * `req.user`; routes hand it to services as the explicit principal. Callers
 * behind `requireAuth` may assert non-null.
 */
export function principalOf(req: FastifyRequest): Principal {
  const user = req.user;
  if (user === null || user === undefined) {
    throw new Error('principalOf on an unauthenticated request (missing requireAuth?)');
  }
  return { userId: user.id, role: user.role };
}
