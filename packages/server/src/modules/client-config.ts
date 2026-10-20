// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '@harness-nexus/shared';
import { hashToken, PAT_PREFIX } from '../infra/crypto.js';
import {
  buildClientMcpConfig,
  buildDeployBundle,
  buildRuntimeConfigBundle,
  type ClientCaller,
  type ClientConfigDeps,
} from '../services/client-config.js';

/**
 * Client config fetch (Phase 8 C2) — `GET /api/client/mcp-config?profile=<id>`.
 *
 * The single REST surface a `hnx mcp serve` shim talks to before serving an
 * agent tool. All decision + resolution logic lives in
 * `services/client-config.ts` (#53 slice 15); what stays HERE is the machine
 * PAT authentication itself (`resolveClientCaller` — Fastify/jwt-coupled, the
 * one REST exception for machine tokens) and the reply framing.
 */
export async function clientConfigRoutes(app: FastifyInstance): Promise<void> {
  // #53 residue: the caller (an api PAT / JWT user, or a machine-ctl PAT
  // mapped to its machine's owner) is resolved HERE — the auth channel is a
  // transport concern; the service takes the resolved caller and owns every
  // visibility decision after that.
  const clientDeps = (): ClientConfigDeps => ({
    uow: app.uow,
    credentialEncryptionKey: app.credentialEncryptionKey,
    publicBaseUrl: app.publicBaseUrl,
  });

  app.get('/api/client/mcp-config', async (req: FastifyRequest, reply) => {
    const caller = await resolveClientCaller(app, req);
    if (!caller) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }
    const config = await buildClientMcpConfig(
      clientDeps(),
      caller,
      (req.query as { profile?: string }).profile,
    );
    return reply.send(config);
  });

  // ---- GET /api/client/deploy-bundle?profile=<id> (C4) ----
  // The resolved profile bundle a daemon's deploy job needs — exactly what
  // the CLI resolver would otherwise fetch N+1. Machine PAT exception #2:
  // same auth + visibility treatment as /api/client/mcp-config.
  app.get('/api/client/deploy-bundle', async (req, reply) => {
    const caller = await resolveClientCaller(app, req);
    if (!caller) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }
    const bundle = await buildDeployBundle(
      clientDeps(),
      caller,
      (req.query as { profile?: string }).profile,
    );
    return reply.send(bundle);
  });

  // ---- GET /api/client/runtime-config?target=<t> (Phase 9 W3) ----
  // The resolved provider bundle an apply-config job's daemon executor needs.
  // Machine PAT exception #3 — and the TIGHTEST one: this is the only surface
  // that ever carries the spec's plaintext (a non-machine caller gets a flat
  // 404, no existence leak — enforced in the service).
  app.get('/api/client/runtime-config', async (req, reply) => {
    const caller = await resolveClientCaller(app, req);
    if (!caller) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }
    const bundle = await buildRuntimeConfigBundle(
      clientDeps(),
      caller,
      (req.query as { target?: string }).target,
    );
    return reply.send(bundle);
  });
}

/**
 * Resolve the caller from the Authorization header. Machine PATs
 * (`machine-ctl`) map to their machine's owner — the ONLY REST surfaces they
 * unlock (mcp-config + deploy-bundle); the root auth hook rejects them
 * everywhere else. Marketplace tokens
 * are rejected (their blast radius is the emitter URL only).
 */
async function resolveClientCaller(
  app: FastifyInstance,
  req: FastifyRequest,
): Promise<ClientCaller | null> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const raw = header.slice('Bearer '.length).trim();

  if (raw.startsWith(PAT_PREFIX)) {
    const record = await app.uow.tokens.findByTokenHash(hashToken(raw));
    if (!record || (record.expiresAt && Date.parse(record.expiresAt) <= Date.now())) return null;
    if (record.scopes.includes('marketplace')) return null;

    if (record.scopes.includes('machine-ctl')) {
      const machine = await app.uow.machines.findByEnrollmentPatId(record.id);
      if (!machine) return null;
      const user = await app.uow.users.findById(machine.ownerId);
      return user?.status === 'active'
        ? { userId: user.id, role: user.role, machineId: machine.id }
        : null;
    }
    const user = await app.uow.users.findById(record.userId);
    return user?.status === 'active' ? { userId: user.id, role: user.role } : null;
  }

  try {
    const payload = await app.jwt.verifyAccessToken(raw);
    const user = await app.uow.users.findById(payload.sub);
    return user?.status === 'active' ? { userId: user.id, role: user.role } : null;
  } catch {
    return null;
  }
}
