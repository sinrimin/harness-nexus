// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { FastifyInstance } from 'fastify';
import { principalOf } from './principal.js';
import { getSystemInfo } from '../services/system.js';

/**
 * System info routes (#37 · #53 slice 4) — thin adapter over
 * `services/system.ts`; see the service for the version-surfacing contract.
 */
export async function systemRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth] };

  app.get('/api/system/info', guard, async (req) => getSystemInfo(principalOf(req)));
}
