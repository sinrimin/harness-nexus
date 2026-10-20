// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { Credential } from '@harness-nexus/core';
import {
  AppError,
  type CreateCredentialInput,
  type UpdateCredentialInput,
} from '@harness-nexus/shared';
import { decryptSecret, encryptSecret, generateId, maskSecret } from '../infra/crypto.js';
import type { Principal, ServiceDeps } from './principal.js';

/**
 * Credential domain service (#53 slice 7) — named secrets referenced by MCP
 * transports via `${cred:NAME}` placeholders. A credential is a pure name +
 * secret + scope. Extracted verbatim from the route handlers; only the door
 * changed. Encryption stays in infra/crypto, keyed by the per-call dep.
 *
 * Scope rules (see wiki design-phase-2.1-credentials.md):
 *   global   — any authenticated user can read; admin only to create/update/delete.
 *   personal — owner only for all operations.
 */

/**
 * Per-call deps: the AES-GCM key material (config-threaded; services stay
 * env-free) — every write encrypts and the preview helper decrypts with it.
 */
export interface CredentialDeps extends ServiceDeps {
  credentialEncryptionKey: string;
}

/**
 * Name uniqueness per (name, scope, owner) (#21) — read-then-write, the
 * same convention as profiles/resources/llm-providers. Without it a
 * same-named credential could shadow another tenant's in `${cred:NAME}`
 * resolution.
 */
async function nameTaken(
  deps: CredentialDeps,
  name: string,
  scope: 'global' | 'personal',
  ownerId: string | null,
  exceptId?: string,
): Promise<boolean> {
  const existing = await deps.uow.credentials.findByName(name, scope, ownerId ?? undefined);
  return existing !== null && existing.id !== exceptId;
}

export async function createCredential(
  deps: CredentialDeps,
  principal: Principal,
  input: CreateCredentialInput,
): Promise<Credential> {
  // global scope requires admin.
  if (input.scope === 'global' && principal.role !== 'admin') {
    throw new AppError('Only admins can create global credentials', 403, 'FORBIDDEN');
  }

  const ownerId = input.scope === 'global' ? null : principal.userId;
  if (await nameTaken(deps, input.name, input.scope, ownerId)) {
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
    secret: encryptSecret(input.secret, deps.credentialEncryptionKey),
    scope: input.scope,
    ownerId,
    // Phase 8 C2: personal secrets belong to the owner and may reach their
    // own machines; global secrets stay on the server unless an admin opts in.
    distributable: input.scope === 'personal' ? true : (input.distributable ?? false),
    createdAt: now,
    updatedAt: now,
  };
  await deps.uow.credentials.save(credential);
  return credential;
}

/** The caller's personal credentials + all global credentials. */
export async function listCredentials(
  deps: CredentialDeps,
  principal: Principal,
): Promise<Credential[]> {
  const [personal, global] = await Promise.all([
    deps.uow.credentials.list({ scope: 'personal', ownerId: principal.userId }),
    deps.uow.credentials.list({ scope: 'global' }),
  ]);
  return [...personal, ...global];
}

export async function updateCredential(
  deps: CredentialDeps,
  principal: Principal,
  id: string,
  input: UpdateCredentialInput,
): Promise<Credential> {
  const existing = await deps.uow.credentials.findById(id);
  if (!existing || !canManage(existing, principal.userId, principal.role)) {
    throw new AppError('Credential not found', 404, 'CREDENTIAL_NOT_FOUND');
  }

  const next: Credential = {
    ...existing,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.secret !== undefined
      ? { secret: encryptSecret(input.secret, deps.credentialEncryptionKey) }
      : {}),
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
    (await nameTaken(deps, input.name, existing.scope, existing.ownerId, existing.id))
  ) {
    throw new AppError(
      `Credential name "${input.name}" is already taken in this scope`,
      409,
      'CREDENTIAL_NAME_TAKEN',
    );
  }
  await deps.uow.credentials.save(next);
  return next;
}

export async function deleteCredential(
  deps: CredentialDeps,
  principal: Principal,
  id: string,
): Promise<void> {
  const existing = await deps.uow.credentials.findById(id);
  if (!existing || !canManage(existing, principal.userId, principal.role)) {
    throw new AppError('Credential not found', 404, 'CREDENTIAL_NOT_FOUND');
  }
  await deps.uow.credentials.delete(existing.id);
}

/**
 * The recognition-only secret preview for display — decrypt-for-masking; the
 * plaintext itself never leaves this layer. Callers frame their views with it.
 */
export function credentialSecretPreview(deps: CredentialDeps, credential: Credential): string {
  return maskSecret(decryptSecret(credential.secret, deps.credentialEncryptionKey));
}

/**
 * A record is manageable iff the owner (personal) or an admin on a global row
 * — #36: admins curate the global library, not other users' personal secrets.
 */
function canManage(c: Credential, userId: string, role: 'admin' | 'user'): boolean {
  return c.scope === 'global' ? role === 'admin' : c.ownerId === userId;
}
