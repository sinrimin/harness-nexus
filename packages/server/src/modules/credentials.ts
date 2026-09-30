import type { FastifyInstance } from 'fastify';
import type { Credential } from '@harness-nexus/core';
import {
  AppError,
  createCredentialSchema,
  updateCredentialSchema,
  type CreateCredentialInput,
  type UpdateCredentialInput,
} from '@harness-nexus/shared';
import { generateId, encryptSecret, decryptSecret, maskSecret } from '../infra/crypto.js';
import { credentialView } from './serialize.js';

/**
 * Credential management — named secrets referenced by MCP transports via
 * `${cred:NAME}` placeholders. A credential is a pure name + secret + scope.
 *
 * Scope rules (see wiki design-phase-2.1-credentials.md):
 *   global   — any authenticated user can read; admin only to create/update/delete.
 *   personal — owner only for all operations.
 */
export async function credentialsRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth] };
  const key = app.credentialEncryptionKey;

  /**
   * Name uniqueness per (name, scope, owner) (#21) — read-then-write, the
   * same convention as profiles/resources/llm-providers. Without it a
   * same-named credential could shadow another tenant's in `${cred:NAME}`
   * resolution.
   */
  const nameTaken = async (
    name: string,
    scope: 'global' | 'personal',
    ownerId: string | null,
    exceptId?: string,
  ): Promise<boolean> => {
    const existing = await app.uow.credentials.findByName(name, scope, ownerId ?? undefined);
    return existing !== null && existing.id !== exceptId;
  };

  // ---- POST /api/credentials ----
  app.post('/api/credentials', guard, async (req, reply) => {
    const input = createCredentialSchema.parse(req.body) as CreateCredentialInput;

    // global scope requires admin.
    if (input.scope === 'global' && req.user!.role !== 'admin') {
      throw new AppError('Only admins can create global credentials', 403, 'FORBIDDEN');
    }

    const ownerId = input.scope === 'global' ? null : req.user!.id;
    if (await nameTaken(input.name, input.scope, ownerId)) {
      throw new AppError(
        `Credential name "${input.name}" is already taken in this scope`,
        409,
        'CREDENTIAL_NAME_TAKEN',
      );
    }

    const now = new Date().toISOString();
    const credential: Credential = {
      id: generateId(),
      name: input.name,
      secret: encryptSecret(input.secret, key),
      scope: input.scope,
      ownerId,
      // Phase 8 C2: personal secrets belong to the owner and may reach their
      // own machines; global secrets stay on the server unless an admin opts in.
      distributable: input.scope === 'personal' ? true : (input.distributable ?? false),
      createdAt: now,
      updatedAt: now,
    };
    await app.uow.credentials.save(credential);
    return reply.code(201).send({
      credential: credentialView(credential, maskSecret(input.secret)),
    });
  });

  // ---- GET /api/credentials ----
  app.get('/api/credentials', guard, async (req) => {
    const [personal, global] = await Promise.all([
      app.uow.credentials.list({ scope: 'personal', ownerId: req.user!.id }),
      app.uow.credentials.list({ scope: 'global' }),
    ]);
    // Decrypt for masking only; the plaintext is not returned.
    const view = (c: Credential) => credentialView(c, maskSecret(decryptSecret(c.secret, key)));
    return { credentials: [...personal, ...global].map(view) };
  });

  // ---- PATCH /api/credentials/:id ----
  app.patch<{ Params: { id: string } }>('/api/credentials/:id', guard, async (req) => {
    const input = updateCredentialSchema.parse(req.body) as UpdateCredentialInput;
    const existing = await app.uow.credentials.findById(req.params.id);
    if (!existing || !canManage(existing, req.user!.id, req.user!.role)) {
      throw new AppError('Credential not found', 404, 'CREDENTIAL_NOT_FOUND');
    }

    const next: Credential = {
      ...existing,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.secret !== undefined ? { secret: encryptSecret(input.secret, key) } : {}),
      // `distributable` is only meaningful for global credentials (personal
      // ones are always distributable); ignore attempts to flip it otherwise.
      ...(input.distributable !== undefined && existing.scope === 'global'
        ? { distributable: input.distributable }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    if (
      input.name !== undefined &&
      input.name !== existing.name &&
      (await nameTaken(input.name, existing.scope, existing.ownerId, existing.id))
    ) {
      throw new AppError(
        `Credential name "${input.name}" is already taken in this scope`,
        409,
        'CREDENTIAL_NAME_TAKEN',
      );
    }
    await app.uow.credentials.save(next);
    const plaintext =
      input.secret !== undefined ? input.secret : decryptSecret(existing.secret, key);
    return { credential: credentialView(next, maskSecret(plaintext)) };
  });

  // ---- DELETE /api/credentials/:id ----
  app.delete<{ Params: { id: string } }>('/api/credentials/:id', guard, async (req) => {
    const existing = await app.uow.credentials.findById(req.params.id);
    if (!existing || !canManage(existing, req.user!.id, req.user!.role)) {
      throw new AppError('Credential not found', 404, 'CREDENTIAL_NOT_FOUND');
    }
    await app.uow.credentials.delete(existing.id);
    return { ok: true };
  });
}

/**
 * A record is manageable iff the owner (personal) or an admin on a global row
 * — #36: admins curate the global library, not other users' personal secrets.
 */
function canManage(c: Credential, userId: string, role: 'admin' | 'user'): boolean {
  return c.scope === 'global' ? role === 'admin' : c.ownerId === userId;
}
