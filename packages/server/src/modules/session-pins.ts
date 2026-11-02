// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { FastifyInstance } from 'fastify';
import { sessionPinPutSchema } from '@harness-nexus/shared';
import { principalOf } from './principal.js';
import { listSessionPins, pinSession, unpinSession } from '../services/session-pins.js';

/**
 * #110 — the pin store behind both session rails. Three thin routes: the
 * listing (one GET per rail mount) and idempotent pin/unpin. The body names
 * the session by axis; the service composes the storage key. Every route is
 * the caller's own rows — there is no wider scope to check (#36).
 */
export async function sessionPinRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth] };

  app.get('/api/session-pins', guard, async (req) => {
    const pins = await listSessionPins({ uow: app.uow }, principalOf(req));
    return { pins };
  });

  app.put('/api/session-pins', guard, async (req) => {
    const input = sessionPinPutSchema.parse(req.body);
    const pin = await pinSession({ uow: app.uow }, principalOf(req), input);
    return { pin };
  });

  app.delete('/api/session-pins', guard, async (req) => {
    const input = sessionPinPutSchema.parse(req.body);
    await unpinSession({ uow: app.uow }, principalOf(req), input);
    return { ok: true };
  });
}
