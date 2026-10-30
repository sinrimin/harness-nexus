// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { FastifyInstance } from 'fastify';
import { decisionRecordListQuerySchema } from '@harness-nexus/shared';
import { principalOf } from './principal.js';
import { listDecisionRecords } from '../services/decision-records.js';

/** #97 — one read-only list route; the two dialog entries fetch through it. */
export async function decisionRecordRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth] };

  // ---- GET /api/decision-records ----
  app.get('/api/decision-records', guard, async (req) => {
    const query = decisionRecordListQuerySchema.parse(req.query);
    const records = await listDecisionRecords({ uow: app.uow }, principalOf(req), query);
    return { records };
  });
}
