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
import { matchAllowlist } from '../api-tools/runtime.js';
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

/**
 * Credential names must resolve the way the RUNTIME will resolve them — the
 * ROW's scope, not the saver's visibility (#21 discipline, same as MCP rows):
 * a global service runs for every user and can reference GLOBAL credentials
 * only (a personal secret would dangle for everyone else at call time); a
 * personal service resolves global first, then its owner's. Checked at save
 * time so the author learns here, not at first call.
 */
async function assertCredentialResolvable(
  deps: ServiceDeps,
  scope: 'global' | 'personal',
  ownerId: string | null,
  name: string,
): Promise<void> {
  const global = await deps.uow.credentials.findByName(name, 'global');
  if (global !== null) return;
  if (scope === 'personal') {
    const personal =
      ownerId !== null ? await deps.uow.credentials.findByName(name, 'personal', ownerId) : null;
    if (personal !== null) return;
    throw new AppError(
      `Credential "${name}" does not exist or is not visible to you`,
      422,
      'API_TOOL_CREDENTIAL_NOT_VISIBLE',
    );
  }
  throw new AppError(
    `Credential "${name}" is not a GLOBAL credential — a global API tool service runs for every user, so it can only reference global credentials (move the credential to global scope, or the service to personal)`,
    409,
    'API_TOOL_CREDENTIAL_SCOPE',
  );
}

function validateBundleAuth(
  deps: ServiceDeps,
  scope: 'global' | 'personal',
  ownerId: string | null,
  bundle: ApiToolServiceBundle,
): Promise<void> {
  if (bundle.auth === undefined) return Promise.resolve();
  return assertCredentialResolvable(deps, scope, ownerId, bundle.auth.credentialName);
}

/**
 * While the outbound policy is `restricted` (#85), a saved service whose
 * baseUrl host is not on the allowlist could never dial out, so the author
 * (human, dialog, or the #81 meta tool) learns at SAVE time, not at first
 * probe — same match the runtime applies at call time. In `open` mode any
 * http/https host saves (the runtime still hard-denies metadata ranges).
 */
async function assertHostAllowlisted(deps: ServiceDeps, baseUrl: string): Promise<void> {
  const settings = await deps.uow.settings.get();
  if ((settings.apiToolOutbound ?? 'open') !== 'restricted') return;
  const host = new URL(baseUrl).hostname;
  if (matchAllowlist(host, settings.apiToolAllowlist ?? []) === null) {
    throw new AppError(
      `host ${host} is not on the API tool allowlist — an admin must add it (API tools → outbound allowlist) before this service can dial out`,
      409,
      'API_TOOL_HOST_NOT_ALLOWLISTED',
    );
  }
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
  await assertHostAllowlisted(deps, bundle.baseUrl);
  await validateBundleAuth(deps, scope, scope === 'global' ? null : principal.userId, bundle);
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

/**
 * Full-bundle replace; identity (scope/owner) is immutable. Global rows are
 * admin-managed (#36 — same rule as create): a plain user who can READ a
 * global service cannot rewrite or delete it.
 */
export async function updateApiToolService(
  deps: ServiceDeps,
  principal: Principal,
  id: string,
  input: UpdateApiToolServiceInput,
): Promise<ApiToolService> {
  const existing = await getApiToolService(deps, principal, id);
  assertCanManage(existing, principal);
  const bundle = apiToolServiceBundleSchema.parse(input.bundle);
  await assertHostAllowlisted(deps, bundle.baseUrl);
  await validateBundleAuth(deps, existing.scope, existing.ownerId, bundle);
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
  assertCanManage(existing, principal);
  await deps.uow.apiTools.save({
    ...existing,
    deletedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

/** #36: admins curate the global namespace; personal rows are owner-only. */
function assertCanManage(service: ApiToolService, principal: Principal): void {
  if (service.scope === 'global' && principal.role !== 'admin') {
    throw new AppError('Only admins manage global API tool services', 403, 'FORBIDDEN');
  }
}
