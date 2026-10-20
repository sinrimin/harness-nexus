// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { FastifyInstance } from 'fastify';
import {
  createCredentialSchema,
  updateCredentialSchema,
  type CreateCredentialInput,
  type UpdateCredentialInput,
} from '@harness-nexus/shared';
import { credentialView } from './serialize.js';
import { principalOf } from './principal.js';
import {
  createCredential,
  credentialSecretPreview,
  deleteCredential,
  listCredentials,
  updateCredential,
} from '../services/credentials.js';

/**
 * Credential routes — thin HTTP adapters over the domain service
 * (`services/credentials.ts`, #53 slice 7). Every scope decision and the
 * encryption itself live in the service; this file authenticates, parses the
 * wire shape, and frames the masked view.
 */
export async function credentialsRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth] };
  const deps = () => ({
    uow: app.uow,
    credentialEncryptionKey: app.credentialEncryptionKey,
  });

  // ---- POST /api/credentials ----
  app.post('/api/credentials', guard, async (req, reply) => {
    const input = createCredentialSchema.parse(req.body) as CreateCredentialInput;
    const credential = await createCredential(deps(), principalOf(req), input);
    return reply.code(201).send({
      credential: credentialView(credential, credentialSecretPreview(deps(), credential)),
    });
  });

  // ---- GET /api/credentials ----
  app.get('/api/credentials', guard, async (req) => {
    const credentials = await listCredentials(deps(), principalOf(req));
    // Decrypt for masking only; the plaintext is not returned.
    return {
      credentials: credentials.map((c) => credentialView(c, credentialSecretPreview(deps(), c))),
    };
  });

  // ---- PATCH /api/credentials/:id ----
  app.patch<{ Params: { id: string } }>('/api/credentials/:id', guard, async (req) => {
    const input = updateCredentialSchema.parse(req.body) as UpdateCredentialInput;
    const credential = await updateCredential(deps(), principalOf(req), req.params.id, input);
    return { credential: credentialView(credential, credentialSecretPreview(deps(), credential)) };
  });

  // ---- DELETE /api/credentials/:id ----
  app.delete<{ Params: { id: string } }>('/api/credentials/:id', guard, async (req) => {
    await deleteCredential(deps(), principalOf(req), req.params.id);
    return { ok: true };
  });
}
