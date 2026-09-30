/**
 * MCP proxy layer — Pillar #1 (Phase 2.2).
 *
 * Mounts the aggregated MCP server surface that Agent tools connect to. Two
 * transports are exposed off the same `McpRegistry`:
 *   - Streamable HTTP  → POST/GET /mcp
 *   - SSE (legacy)     → GET /mcp/sse + POST /mcp/sse/messages
 *
 * Auth: a PAT (Bearer hnpat_…) is required, resolved into `req.user` by the
 * root auth hook — EXCEPT machine-ctl PATs, which the root hook nulls but the
 * gate below accepts for the `hnx mcp serve` shim (#7, mirroring the 3.5
 * emitter). The `?profile=<id>` query param selects which profile's MCP
 * server entries are exposed (explicit profile routing — see wiki design-phase-2.2-registry.md).
 *
 * This file is the transport mount point only; aggregation lives in
 * `./registry.ts`. It is intentionally decoupled from the REST routes.
 */
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { randomUUID } from 'node:crypto';
import { AppError } from '@harness-nexus/shared';
import { McpRegistry } from './registry.js';
import { hashToken, PAT_PREFIX } from '../infra/crypto.js';

/** Session entry: one low-level server + its transport, per Agent-tool connection. */
interface Session {
  server: Server;
  transport: StreamableHTTPServerTransport | SSEServerTransport;
  /** Creator identity (#21): a session only serves the user who opened it. */
  userId: string;
  /** Idle-eviction deadline, extended on every touch (#21). */
  lastUsedAt: number;
}

/**
 * #21 — the session maps are process-lifetime state; without bounds an
 * authenticated caller mints unlimited sessions (memory/CPU). Cap concurrent
 * sessions per user and evict idle ones on every request.
 */
const MAX_SESSIONS_PER_USER = 16;
const SESSION_IDLE_TTL_MS = 30 * 60 * 1000;

function sweepExpired(map: Map<string, Session>, log: FastifyBaseLogger): void {
  const now = Date.now();
  for (const [id, s] of map) {
    if (now - s.lastUsedAt > SESSION_IDLE_TTL_MS) {
      map.delete(id);
      void s.server.close().catch(() => {});
      log.debug({ sessionId: id }, 'mcp outlet: evicted idle session');
    }
  }
}

/** Enforce the per-user cap by closing the caller's oldest session. */
function capSessionsForUser(
  map: Map<string, Session>,
  userId: string,
  log: FastifyBaseLogger,
): void {
  const owned = [...map.entries()].filter(([, s]) => s.userId === userId);
  if (owned.length < MAX_SESSIONS_PER_USER) return;
  owned.sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
  const evict = owned.slice(0, owned.length - MAX_SESSIONS_PER_USER + 1);
  for (const [id, s] of evict) {
    map.delete(id);
    void s.server.close().catch(() => {});
    log.info({ sessionId: id, userId }, 'mcp outlet: capped user session count');
  }
}

/** Request-scoped: the resolved upstream server ids for the chosen profile. */
interface ResolvedProfileRequest {
  resolvedServerIds: string[];
}

export async function mountMcpProxy(app: FastifyInstance): Promise<void> {
  const registry = new McpRegistry({
    uow: app.uow,
    encryptionKey: app.credentialEncryptionKey,
    logger: app.log,
  });
  app.decorate('mcpRegistry', registry);
  await registry.reload();

  const streamableSessions = new Map<string, Session>();
  const sseSessions = new Map<string, Session>();

  // ---- auth + profile preHandler (shared by both mounts) ----
  const gate = async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!req.user) {
      // #7: `hnx mcp serve` dials this outlet with its ENROLLED machine's PAT
      // — the emitter's .mcp.json carries no user PAT by design (8 C2), and
      // the root auth hook nulls machine-ctl tokens (REST blast radius).
      // Accept them HERE, resolving the machine's OWNER; the profile check
      // below still applies. A machine token already controls that machine
      // over /ctl — consuming the owner's VISIBLE profiles is strictly weaker.
      const owner = await resolveMachineTokenUser(req);
      if (owner) req.user = owner;
    }
    if (!req.user) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }
    const profileId = (req.query as { profile?: string }).profile;
    if (!profileId) {
      throw new AppError('A profile query parameter is required', 400, 'PROFILE_REQUIRED');
    }
    try {
      const { serverIds } = await registry.profileEntriesFor(profileId, req.user.id);
      (req as FastifyRequest & ResolvedProfileRequest).resolvedServerIds = serverIds;
    } catch {
      throw new AppError(
        'Profile not found or references inaccessible MCP servers',
        403,
        'PROFILE_ENTRY_NOT_ACCESSIBLE',
      );
    }
  };

  /**
   * Resolve a Bearer machine-ctl PAT into the machine OWNER's `{id, role}` —
   * the outlet-only exception mirroring the 3.5 emitter's token acceptance.
   * Returns null for anything else (the caller falls through to 401).
   */
  async function resolveMachineTokenUser(
    req: FastifyRequest,
  ): Promise<{ id: string; role: 'admin' | 'user' } | null> {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
    const raw = header.slice('Bearer '.length).trim();
    if (!raw.startsWith(PAT_PREFIX)) return null;
    const record = await app.uow.tokens.findByTokenHash(hashToken(raw));
    if (!record || !record.scopes.includes('machine-ctl')) return null;
    if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) return null;
    const user = await app.uow.users.findById(record.userId);
    if (!user || user.status !== 'active') return null;
    void app.uow.tokens.touchLastUsed(record.id, new Date().toISOString());
    return { id: user.id, role: user.role };
  }

  // ===================== Streamable HTTP: /mcp =====================
  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    preHandler: [gate],
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      sweepExpired(streamableSessions, app.log);
      const sessionId = (req.headers['mcp-session-id'] as string | undefined) ?? randomUUID();
      let session = streamableSessions.get(sessionId);
      if (session) {
        // #21: a session serves only the user who opened it — a leaked or
        // guessed session id is worthless to anyone else.
        if (session.userId !== req.user!.id) {
          throw new AppError('Unknown or expired session', 404, 'SESSION_NOT_FOUND');
        }
        session.lastUsedAt = Date.now();
      } else {
        capSessionsForUser(streamableSessions, req.user!.id, app.log);
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => sessionId,
        });
        session = await buildSession(
          registry,
          transport,
          (req as FastifyRequest & ResolvedProfileRequest).resolvedServerIds,
          req.user!.id,
        );
        streamableSessions.set(sessionId, session);
        transport.onclose = () => {
          streamableSessions.delete(sessionId);
        };
      }
      // Hand the raw Node streams to the SDK transport; Fastify must not send
      // its own response, so hijack the reply.
      reply.hijack();
      if (session.transport instanceof StreamableHTTPServerTransport) {
        await session.transport.handleRequest(req.raw, reply.raw, req.body);
      }
    },
  });

  // ===================== SSE: /mcp/sse =============================
  // Legacy SSE transport: GET opens the stream, POST /messages sends commands.
  app.route({
    method: ['GET'],
    url: '/mcp/sse',
    preHandler: [gate],
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      sweepExpired(sseSessions, app.log);
      capSessionsForUser(sseSessions, req.user!.id, app.log);
      const sessionId = randomUUID();
      reply.hijack();
      const transport = new SSEServerTransport('/mcp/sse/messages', reply.raw);
      const session = await buildSession(
        registry,
        transport,
        (req as FastifyRequest & ResolvedProfileRequest).resolvedServerIds,
        req.user!.id,
      );
      sseSessions.set(sessionId, session);
      await transport.start();
    },
  });

  app.route({
    method: ['POST'],
    url: '/mcp/sse/messages',
    preHandler: [gate],
    handler: async (req: FastifyRequest, reply: FastifyReply) => {
      const sessionId = (req.query as { sessionId?: string }).sessionId ?? '';
      const session = sseSessions.get(sessionId);
      if (!session || !(session.transport instanceof SSEServerTransport)) {
        throw new AppError('Unknown or expired SSE session', 400, 'SESSION_NOT_FOUND');
      }
      // #21: session ids only work for their creator.
      if (session.userId !== req.user!.id) {
        throw new AppError('Unknown or expired SSE session', 400, 'SESSION_NOT_FOUND');
      }
      session.lastUsedAt = Date.now();
      reply.hijack();
      await session.transport.handlePostMessage(req.raw, reply.raw, req.body);
    },
  });

  // Clean up all pooled connections when the app closes.
  app.addHook('onClose', async () => {
    await Promise.all([
      ...[...streamableSessions.values()].map((s) => s.server.close().catch(() => {})),
      ...[...sseSessions.values()].map((s) => s.server.close().catch(() => {})),
      registry.shutdown(),
    ]);
  });

  app.log.info('MCP proxy mounted: /mcp (Streamable HTTP) + /mcp/sse (SSE)');
}

/**
 * Build a per-session SDK server wired to a transport, registering every
 * aggregated tool (filtered to the profile's MCP entries) with a forwarding
 * callback. Returns once the server has connected to the transport.
 */
async function buildSession(
  registry: McpRegistry,
  transport: StreamableHTTPServerTransport | SSEServerTransport,
  serverIds: string[],
  userId: string,
): Promise<Session> {
  // Low-level `Server` (not `McpServer`): `registerTool`'s config takes a
  // ZOD shape, and mapping the upstream's raw JSON schema through zod drops
  // it — tools went out with `properties: {}`, so callers passed no
  // arguments and every call failed upstream validation (#7, rig-found).
  // The request handlers pass the aggregated tools through verbatim, the
  // same pattern the `hnx mcp serve` shim uses.
  const server = new Server(
    { name: 'harness-nexus', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  const filter = serverIds.length ? serverIds : undefined;
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: registry.listTools(filter).map((t) => ({
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      inputSchema: t.inputSchema,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = await registry.callTool(
      req.params.name,
      (req.params.arguments ?? undefined) as Record<string, unknown> | undefined,
    );
    // The registry returns the upstream's raw CallToolResult; pass it through.
    return result as CallToolResult;
  });
  await server.connect(transport as Parameters<Server['connect']>[0]);
  return { server, transport, userId, lastUsedAt: Date.now() };
}

// ---- Fastify type augmentation for the decorated registry ----
declare module 'fastify' {
  interface FastifyInstance {
    mcpRegistry: McpRegistry;
  }
}
