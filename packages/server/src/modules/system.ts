import type { FastifyInstance } from 'fastify';
import { serverVersion } from '../version.js';

/**
 * System info (#37) — the one authenticated place the UI (and anything else)
 * learns the server build version. Compare client-side against
 * `Machine.daemonVersion` (the daemon reports its CLI version in every
 * `machine:hello`) to flag stale daemons; mismatch WARNs, never blocks — the
 * realtime proto number remains the compatibility gate.
 */
export async function systemRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth] };

  app.get('/api/system/info', guard, async () => ({ version: serverVersion() }));
}
