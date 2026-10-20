// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * @harness-nexus/mcp-runtime — the transport-facing MCP upstream pool
 * (Phase 8 C2, extracted from the server's 2.2 `McpRegistry`).
 *
 * Given upstream definitions with ALREADY-RESOLVED transports (placeholder
 * substitution is the caller's concern — the server resolves via its encrypted
 * store, the shim receives resolved values from the client-config API), the
 * pool dials each upstream (SSE / Streamable HTTP / stdio), aggregates tools
 * under a namespaced key, and routes calls back. Used by BOTH the server's
 * `/mcp` outlet and the `hnx mcp serve` stdio shim — one aggregation
 * implementation, two deployment shapes.
 *
 * Design notes carried over from 2.2:
 *   - Best-effort: an unreachable upstream is marked `error` and skipped; it
 *     never blocks startup or tool listing for the others.
 *   - Namespacing: tools surface as `<server-name>__<tool-name>`; `callTool`
 *     splits the namespace and routes. A `namespaced: true` upstream (the
 *     platform `/mcp` outlet) already namespaces its tools — they pass through
 *     verbatim and are forwarded under their full name.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import type { McpToolInfo } from '@harness-nexus/shared';

/** Separator between server-name and tool-name in the aggregated namespace. */
export const NAMESPACE_SEP = '__';

export type ConnectionStatus = 'connecting' | 'connected' | 'error' | 'disconnected';

export interface McpServerStatus {
  id: string;
  name: string;
  status: ConnectionStatus;
  /** Human-readable detail for the `error` state; absent otherwise. */
  detail?: string;
  /** Cached tool count for this connection (0 when not connected). */
  toolCount: number;
}

/** Minimal tool shape surfaced to callers (a subset of the SDK's Tool). */
export interface AggregatedTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/** Minimal pino-compatible logger subset — no framework imports here. */
export interface PoolLogger {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  debug(obj: object, msg: string): void;
}

/**
 * Pool-local error kinds, mapped to HTTP by the server route layer. Kept free
 * of AppError/HTTP concerns (architecture rule #4).
 */
export type RegistryErrorKind = 'not_found' | 'not_dialable' | 'not_connected';

export class RegistryError extends Error {
  constructor(
    message: string,
    readonly kind: RegistryErrorKind,
  ) {
    super(message);
    this.name = 'RegistryError';
  }
}

/** A transport with every `${cred:NAME}` placeholder already substituted. */
export type ResolvedTransport =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> }
  | { type: 'streamable-http'; url: string; headers?: Record<string, string> };

/** One dialable upstream. `id` is the caller's stable key (McpServer.id, …). */
export interface UpstreamDefinition {
  id: string;
  name: string;
  transport: ResolvedTransport;
  /**
   * The upstream's tools are ALREADY namespaced (the platform `/mcp` outlet
   * aggregates `<server>__<tool>` server-side). Tools pass through verbatim —
   * no re-namespacing, no double prefix.
   */
  namespaced?: boolean;
}

interface LiveConnection {
  def: UpstreamDefinition;
  client: Client;
  status: ConnectionStatus;
  detail?: string;
  /** Raw tools from the upstream, keyed by their (passthrough: full) name. */
  tools: Map<string, AggregatedTool>;
}

function sameDefinition(a: UpstreamDefinition, b: UpstreamDefinition): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.namespaced === b.namespaced &&
    JSON.stringify(a.transport) === JSON.stringify(b.transport)
  );
}

/** Collapse a server name to a stable namespace segment. */
export function sanitizeNamespace(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
}

/** Split `<server>__<tool>` on the FIRST separator. */
export function splitNamespace(namespaced: string): [string, string] {
  const idx = namespaced.indexOf(NAMESPACE_SEP);
  if (idx === -1) return [namespaced, ''];
  return [namespaced.slice(0, idx), namespaced.slice(idx + NAMESPACE_SEP.length)];
}

export interface UpstreamPoolOptions {
  logger: PoolLogger;
  /** Client identity advertised to upstreams. */
  clientName?: string;
  clientVersion?: string;
}

/**
 * The upstream pool. Construct, then `sync(definitions)` to reconcile which
 * upstreams should be live; query with `listTools`/`callTool`/`statuses`.
 * Concurrent `sync` runs share one in-flight promise (reload-storm guard).
 */
export class UpstreamPool {
  private readonly log: PoolLogger;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private readonly pool = new Map<string, LiveConnection>();
  private syncPromise: Promise<void> | null = null;

  constructor(opts: UpstreamPoolOptions) {
    this.log = opts.logger;
    this.clientName = opts.clientName ?? 'harness-nexus';
    this.clientVersion = opts.clientVersion ?? '0.1.0';
  }

  /**
   * Reconcile the pool against `definitions`: connect new upstreams, close
   * removed ones, reconnect changed ones. Safe to call repeatedly.
   */
  sync(definitions: UpstreamDefinition[]): Promise<void> {
    if (this.syncPromise) return this.syncPromise;
    this.syncPromise = this.doSync(definitions).finally(() => {
      this.syncPromise = null;
    });
    return this.syncPromise;
  }

  private async doSync(definitions: UpstreamDefinition[]): Promise<void> {
    const byId = new Map(definitions.map((d) => [d.id, d]));

    for (const [id, conn] of this.pool) {
      if (!byId.has(id)) {
        await this.closeConnection(conn);
        this.pool.delete(id);
      }
    }
    for (const def of definitions) {
      const existing = this.pool.get(def.id);
      if (existing && sameDefinition(existing.def, def)) continue;
      if (existing) {
        await this.closeConnection(existing);
        this.pool.delete(def.id);
      }
      void this.connectOne(def);
    }
  }

  /** Establish a single upstream connection (best-effort, non-throwing). */
  private async connectOne(def: UpstreamDefinition): Promise<void> {
    const client = new Client(
      { name: this.clientName, version: this.clientVersion },
      {
        capabilities: {},
      },
    );
    const conn: LiveConnection = { def, client, status: 'connecting', tools: new Map() };
    this.pool.set(def.id, conn);

    try {
      const transport = makeClientTransport(def.transport);
      // Cast mirrors the pre-extraction registry: the SDK's connect() param
      // type is stricter than the concrete transports union under
      // exactOptionalPropertyTypes.
      await client.connect(transport as Parameters<Client['connect']>[0]);
      // Cache tools BEFORE flipping to 'connected': settle() waits for the
      // last 'connecting' to clear, and consumers (the shim's serve loop)
      // snapshot the tool list the moment settle returns — flipping early
      // lets them race an in-flight tools refresh and serve 0 tools (#7).
      await this.refreshTools(conn);
      if (conn.status === 'error') return; // refreshTools logged it
      conn.status = 'connected';
      this.log.info({ name: def.name }, 'upstream MCP connected');
    } catch (err) {
      conn.status = 'error';
      conn.detail = err instanceof Error ? err.message : String(err);
      this.log.warn({ name: def.name }, 'upstream MCP connection failed');
    }
  }

  /** Fetch the upstream's tool list into the connection cache. */
  private async refreshTools(conn: LiveConnection): Promise<void> {
    try {
      const { tools } = await conn.client.listTools();
      conn.tools = new Map(
        tools.map((t) => [
          t.name,
          {
            name: t.name,
            ...(t.description ? { description: t.description } : {}),
            inputSchema: t.inputSchema as Record<string, unknown>,
          },
        ]),
      );
    } catch (err) {
      conn.status = 'error';
      conn.detail = err instanceof Error ? err.message : String(err);
      this.log.warn({ name: conn.def.name, err }, 'listing upstream tools failed');
    }
  }

  /**
   * List aggregated tools, optionally restricted to a subset of upstream ids.
   * Local upstreams namespace as `<name>__<tool>`; passthrough (`namespaced`)
   * upstreams contribute their tool names verbatim.
   */
  listTools(filterUpstreamIds?: string[]): AggregatedTool[] {
    const allow = filterUpstreamIds ? new Set(filterUpstreamIds) : null;
    const out: AggregatedTool[] = [];
    for (const conn of this.pool.values()) {
      if (conn.status !== 'connected') continue;
      if (allow && !allow.has(conn.def.id)) continue;
      const prefix = sanitizeNamespace(conn.def.name) + NAMESPACE_SEP;
      for (const tool of conn.tools.values()) {
        if (conn.def.namespaced) {
          out.push(tool);
          continue;
        }
        out.push({
          name: prefix + tool.name,
          ...(tool.description ? { description: `[${conn.def.name}] ${tool.description}` } : {}),
          inputSchema: tool.inputSchema,
        });
      }
    }
    return out;
  }

  /**
   * Call a tool by its exposed (namespaced or passthrough) name. Local lookup
   * first; if no local upstream owns the name, passthrough upstreams get the
   * full name forwarded verbatim (the outlet already namespaced it).
   */
  async callTool(exposedName: string, args?: Record<string, unknown>): Promise<unknown> {
    // Local namespaced lookup: `<server>__<tool>`.
    const [upstreamName, toolName] = splitNamespace(exposedName);
    if (toolName) {
      const target = sanitizeNamespace(upstreamName);
      for (const conn of this.pool.values()) {
        if (conn.def.namespaced || conn.status !== 'connected') continue;
        if (sanitizeNamespace(conn.def.name) !== target) continue;
        if (!conn.tools.has(toolName)) {
          throw new Error(`tool not found: ${toolName} on ${upstreamName}`);
        }
        return conn.client.callTool({ name: toolName, arguments: args });
      }
    }
    // Passthrough: the name IS the upstream's tool name (outlet aggregation).
    for (const conn of this.pool.values()) {
      if (!conn.def.namespaced || conn.status !== 'connected') continue;
      if (conn.tools.has(exposedName)) {
        return conn.client.callTool({ name: exposedName, arguments: args });
      }
    }
    throw new Error(`upstream not connected or tool unknown: ${exposedName}`);
  }

  /** Snapshot of every upstream's connection status (UI/API surface). */
  statuses(): McpServerStatus[] {
    return [...this.pool.values()].map((c) => ({
      id: c.def.id,
      name: c.def.name,
      status: c.status,
      toolCount: c.tools.size,
      ...(c.detail ? { detail: c.detail } : {}),
    }));
  }

  statusOf(id: string): McpServerStatus | null {
    const conn = this.pool.get(id);
    if (!conn) return null;
    return {
      id: conn.def.id,
      name: conn.def.name,
      status: conn.status,
      toolCount: conn.tools.size,
      ...(conn.detail ? { detail: conn.detail } : {}),
    };
  }

  /** Force (re)connect of one upstream by fresh definition (operator surface). */
  async connect(def: UpstreamDefinition): Promise<McpServerStatus> {
    const existing = this.pool.get(def.id);
    if (existing) {
      await this.closeConnection(existing);
      this.pool.delete(def.id);
    }
    await this.connectOne(def);
    return this.statusOf(def.id)!;
  }

  /** Drop a live connection but KEEP the pool entry as `disconnected`. */
  async disconnect(id: string): Promise<McpServerStatus> {
    const conn = this.pool.get(id);
    if (!conn) throw new RegistryError(`upstream not pooled: ${id}`, 'not_found');
    await this.closeConnection(conn);
    return this.statusOf(id)!;
  }

  /** One upstream's cached tools, original (un-namespaced) form. */
  listUpstreamTools(id: string): McpToolInfo[] {
    const conn = this.pool.get(id);
    if (!conn) throw new RegistryError(`upstream not pooled: ${id}`, 'not_found');
    if (conn.status !== 'connected') return [];
    return [...conn.tools.values()].map((t) => ({
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      inputSchema: t.inputSchema,
    }));
  }

  /** Re-fetch one upstream's tool list (Refresh button). */
  async refreshUpstreamTools(id: string): Promise<McpToolInfo[]> {
    const conn = this.pool.get(id);
    if (!conn) throw new RegistryError(`upstream not pooled: ${id}`, 'not_found');
    if (conn.status !== 'connected') {
      throw new RegistryError(`upstream not connected: ${id}`, 'not_connected');
    }
    await this.refreshTools(conn);
    return this.listUpstreamTools(id);
  }

  has(id: string): boolean {
    return this.pool.has(id);
  }

  /**
   * Wait until no upstream is left in `connecting` state (or the timeout
   * passes — best-effort). Used by the shim to register tools only after the
   * initial dial round, so a slow upstream doesn't vanish from the tool list.
   */
  async settle(timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.statuses().every((s) => s.status !== 'connecting')) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private async closeConnection(conn: LiveConnection): Promise<void> {
    conn.status = 'disconnected';
    try {
      await conn.client.close();
    } catch (err) {
      this.log.debug({ err, name: conn.def.name }, 'error closing upstream');
    }
  }

  /** Close every connection. Call on shutdown. */
  async shutdown(): Promise<void> {
    await Promise.all([...this.pool.values()].map((c) => this.closeConnection(c)));
    this.pool.clear();
  }
}

/** Build the right SDK client transport for a resolved transport config. */
function makeClientTransport(
  transport: ResolvedTransport,
): StreamableHTTPClientTransport | SSEClientTransport | StdioClientTransport {
  if (transport.type === 'stdio') {
    // Merge the SDK's safe default env (PATH etc.) with the resolved config —
    // an explicit env would otherwise leave the child without a usable PATH.
    const env = { ...getDefaultEnvironment(), ...(transport.env ?? {}) };
    return new StdioClientTransport({
      command: transport.command,
      ...(transport.args ? { args: transport.args } : {}),
      env,
    });
  }
  const url = new URL(transport.url);
  const init = { requestInit: { headers: transport.headers ?? {} } } as const;
  if (transport.type === 'streamable-http') {
    return new StreamableHTTPClientTransport(url, init);
  }
  return new SSEClientTransport(url, init);
}
