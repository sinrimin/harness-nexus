// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { Profile, ProfileEntry } from '@harness-nexus/core';
import {
  AppError,
  bumpProfileVersion,
  INITIAL_PROFILE_VERSION,
  type CreateProfileInput,
  type ProfileEntryInput,
  type UpdateProfileInput,
} from '@harness-nexus/shared';
import { generateId } from '../infra/crypto.js';
import type { Principal, ServiceDeps } from './principal.js';

/**
 * Profile domain service (#53 slice 5) — named bundles of MCP servers (and,
 * later, other resources) that Agent tools connect through via
 * `?profile=<id>` on /mcp. Extracted verbatim from the route handlers; only
 * the door changed: callers pass an explicit principal and receive domain
 * rows.
 *
 * Scope rules (see wiki design-phase-2.2-registry.md) match credentials / mcp-servers:
 *   global   — any authenticated user can read; admin only to create/update/delete.
 *   personal — owner only for all operations.
 */

export async function createProfile(
  deps: ServiceDeps,
  principal: Principal,
  input: CreateProfileInput,
): Promise<Profile> {
  if (input.scope === 'global' && principal.role !== 'admin') {
    throw new AppError('Only admins can create global profiles', 403, 'FORBIDDEN');
  }
  const entries = await resolveEntries(deps, input.entries, principal.userId);

  const now = new Date().toISOString();
  const profile: Profile = {
    id: generateId(),
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    // Auto-numbered (#18): new profiles start at 0.1; the version bumps
    // only when entries change (decimal, carry at 16 — see shared
    // profile-version.ts). Client-sent versions are ignored.
    version: INITIAL_PROFILE_VERSION,
    target: input.target,
    scope: input.scope,
    ownerId: input.scope === 'global' ? null : principal.userId,
    entries,
    createdAt: now,
    updatedAt: now,
  };
  await deps.uow.profiles.save(profile);
  return profile;
}

/** The caller's personal profiles + all global profiles; query narrows. */
export async function listProfiles(deps: ServiceDeps, principal: Principal): Promise<Profile[]> {
  const [personal, global] = await Promise.all([
    deps.uow.profiles.list({ scope: 'personal', ownerId: principal.userId }),
    deps.uow.profiles.list({ scope: 'global' }),
  ]);
  return [...personal, ...global];
}

export async function getProfile(
  deps: ServiceDeps,
  principal: Principal,
  id: string,
): Promise<Profile> {
  const profile = await deps.uow.profiles.findById(id);
  if (!profile || !visibleTo(profile, principal.userId)) {
    throw new AppError('Profile not found', 404, 'PROFILE_NOT_FOUND');
  }
  return profile;
}

export async function updateProfile(
  deps: ServiceDeps,
  principal: Principal,
  id: string,
  input: UpdateProfileInput,
  /**
   * The raw (pre-zod) request body. `target` is immutable post-create
   * (Phase 3.2); updateProfileSchema omits it, so zod strips it from
   * `input` — the raw body is inspected to give the explicit 409
   * TARGET_IMMUTABLE code instead of silently ignoring the key.
   */
  rawBody?: unknown,
): Promise<Profile> {
  if (rawBody && typeof rawBody === 'object' && 'target' in rawBody) {
    throw new AppError('Profile target is immutable', 409, 'TARGET_IMMUTABLE');
  }
  const existing = await deps.uow.profiles.findById(id);
  if (!existing || !canManage(existing, principal.userId, principal.role)) {
    throw new AppError('Profile not found', 404, 'PROFILE_NOT_FOUND');
  }

  const entries =
    input.entries !== undefined
      ? await resolveEntries(deps, input.entries, principal.userId)
      : existing.entries;

  // Auto-version (#18): bump ONLY when the entries actually changed — the
  // bump is the Claude Code marketplace publish switch, and name/description
  // edits shouldn't trigger pointless reinstall rounds on machines.
  const entriesChanged =
    JSON.stringify(entries) !== JSON.stringify(existing.entries as ProfileEntry[]);

  const next: Profile = {
    ...existing,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(entriesChanged ? { version: bumpProfileVersion(existing.version) } : {}),
    entries,
    updatedAt: new Date().toISOString(),
  };
  await deps.uow.profiles.save(next);
  return next;
}

export async function deleteProfile(
  deps: ServiceDeps,
  principal: Principal,
  id: string,
): Promise<void> {
  const existing = await deps.uow.profiles.findById(id);
  if (!existing || !canManage(existing, principal.userId, principal.role)) {
    throw new AppError('Profile not found', 404, 'PROFILE_NOT_FOUND');
  }
  await deps.uow.profiles.delete(existing.id);
}

/**
 * Resolve input entries into domain ProfileEntry records, validating that
 * every referenced artifact is visible to the caller:
 *  - `{ mcpServerId }` (Phase 2.2) → kind 'mcp', resourceId = McpServer.id.
 *  - `{ resourceId, kind }` (Phase 3.5) → a Resource reference; 'mcp' is not
 *    accepted here (MCP servers enter via the mcpServerId arm).
 */
async function resolveEntries(
  deps: ServiceDeps,
  entries: ProfileEntryInput[],
  userId: string,
): Promise<ProfileEntry[]> {
  const out: ProfileEntry[] = [];
  for (const e of entries) {
    if ('mcpServerId' in e) {
      const server = await deps.uow.mcpServers.findById(e.mcpServerId);
      if (!server || server.deletedAt !== undefined || !serverVisible(server, userId)) {
        throw new AppError(
          `MCP server ${e.mcpServerId} not found or not accessible`,
          409,
          'ENTRY_TARGET_NOT_ACCESSIBLE',
        );
      }
      out.push({
        resourceId: e.mcpServerId,
        kind: 'mcp',
        ...(e.pinnedVersion ? { pinnedVersion: e.pinnedVersion } : {}),
      });
      continue;
    }
    const resource = await deps.uow.resources.findById(e.resourceId);
    if (
      !resource ||
      resource.deletedAt !== undefined ||
      resource.kind !== e.kind ||
      !(resource.scope === 'global' || resource.ownerId === userId)
    ) {
      throw new AppError(
        `Resource ${e.resourceId} not found or not accessible`,
        409,
        'ENTRY_TARGET_NOT_ACCESSIBLE',
      );
    }
    out.push({
      resourceId: e.resourceId,
      kind: e.kind,
      ...(e.pinnedVersion ? { pinnedVersion: e.pinnedVersion } : {}),
      ...(e.installOptions ? { installOptions: e.installOptions } : {}),
    });
  }
  return out;
}

/** A profile is visible to a user iff global or personal + owned (#36). */
function visibleTo(p: Profile, userId: string): boolean {
  return p.scope === 'global' || p.ownerId === userId;
}

/** A profile is manageable iff owner (personal) or admin on a global row (#36). */
function canManage(p: Profile, userId: string, role: 'admin' | 'user'): boolean {
  return p.scope === 'global' ? role === 'admin' : p.ownerId === userId;
}

/** An MCP server is visible iff global or personal + owned (#36). */
function serverVisible(
  s: { scope: 'global' | 'personal'; ownerId: string | null },
  userId: string,
): boolean {
  return s.scope === 'global' || s.ownerId === userId;
}
