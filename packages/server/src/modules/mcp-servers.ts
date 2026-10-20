// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { FastifyInstance } from 'fastify';
import {
  AppError,
  createMcpServerSchema,
  updateMcpServerSchema,
  type CreateMcpServerInput,
  type McpToolInfo,
  type UpdateMcpServerInput,
} from '@harness-nexus/shared';
import { principalOf } from './principal.js';
import { RegistryError } from '../mcp/registry.js';
import {
  assertServerDialedOwned,
  createMcpServer,
  deleteMcpServer,
  listMcpServers,
  updateMcpServer,
  visibleMcpServerIds,
} from '../services/mcp-servers.js';

/**
 * MCP management routes — thin HTTP adapters over the domain service
 * (`services/mcp-servers.ts`, #53 slice 8): the service decides + persists,
 * these handlers authenticate, parse, and poke the McpRegistry (the pool of
 * live upstream connections). Every registry interaction is #53 residue —
 * dialing upstreams is a realtime side effect, not a domain decision:
 *   - mutations reload the pool (`void reload()`), fire-and-forget;
 *   - connect/disconnect/tools(+/refresh) operate the live connection.
 */
export async function mcpServersRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth] };
  const deps = () => ({ uow: app.uow });

  // ---- POST /api/mcp-servers ----
  app.post('/api/mcp-servers', guard, async (req, reply) => {
    const input = createMcpServerSchema.parse(req.body) as CreateMcpServerInput;
    const mcpServer = await createMcpServer(deps(), principalOf(req), input);
    // #53 residue: reload the registry pool — dialing upstreams is a realtime
    // side effect; the service returned the persisted row for it to pick up.
    void app.mcpRegistry?.reload();
    return reply.code(201).send({ mcpServer });
  });

  // ---- GET /api/mcp-servers ----
  // `?includeDeleted=1` also returns soft-deleted rows (the profile editor
  // greys them out; management pages use the default view).
  app.get('/api/mcp-servers', guard, async (req) => {
    const includeDeleted = (req.query as { includeDeleted?: string }).includeDeleted === '1';
    const mcpServers = await listMcpServers(deps(), principalOf(req), { includeDeleted });
    return { mcpServers };
  });

  // ---- GET /api/mcp-servers/status ----
  // Live connection states from the registry. Drives the Dashboard mesh dots
  // and the per-row status/tool-count badges (Phase 2.4). The pool spans
  // every tenant's server-dialed rows — the visible id set comes from the
  // service (#21/#36); the live statuses are registry truth.
  app.get('/api/mcp-servers/status', guard, async (req) => {
    // #53 residue: registry read — the pool's live states are realtime truth.
    const statuses = app.mcpRegistry?.getStatuses() ?? [];
    const visible = await visibleMcpServerIds(deps(), principalOf(req));
    return { statuses: statuses.filter((s) => visible.has(s.id)) };
  });

  // ---- Phase 2.4: per-server connect/disconnect + tool inspection ----
  // Operator control surface on top of the registry pool. proxy-only — a direct
  // server is never dialed by Harness Nexus, so these endpoints reject it with
  // 409 NOT_PROXY_MODE. The canManage check (404 on miss, leak prevention)
  // lives in the service's assertServerDialedOwned.

  // POST /api/mcp-servers/:id/connect — force (re)connect one proxy upstream.
  app.post<{ Params: { id: string } }>('/api/mcp-servers/:id/connect', guard, async (req) => {
    await assertServerDialedOwned(deps(), principalOf(req), req.params.id);
    // #53 residue: the registry dials the upstream (realtime side effect).
    try {
      const status = await app.mcpRegistry!.connectServer(req.params.id);
      return { status };
    } catch (e) {
      throw mapRegistryError(e);
    }
  });

  // POST /api/mcp-servers/:id/disconnect — drop a live connection on demand.
  app.post<{ Params: { id: string } }>('/api/mcp-servers/:id/disconnect', guard, async (req) => {
    await assertServerDialedOwned(deps(), principalOf(req), req.params.id);
    // #53 residue: the registry drops the live connection.
    try {
      const status = await app.mcpRegistry!.disconnectServer(req.params.id);
      return { status };
    } catch (e) {
      throw mapRegistryError(e);
    }
  });

  // GET /api/mcp-servers/:id/tools — cached tool list (original names).
  // Not connected → [] (not an error); the UI gates the panel on status.
  app.get<{ Params: { id: string } }>('/api/mcp-servers/:id/tools', guard, async (req) => {
    await assertServerDialedOwned(deps(), principalOf(req), req.params.id);
    // #53 residue: cached tools are registry (live connection) truth.
    try {
      const tools = app.mcpRegistry!.listServerTools(req.params.id);
      return { tools };
    } catch (e) {
      throw mapRegistryError(e);
    }
  });

  // POST /api/mcp-servers/:id/tools/refresh — re-pull tools from the upstream.
  app.post<{ Params: { id: string } }>('/api/mcp-servers/:id/tools/refresh', guard, async (req) => {
    await assertServerDialedOwned(deps(), principalOf(req), req.params.id);
    // #53 residue: the registry re-dials the upstream to list tools.
    try {
      const tools: McpToolInfo[] = await app.mcpRegistry!.refreshServerTools(req.params.id);
      return { tools };
    } catch (e) {
      throw mapRegistryError(e);
    }
  });

  // ---- PATCH /api/mcp-servers/:id ----
  app.patch<{ Params: { id: string } }>('/api/mcp-servers/:id', guard, async (req) => {
    const input = updateMcpServerSchema.parse(req.body) as UpdateMcpServerInput;
    const mcpServer = await updateMcpServer(deps(), principalOf(req), req.params.id, input);
    // #53 residue: reload the registry pool after the persisted change.
    void app.mcpRegistry?.reload();
    return { mcpServer };
  });

  // ---- DELETE /api/mcp-servers/:id — two-stage ----
  // First call soft-deletes: the row leaves lists and the pool, profile
  // editors grey it and strip it on save, deploy paths skip it. A second call
  // physically removes it — but only once no profile references it anymore.
  app.delete<{ Params: { id: string } }>('/api/mcp-servers/:id', guard, async (req) => {
    const { mode } = await deleteMcpServer(deps(), principalOf(req), req.params.id);
    // #53 residue: reload the registry pool after soft-hide or hard-remove.
    void app.mcpRegistry?.reload();
    return { ok: true, mode };
  });
}

/**
 * Map a registry `RegistryError` to an `AppError` with the right status code.
 * Rethrows non-registry errors untouched. Keeps the HTTP layer in the route and
 * the registry free of HTTP concerns (AGENTS.md architecture rule #4).
 */
function mapRegistryError(err: unknown): never {
  if (err instanceof RegistryError) {
    const status = err.kind === 'not_dialable' ? 409 : err.kind === 'not_connected' ? 409 : 404;
    const code =
      err.kind === 'not_dialable'
        ? 'NOT_SERVER_DIALED'
        : err.kind === 'not_connected'
          ? 'NOT_CONNECTED'
          : 'MCP_SERVER_NOT_FOUND';
    throw new AppError(err.message, status, code);
  }
  throw err;
}
