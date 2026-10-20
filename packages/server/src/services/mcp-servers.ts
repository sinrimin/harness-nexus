// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { DialSite, McpServer, McpTransport } from '@harness-nexus/core';
import {
  AppError,
  requiresClient,
  resolveDialSite,
  transportPlaceholderNames,
  type CreateMcpServerInput,
  type UpdateMcpServerInput,
} from '@harness-nexus/shared';
import { generateId } from '../infra/crypto.js';
import type { Principal, ServiceDeps } from './principal.js';

/**
 * MCP server domain service (#53 slice 8) — records of MCP servers, each with
 * a `dialSite` (Phase 8 C2, replacing the 3.1 proxy/direct `mode`):
 *   server — the platform dials the upstream and serves it via the `/mcp`
 *            outlet (the only home for non-distributable credentials, and for
 *            upstreams only the platform's network reaches). Pooled.
 *   client — the `hnx mcp serve` shim dials it on the user's machine
 *            (stdio / SSE / HTTP; localhost + LAN reachable). Requires every
 *            referenced credential to be distributable.
 *   auto   — derived: client iff all referenced credentials are distributable
 *            (or none), else server. See `shared/dial-site.ts`.
 * stdio can only be dialed client-side — the platform never spawns processes
 * on the user's machine — enforced as 409 STDIO_REQUIRES_CLIENT here.
 *
 * Scope rules (see wiki design-phase-2.1-credentials.md) are identical to credentials:
 *   global   — any authenticated user can read; admin only to create/update/delete.
 *   personal — owner only for all operations.
 *
 * The service decides + persists; the McpRegistry interplay (pool reload
 * after mutations, connect/disconnect/tools) stays at the route (#53
 * residue) — the route pokes the registry with the facts returned here.
 */

export async function createMcpServer(
  deps: ServiceDeps,
  principal: Principal,
  input: CreateMcpServerInput,
): Promise<McpServer> {
  if (input.scope === 'global' && principal.role !== 'admin') {
    throw new AppError('Only admins can create global MCP servers', 403, 'FORBIDDEN');
  }
  // zod-inferred transport carries `| undefined` on optional fields; the domain
  // McpTransport does not (exactOptionalPropertyTypes). The shapes are identical
  // at runtime, so cast at this validated boundary.
  const transport = input.transport as McpTransport;
  await assertDialSite(deps, transport, input.dialSite);

  const now = new Date().toISOString();
  const server: McpServer = {
    id: generateId(),
    name: input.name,
    transport,
    dialSite: input.dialSite,
    scope: input.scope,
    ownerId: input.scope === 'global' ? null : principal.userId,
    createdAt: now,
    updatedAt: now,
  };
  await deps.uow.mcpServers.save(server);
  return server;
}

export interface McpServerListQuery {
  /** `true` also returns soft-deleted rows (the profile editor greys them out;
   *  management pages use the default view). */
  includeDeleted?: boolean;
}

/** The caller's personal servers + all global servers; query narrows. */
export async function listMcpServers(
  deps: ServiceDeps,
  principal: Principal,
  q: McpServerListQuery = {},
): Promise<McpServer[]> {
  const [personal, global] = await Promise.all([
    deps.uow.mcpServers.list({
      scope: 'personal',
      ownerId: principal.userId,
      includeDeleted: q.includeDeleted ?? false,
    }),
    deps.uow.mcpServers.list({ scope: 'global', includeDeleted: q.includeDeleted ?? false }),
  ]);
  return [...personal, ...global];
}

export async function updateMcpServer(
  deps: ServiceDeps,
  principal: Principal,
  id: string,
  input: UpdateMcpServerInput,
): Promise<McpServer> {
  const existing = await deps.uow.mcpServers.findById(id);
  if (!existing || !canManage(existing, principal.userId, principal.role)) {
    throw new AppError('MCP server not found', 404, 'MCP_SERVER_NOT_FOUND');
  }

  const transport = (input.transport ?? existing.transport) as McpTransport;
  const dialSite: DialSite = input.dialSite ?? existing.dialSite;
  await assertDialSite(deps, transport, dialSite);

  const next: McpServer = {
    ...existing,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.transport !== undefined ? { transport } : {}),
    ...(input.dialSite !== undefined ? { dialSite } : {}),
    updatedAt: new Date().toISOString(),
  };
  await deps.uow.mcpServers.save(next);
  return next;
}

/**
 * Two-stage delete (2026-09): the first DELETE soft-deletes (the row leaves
 * lists and the pool, profile editors grey it and strip it on save, deploy
 * paths skip it); a second physically removes it — but only once no profile
 * references it anymore.
 */
export async function deleteMcpServer(
  deps: ServiceDeps,
  principal: Principal,
  id: string,
): Promise<{ mode: 'soft' | 'hard' }> {
  const existing = await deps.uow.mcpServers.findById(id);
  if (!existing || !canManage(existing, principal.userId, principal.role)) {
    throw new AppError('MCP server not found', 404, 'MCP_SERVER_NOT_FOUND');
  }
  if (existing.deletedAt === undefined) {
    const now = new Date().toISOString();
    await deps.uow.mcpServers.save({ ...existing, deletedAt: now, updatedAt: now });
    return { mode: 'soft' };
  }
  const refs = (await deps.uow.profiles.listAll()).filter((p) =>
    p.entries.some((e) => e.resourceId === existing.id),
  );
  if (refs.length > 0) {
    throw new AppError(
      `Still referenced by profile(s): ${refs.map((r) => r.name).join(', ')} — save those profiles (soft-deleted entries are stripped automatically) and delete again`,
      409,
      'ASSET_STILL_REFERENCED',
    );
  }
  await deps.uow.mcpServers.delete(existing.id);
  return { mode: 'hard' };
}

/**
 * Phase 2.4 — guard for the connect/disconnect/tools routes. Reads the stored
 * record (NOT the pool entry) and applies canManage + dial-site checks
 * BEFORE the route touches the registry: a not-found/not-manageable server
 * returns 404 MCP_SERVER_NOT_FOUND (leak prevention, identical to
 * PATCH/DELETE), and a client-dialed server returns 409 NOT_SERVER_DIALED
 * (the platform never dials it — that is the shim's job).
 */
export async function assertServerDialedOwned(
  deps: ServiceDeps,
  principal: Principal,
  id: string,
): Promise<void> {
  const existing = await deps.uow.mcpServers.findById(id);
  if (!existing || !canManage(existing, principal.userId, principal.role)) {
    throw new AppError('MCP server not found', 404, 'MCP_SERVER_NOT_FOUND');
  }
  const distributable = new Map<string, boolean>();
  for (const cred of await deps.uow.credentials.list()) {
    if (!distributable.has(cred.name)) distributable.set(cred.name, cred.distributable);
  }
  const site = resolveDialSite(existing, (name) => distributable.get(name) === true);
  if (site !== 'server') {
    throw new AppError(
      `MCP server "${existing.name}" is dialed by the client, not the platform (dial site: ${site})`,
      409,
      'NOT_SERVER_DIALED',
    );
  }
}

/**
 * The caller-visible server ids (#21: names + upstream error details are
 * tenant data; #36: that is the own-personal + global set for every role,
 * admins included) — the row-set half of GET /api/mcp-servers/status, kept
 * here so the route can intersect it with the registry's live statuses.
 */
export async function visibleMcpServerIds(
  deps: ServiceDeps,
  principal: Principal,
): Promise<Set<string>> {
  const rows = await deps.uow.mcpServers.list();
  return new Set(
    rows.filter((s) => s.scope === 'global' || s.ownerId === principal.userId).map((s) => s.id),
  );
}

/**
 * Enforce the dial-site rules at create/update (Phase 8 C2):
 *   1. stdio can only be dialed client-side — the platform never spawns a
 *      process on the user's machine. A stdio transport that would resolve to
 *      `server` (explicit override, or auto + non-distributable credential)
 *      is rejected with 409 STDIO_REQUIRES_CLIENT.
 *   2. An explicit `client` dial site must not reference a stored,
 *      non-distributable credential — the server would have to ship a secret
 *      it must not ship (409 CREDENTIAL_NOT_DISTRIBUTABLE). `auto` handles the
 *      same situation by silently routing to `server`; that is the derived
 *      default doing its job. Credentials not created yet are not checked
 *      (same as 2.1: a missing credential surfaces as a dial failure later).
 */
async function assertDialSite(
  deps: ServiceDeps,
  transport: McpTransport,
  dialSite: DialSite,
): Promise<void> {
  const distributable = new Map<string, boolean>();
  for (const cred of await deps.uow.credentials.list()) {
    if (!distributable.has(cred.name)) distributable.set(cred.name, cred.distributable);
  }
  const isDistributable = (name: string): boolean => distributable.get(name) === true;

  const resolved = resolveDialSite({ dialSite, transport }, isDistributable);
  if (requiresClient(transport) && resolved === 'server') {
    throw new AppError(
      'stdio upstreams can only be dialed by the client (mark the referenced credential distributable or use dialSite "client")',
      409,
      'STDIO_REQUIRES_CLIENT',
    );
  }
  if (dialSite === 'client') {
    const referenced = transportPlaceholderNames(transport).filter((n) => distributable.has(n));
    const offender = referenced.find((n) => !isDistributable(n));
    if (offender !== undefined) {
      throw new AppError(
        `dialSite "client" requires credential "${offender}" to be distributable (its plaintext would have to leave the server)`,
        409,
        'CREDENTIAL_NOT_DISTRIBUTABLE',
      );
    }
  }
}

/**
 * A record is manageable by the caller iff they own it (personal) or it is a
 * global row and they are admin — #36: admins curate the global library, they
 * are not overseers of personal rows.
 */
function canManage(s: McpServer, userId: string, role: 'admin' | 'user'): boolean {
  return s.scope === 'global' ? role === 'admin' : s.ownerId === userId;
}
