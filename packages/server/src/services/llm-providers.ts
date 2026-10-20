// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { Credential, LlmProvider } from '@harness-nexus/core';
import {
  AppError,
  type LlmModelInfo,
  type LlmProviderCreateInput,
  type LlmProviderUpdateInput,
  type ProviderApiKind,
  type ProviderModelConfig,
} from '@harness-nexus/shared';
import { decryptSecret, generateId } from '../infra/crypto.js';
import { findCredentialForOwner } from '../infra/credential-scope.js';
import { fetchProviderModels, ProviderModelsError } from '../infra/provider-models.js';
import type { Principal, ServiceDeps } from './principal.js';

/**
 * LLM provider domain service (#53 slice 6, Phase 9 W10) — cc-switch-style
 * reusable providers. Extracted verbatim from the route handlers; only the
 * door changed: callers pass an explicit principal and per-call deps.
 *
 * A provider is the ROUTE, never the secret: the API key lives in the
 * Credential store (referenced by name). Scope rules mirror credentials —
 * global: any user reads, admin mutates; personal: owner-only — with 404
 * existence-hiding for foreign rows. Model-list discovery resolves + decrypts
 * the credential SERVER-SIDE (the plaintext never reaches the browser) and
 * is the platform's second deliberate outbound HTTP surface.
 */

/**
 * Per-call deps: the credential encryption key (model-list discovery decrypts
 * the referenced secret server-side) and the fetch timeout — both
 * app-decorated config, threaded by the caller (services stay env-free).
 */
export interface LlmProviderDeps extends ServiceDeps {
  credentialEncryptionKey: string;
  providerModelsTimeoutMs: number;
}

/**
 * The credential must exist AND be resolvable in the caller's namespace
 * (#21). A GLOBAL credential additionally only travels to a
 * caller-controlled URL when the admin allowed it: admins may always, and
 * regular users only when the URL comes from a stored (admin-chosen)
 * provider config or the secret is marked distributable — a locked global
 * secret never leaves for an endpoint the caller picked.
 */
async function visibleCredential(
  deps: LlmProviderDeps,
  name: string,
  caller: Principal,
  callerControlsUrl: boolean,
): Promise<Credential> {
  const cred = await findCredentialForOwner(deps.uow, name, caller.userId);
  if (!cred) {
    throw new AppError(`Credential "${name}" not found`, 404, 'CREDENTIAL_NOT_FOUND');
  }
  if (
    cred.scope === 'global' &&
    caller.role !== 'admin' &&
    callerControlsUrl &&
    !cred.distributable
  ) {
    throw new AppError(
      `Credential "${name}" is a locked global secret — it cannot be used from a caller-chosen endpoint (ask an admin, or mark it distributable)`,
      403,
      'CREDENTIAL_NOT_DISTRIBUTABLE',
    );
  }
  return cred;
}

async function nameTaken(
  deps: LlmProviderDeps,
  name: string,
  scope: 'global' | 'personal',
  ownerId: string | null,
  exceptId?: string,
): Promise<boolean> {
  const existing = await deps.uow.llmProviders.findByName(
    name,
    scope,
    scope === 'global' ? undefined : (ownerId ?? undefined),
  );
  return existing !== null && existing.id !== exceptId;
}

export async function createLlmProvider(
  deps: LlmProviderDeps,
  principal: Principal,
  input: LlmProviderCreateInput & { scope: 'global' | 'personal' },
): Promise<LlmProvider> {
  if (input.scope === 'global' && principal.role !== 'admin') {
    throw new AppError('Only admins can create global providers', 403, 'FORBIDDEN');
  }
  // A personal provider's baseUrl is caller-chosen; a global provider's is
  // admin-chosen (admin-only create) — drives the credential gate above.
  await visibleCredential(deps, input.credentialName, principal, input.scope === 'personal');
  const ownerId = input.scope === 'global' ? null : principal.userId;
  if (await nameTaken(deps, input.name, input.scope, ownerId)) {
    throw new AppError(
      `Provider name "${input.name}" is already taken in this scope`,
      409,
      'PROVIDER_NAME_TAKEN',
    );
  }

  const now = new Date().toISOString();
  const provider: LlmProvider = {
    id: generateId(),
    name: input.name,
    api: input.api,
    baseUrl: input.baseUrl ?? null,
    credentialName: input.credentialName,
    scope: input.scope,
    ownerId,
    models: input.models as ProviderModelConfig[],
    createdAt: now,
    updatedAt: now,
  };
  await deps.uow.llmProviders.save(provider);
  return provider;
}

/** The caller's personal providers + all global providers. */
export async function listLlmProviders(
  deps: LlmProviderDeps,
  principal: Principal,
): Promise<LlmProvider[]> {
  const [personal, global] = await Promise.all([
    deps.uow.llmProviders.list({ scope: 'personal', ownerId: principal.userId }),
    deps.uow.llmProviders.list({ scope: 'global' }),
  ]);
  return [...personal, ...global];
}

export async function updateLlmProvider(
  deps: LlmProviderDeps,
  principal: Principal,
  id: string,
  input: LlmProviderUpdateInput,
): Promise<LlmProvider> {
  const existing = await deps.uow.llmProviders.findById(id);
  if (!existing || !canManage(existing, principal.userId, principal.role)) {
    throw new AppError('Provider not found', 404, 'PROVIDER_NOT_FOUND');
  }

  if (input.credentialName !== undefined && input.credentialName !== existing.credentialName) {
    await visibleCredential(deps, input.credentialName, principal, existing.scope === 'personal');
  }
  if (input.name !== undefined && input.name !== existing.name) {
    if (await nameTaken(deps, input.name, existing.scope, existing.ownerId, existing.id)) {
      throw new AppError(
        `Provider name "${input.name}" is already taken in this scope`,
        409,
        'PROVIDER_NAME_TAKEN',
      );
    }
  }

  const next: LlmProvider = {
    ...existing,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.api !== undefined ? { api: input.api } : {}),
    // `baseUrl: null` clears the override back to the official endpoint.
    ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
    ...(input.credentialName !== undefined ? { credentialName: input.credentialName } : {}),
    // #51 — full replace (the dialog edits a local copy and sends it whole).
    ...(input.models !== undefined ? { models: input.models as ProviderModelConfig[] } : {}),
    updatedAt: new Date().toISOString(),
  };
  await deps.uow.llmProviders.save(next);
  return next;
}

export async function deleteLlmProvider(
  deps: LlmProviderDeps,
  principal: Principal,
  id: string,
): Promise<void> {
  const existing = await deps.uow.llmProviders.findById(id);
  if (!existing || !canManage(existing, principal.userId, principal.role)) {
    throw new AppError('Provider not found', 404, 'PROVIDER_NOT_FOUND');
  }
  await deps.uow.llmProviders.delete(existing.id);
}

/** The parsed query-models body (providerModelsQuerySchema output shape). */
export interface ProviderModelsQuery {
  providerId?: string | undefined;
  api?: ProviderApiKind | undefined;
  baseUrl?: string | undefined;
  credentialName?: string | undefined;
}

/**
 * The 获取模型 button's backing operation: accepts a stored `providerId` OR
 * explicit `{api, baseUrl?, credentialName}` (the create dialog / machine-page
 * manual arm use it BEFORE anything is saved, mirroring cc-switch's
 * fetch-from-form behavior). Resolves + decrypts the credential server-side
 * and maps fetch failures onto AppError so both doors share one mapping.
 */
export async function queryProviderModels(
  deps: LlmProviderDeps,
  principal: Principal,
  input: ProviderModelsQuery,
): Promise<LlmModelInfo[]> {
  let api: ProviderApiKind;
  let baseUrl: string | undefined;
  let credentialName: string;
  /** Who chose the endpoint: stored rows carry their owner's trust level. */
  let callerControlsUrl: boolean;
  if (input.providerId !== undefined) {
    const provider = await deps.uow.llmProviders.findById(input.providerId);
    if (!provider || !visibleTo(provider, principal.userId)) {
      throw new AppError('Provider not found', 404, 'PROVIDER_NOT_FOUND');
    }
    api = provider.api;
    baseUrl = provider.baseUrl ?? undefined;
    credentialName = provider.credentialName;
    callerControlsUrl = provider.scope === 'personal';
  } else {
    api = input.api!;
    baseUrl = input.baseUrl;
    credentialName = input.credentialName!;
    callerControlsUrl = true;
  }

  const cred = await visibleCredential(deps, credentialName, principal, callerControlsUrl);
  const secret = decryptSecret(cred.secret, deps.credentialEncryptionKey);
  try {
    return await fetchProviderModels(
      { api, ...(baseUrl !== undefined ? { baseUrl } : {}), apiKey: secret },
      { timeoutMs: deps.providerModelsTimeoutMs },
    );
  } catch (err) {
    if (err instanceof ProviderModelsError) {
      if (err.kind === 'timeout') {
        throw new AppError(err.message, 504, 'PROVIDER_MODELS_TIMEOUT');
      }
      throw new AppError(err.message, 502, 'PROVIDER_MODELS_FAILED');
    }
    throw err;
  }
}

/** A row is manageable iff owner (personal) or admin on a global row (#36). */
function canManage(p: LlmProvider, userId: string, role: 'admin' | 'user'): boolean {
  return p.scope === 'global' ? role === 'admin' : p.ownerId === userId;
}

/** A row is readable iff admin, owner, or global (credentials' read rule). */
function visibleTo(p: LlmProvider, userId: string): boolean {
  return p.scope === 'global' || p.ownerId === userId;
}
