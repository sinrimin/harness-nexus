// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { randomUUID } from 'node:crypto';
import type { ApiToolService } from '@harness-nexus/core';
import {
  AppError,
  apiToolServiceBundleSchema,
  type ApiToolServiceBundle,
} from '@harness-nexus/shared';
import type { Principal, ServiceDeps } from './principal.js';

/**
 * Issue #80 — API tool services: the #53 service slice for the LLM-authored
 * JSON bundles. Routes are thin; THIS is the single authorization point
 * (#36: personal = owner-only for every role, admin additionally owns the
 * global namespace). The bundle itself is validated by the shared zod schema
 * (the LLM feedback loop's first gate); the probe panel is the behavioral
 * one (runtime slice).
 *
 * Secrets never ride the bundle: `auth.credentialName` names a credential
 * row, resolved (and re-resolved at request time) through the standard
 * credential scoping — validated to EXIST and be visible at save time so
 * the uploader learns early.
 */

export interface CreateApiToolServiceInput {
  /** Admin-only; personal is the default for everyone. */
  scope?: 'global' | 'personal';
  bundle: unknown;
}

export interface UpdateApiToolServiceInput {
  bundle: unknown;
}

async function requireVisibleCredential(
  deps: ServiceDeps,
  principal: Principal,
  name: string,
): Promise<void> {
  // Same resolution order as `${cred:NAME}`: global first, then the owner's.
  const global = await deps.uow.credentials.findByName(name, 'global');
  if (global !== null) return;
  const personal =
    principal.userId !== ''
      ? await deps.uow.credentials.findByName(name, 'personal', principal.userId)
      : null;
  if (personal === null) {
    throw new AppError(
      `Credential "${name}" does not exist or is not visible to you`,
      422,
      'API_TOOL_CREDENTIAL_NOT_VISIBLE',
    );
  }
}

function validateBundleAuth(
  deps: ServiceDeps,
  principal: Principal,
  bundle: ApiToolServiceBundle,
): Promise<void> {
  if (bundle.auth === undefined) return Promise.resolve();
  return requireVisibleCredential(deps, principal, bundle.auth.credentialName);
}

async function assertNameFree(
  deps: ServiceDeps,
  scope: 'global' | 'personal',
  ownerId: string | null,
  name: string,
): Promise<void> {
  const rows = await deps.uow.apiTools.list({ scope, ...(ownerId !== null ? { ownerId } : {}) });
  if (rows.some((r) => r.name === name)) {
    throw new AppError(
      `API tool service "${name}" already exists in this scope`,
      409,
      'API_TOOL_NAME_TAKEN',
    );
  }
}

function toDomain(
  id: string,
  scope: 'global' | 'personal',
  ownerId: string | null,
  bundle: ApiToolServiceBundle,
  now: string,
): ApiToolService {
  return {
    id,
    scope,
    ownerId,
    name: bundle.name,
    ...(bundle.description !== undefined ? { description: bundle.description } : {}),
    baseUrl: bundle.baseUrl,
    headers: bundle.headers,
    ...(bundle.auth !== undefined ? { auth: bundle.auth } : {}),
    tools: bundle.tools,
    createdAt: now,
    updatedAt: now,
  };
}

export async function createApiToolService(
  deps: ServiceDeps,
  principal: Principal,
  input: CreateApiToolServiceInput,
): Promise<ApiToolService> {
  const scope = input.scope === 'global' ? 'global' : 'personal';
  if (scope === 'global' && principal.role !== 'admin') {
    throw new AppError('Only admins create global API tool services', 403, 'FORBIDDEN');
  }
  const bundle = apiToolServiceBundleSchema.parse(input.bundle) as ApiToolServiceBundle;
  await validateBundleAuth(deps, principal, bundle);
  await assertNameFree(deps, scope, scope === 'global' ? null : principal.userId, bundle.name);
  const now = new Date().toISOString();
  const service = toDomain(
    `at_${randomUUID()}`,
    scope,
    scope === 'global' ? null : principal.userId,
    bundle,
    now,
  );
  await deps.uow.apiTools.save(service);
  return service;
}

/** The #36 read set: global rows + the principal's own personal rows. */
export async function listApiToolServices(
  deps: ServiceDeps,
  principal: Principal,
): Promise<ApiToolService[]> {
  const [global, personal] = await Promise.all([
    deps.uow.apiTools.list({ scope: 'global' }),
    deps.uow.apiTools.list({ scope: 'personal', ownerId: principal.userId }),
  ]);
  return [...global, ...personal].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Owner-or-admin(-for-global) with 404-hiding for everyone else. */
export async function getApiToolService(
  deps: ServiceDeps,
  principal: Principal,
  id: string,
): Promise<ApiToolService> {
  const service = await deps.uow.apiTools.findById(id);
  if (service === null || service.deletedAt !== undefined) {
    throw new AppError('API tool service not found', 404, 'API_TOOL_NOT_FOUND');
  }
  if (service.scope === 'personal' && service.ownerId !== principal.userId) {
    throw new AppError('API tool service not found', 404, 'API_TOOL_NOT_FOUND');
  }
  return service;
}

/** Full-bundle replace; identity (scope/owner) is immutable. */
export async function updateApiToolService(
  deps: ServiceDeps,
  principal: Principal,
  id: string,
  input: UpdateApiToolServiceInput,
): Promise<ApiToolService> {
  const existing = await getApiToolService(deps, principal, id);
  const bundle = apiToolServiceBundleSchema.parse(input.bundle);
  await validateBundleAuth(deps, principal, bundle);
  if (bundle.name !== existing.name) {
    await assertNameFree(
      deps,
      existing.scope,
      existing.scope === 'global' ? null : existing.ownerId,
      bundle.name,
    );
  }
  const next: ApiToolService = {
    ...existing,
    name: bundle.name,
    baseUrl: bundle.baseUrl,
    headers: bundle.headers,
    tools: bundle.tools,
    updatedAt: new Date().toISOString(),
  };
  // Omitted in the new bundle = cleared (exactOptionalPropertyTypes: delete,
  // not undefined-assign).
  if (bundle.description !== undefined) next.description = bundle.description;
  else delete next.description;
  if (bundle.auth !== undefined) next.auth = bundle.auth;
  else delete next.auth;
  await deps.uow.apiTools.save(next);
  return next;
}

/** Soft delete — rows stay resolvable for dangling references. */
export async function deleteApiToolService(
  deps: ServiceDeps,
  principal: Principal,
  id: string,
): Promise<void> {
  const existing = await getApiToolService(deps, principal, id);
  await deps.uow.apiTools.save({
    ...existing,
    deletedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}
