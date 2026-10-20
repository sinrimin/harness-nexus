// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { JwtService } from '../infra/jwt.js';
import { hashToken, PAT_PREFIX } from '../infra/crypto.js';

/**
 * Authentication & authorization — registered on the ROOT instance (not inside
 * an encapsulated plugin) so the `onRequest` hook applies to every route. In
 * Fastify, hooks added within `app.register(plugin)` only apply to that plugin's
 * child context, not sibling route plugins — registering at the root fixes that.
 *
 * Two credential channels (see wiki design-phase-1-auth.md):
 *   - JWT access token  → verified by jose, stateless
 *   - PAT `hnpat_…`     → sha256 lookup in the tokens repository
 *
 * The hook resolves either into `req.user = { id, role }` or leaves it null.
 * Route guards (`requireAuth` / `requireAdmin`) then enforce access — they are
 * attached per-route as preHandlers, not globally.
 *
 * Disabled users: JWTs are stateless, so a disabled user's token is not
 * intrinsically invalid. We do a fresh user lookup on each protected request to
 * reject disabled accounts. PAT lookups include this via the user row.
 */
export function registerAuthHook(app: FastifyInstance): void {
  const jwt: JwtService = app.jwt;
  const uow = app.uow;

  app.addHook('onRequest', async (req: FastifyRequest, _reply: FastifyReply) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      req.user = null;
      return;
    }
    const raw = header.slice('Bearer '.length).trim();

    if (raw.startsWith(PAT_PREFIX)) {
      const record = await uow.tokens.findByTokenHash(hashToken(raw));
      if (record && (!record.expiresAt || Date.parse(record.expiresAt) > Date.now())) {
        // Capability-scoped tokens are rejected by the REST API:
        // - marketplace (emit) tokens are URL-capability tokens for the 3.5
        //   emitter only.
        // - machine tokens (Phase 8 C1) authenticate only the realtime /ctl
        //   channel; a leaked one must not read user data.
        if (record.scopes.includes('marketplace') || record.scopes.includes('machine-ctl')) {
          req.user = null;
          return;
        }
        const user = await uow.users.findById(record.userId);
        if (user && user.status === 'active') {
          req.user = { id: user.id, role: user.role };
          void uow.tokens.touchLastUsed(record.id, new Date().toISOString());
          return;
        }
      }
      req.user = null;
      return;
    }

    // Treat anything else as a JWT.
    try {
      const payload = await jwt.verifyAccessToken(raw);
      const user = await uow.users.findById(payload.sub);
      if (user && user.status === 'active') {
        req.user = { id: user.id, role: user.role };
        return;
      }
    } catch {
      // invalid/expired JWT → treat as anonymous
    }
    req.user = null;
  });
}

// ---- per-route guard helpers (decorated in app.ts) ----
// These are attached to the instance in buildApp via app.decorate.

export async function requireAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.user) {
    await reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Authentication required' });
    return reply as unknown as void;
  }
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.user) {
    await reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Authentication required' });
    return reply as unknown as void;
  }
  if (req.user.role !== 'admin') {
    await reply.code(403).send({ error: 'FORBIDDEN', message: 'Admin role required' });
    return reply as unknown as void;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    user: { id: string; role: 'admin' | 'user' } | null;
  }
  interface FastifyInstance {
    jwt: JwtService;
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
