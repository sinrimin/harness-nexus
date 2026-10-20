// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { FastifyInstance } from 'fastify';

/**
 * Liveness/readiness routes — no auth. Keep these side-effect free.
 *
 * #53: stays a route module on purpose — pure transport liveness, no domain
 * decision to extract (nothing here owns scope or validation logic).
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async () => {
    // TODO: probe storage connectivity
    return { status: 'ok' };
  });
}
