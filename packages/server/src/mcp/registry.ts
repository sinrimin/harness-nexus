/**
 * McpRegistry — the server-side aggregation layer (Phase 2.2, reshaped in
 * Phase 8 C2).
 *
 * Owns which upstreams the platform itself dials: exactly the `McpServer` rows
 * whose dial site RESOLVES to `server` (see `shared/dial-site.ts` — non-
 * distributable credentials, or an explicit admin override). Those are pooled
 * and re-exposed through the `/mcp` outlet. Everything else is dialed on the
 * user's machine by the `hnx mcp serve` shim, which fetches its resolved
 * config from `modules/client-config.ts`.
 *
 * Transport-facing work (dialing, namespacing, tool routing) lives in
 * `@harness-nexus/mcp-runtime` and is shared with the shim; this class keeps
 * the server concerns — config loading from the UnitOfWork, `${cred:NAME}`
 * resolution against the encrypted store, dial-site derivation, profile
 * visibility — and the Phase 2.4 operator surface.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { McpServer, McpTransport, Profile, UnitOfWork } from '@harness-nexus/core';
import {
  resolveDialSite,
  resolvePlaceholders,
  transportPlaceholderNames,
  type McpToolInfo,
} from '@harness-nexus/shared';
import {
  UpstreamPool,
  RegistryError,
  type AggregatedTool,
  type McpServerStatus,
  type ResolvedTransport,
  type UpstreamDefinition,
} from '@harness-nexus/mcp-runtime';
import { decryptSecret } from '../infra/crypto.js';
import { findCredentialForOwner } from '../infra/credential-scope.js';

export { NAMESPACE_SEP } from '@harness-nexus/mcp-runtime';
export { RegistryError };
export type {
  AggregatedTool,
  ConnectionStatus,
  McpServerStatus,
  RegistryErrorKind,
} from '@harness-nexus/mcp-runtime';

export interface McpRegistryOptions {
  uow: UnitOfWork;
  /** Key material for decrypting credential secrets (see crypto.ts). */
  encryptionKey: string;
  logger: FastifyBaseLogger;
}

export class McpRegistry {
  private readonly uow: UnitOfWork;
  private readonly encryptionKey: string;
  private readonly pool: UpstreamPool;
  private readonly logger: FastifyBaseLogger;

  constructor(opts: McpRegistryOptions) {
    this.uow = opts.uow;
    this.encryptionKey = opts.encryptionKey;
    this.logger = opts.logger;
    this.pool = new UpstreamPool({ logger: opts.logger, clientName: 'harness-nexus-server' });
  }

  /**
   * Re-read the configured servers, derive each one's dial site, and
   * reconcile the pool against exactly the server-dialed set. Safe to call
   * repeatedly; concurrent calls share the same in-flight promise (upstream
   * pool guard). Called at boot (`mountMcpProxy`) and fire-and-forget by the
   * mcp-servers routes after any mutation.
   */
  reload(): Promise<void> {
    if (this.reloadPromise) return this.reloadPromise;
    this.reloadPromise = this.doReload().finally(() => {
      this.reloadPromise = null;
    });
    return this.reloadPromise;
  }

  private reloadPromise: Promise<void> | null = null;

  private async doReload(): Promise<void> {
    const defs = await this.serverDialedDefinitions();
    await this.pool.sync(defs);
  }

  /** The McpServers this platform itself dials (the `/mcp` outlet's set). */
  private async serverDialedDefinitions(): Promise<UpstreamDefinition[]> {
    const servers = await this.uow.mcpServers.list();
    const defs: UpstreamDefinition[] = [];
    for (const server of servers) {
      if ((await this.dialSiteFor(server)) !== 'server') {
        continue;
      }
      // A row whose transport cannot resolve — stdio can never be server-dialed
      // (auto derives it when a referenced credential is missing/non-
      // distributable, e.g. a C3-imported `${cred:...}` placeholder whose
      // credential doesn't exist yet), or a referenced credential is absent —
      // is skipped with a warning. Unreachable/misconfigured upstreams never
      // block the pool (Phase 2.2 rule); the row is still dialed by nothing
      // until its config is fixed.
      try {
        defs.push({
          id: server.id,
          name: server.name,
          transport: await this.resolveTransport(server.transport, server.ownerId),
        });
      } catch (err) {
        this.logger.warn(
          { serverId: server.id, serverName: server.name },
          `mcp server skipped by the server-dial pool: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return defs;
  }

  /**
   * name → distributable for every stored credential, resolved within the
   * given owner's namespace (#21) — the row owner's personal rows shadow
   * same-named global rows, so derivation and decryption always agree.
   */
  private async dialSiteFor(server: McpServer): Promise<'client' | 'server'> {
    const dist = new Map<string, boolean>();
    for (const name of transportPlaceholderNames(server.transport)) {
      const cred = await findCredentialForOwner(this.uow, name, server.ownerId);
      dist.set(name, cred?.distributable === true);
    }
    return resolveDialSite(server, (name) => dist.get(name) === true);
  }

  /** Substitute every `${cred:NAME}` in a transport config (server-side dial). */
  private async resolveTransport(
    t: McpTransport,
    ownerId: string | null,
  ): Promise<ResolvedTransport> {
    if (t.type === 'stdio') {
      // Defensive: the route layer rejects stdio server-dial (409); auto only
      // derives it when a referenced credential is missing/non-distributable
      // (e.g. a C3-imported `${cred:...}` placeholder). Throwing here is fine:
      // serverDialedDefinitions skips the row with a warning instead of
      // crashing the pool.
      throw new Error(`stdio upstream "${t.command}" cannot be server-dialed`);
    }
    const url = await this.resolve(t.url, ownerId);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(t.headers ?? {})) {
      headers[k] = await this.resolve(v, ownerId);
    }
    return { type: t.type, url, ...(Object.keys(headers).length > 0 ? { headers } : {}) };
  }

  /** Resolve placeholders in a string within the row owner's namespace. */
  private async resolve(input: string, ownerId: string | null): Promise<string> {
    return resolvePlaceholders(input, async (name) => {
      const cred = await findCredentialForOwner(this.uow, name, ownerId);
      if (!cred) {
        throw new Error(`credential "${name}" not found (referenced by placeholder)`);
      }
      return decryptSecret(cred.secret, this.encryptionKey);
    });
  }

  /**
   * Resolve a profile into the set of outlet server ids it exposes, after an
   * accessibility check. Throws if the profile references an MCP server the
   * caller cannot see. Returns `{ serverIds }` for use as a `listTools` filter.
   */
  async profileEntriesFor(profileId: string, userId: string): Promise<{ serverIds: string[] }> {
    const profile = await this.uow.profiles.findById(profileId);
    if (!profile || !profileVisibleBy(profile, userId)) {
      throw new Error(`profile ${profileId} not accessible`);
    }
    const serverIds: string[] = [];
    for (const entry of profile.entries) {
      if (entry.kind !== 'mcp') continue;
      const server = await this.uow.mcpServers.findById(entry.resourceId);
      // Soft-deleted rows are skipped (two-stage delete), not fatal.
      if (!server || server.deletedAt !== undefined) continue;
      if (!serverVisibleBy(server, userId)) {
        throw new Error(`profile entry ${entry.resourceId} not accessible`);
      }
      serverIds.push(server.id);
    }
    return { serverIds };
  }

  /** Aggregated (namespaced) tools of the pooled server-dialed set. */
  listTools(filterServerIds?: string[]): AggregatedTool[] {
    return this.pool.listTools(filterServerIds);
  }

  /** Call a namespaced tool on a pooled upstream. */
  callTool(namespacedName: string, args?: Record<string, unknown>): Promise<unknown> {
    return this.pool.callTool(namespacedName, args);
  }

  /** Snapshot of every server-dialed upstream's connection status. */
  getStatuses(): McpServerStatus[] {
    return this.pool.statuses();
  }

  // ---- per-server operator control (Phase 2.4) ----
  // Explicit connect/disconnect + tool inspection over the pool. They add an
  // operator surface on top of startup pooling; they do NOT change `/mcp`
  // aggregation. Server-dialed rows only — client-dialed rows are never
  // dialed by the platform (that is the shim's job).

  /**
   * Force (re)connect of one server-dialed upstream — the main use is
   * re-dialing a server stuck at `error` after a config/credential fix, since
   * `reload()` is fire-and-forget. Reads the LATEST config so edits since
   * startup are honored. Best-effort: resolves with the resulting status
   * (possibly `error` + `detail`) rather than throwing on upstream failure;
   * only config-level problems (deleted / not server-dialed) throw.
   */
  async connectServer(id: string): Promise<McpServerStatus> {
    const def = await this.definitionForId(id);
    return this.pool.connect(def);
  }

  /**
   * Drop a live connection on demand WITHOUT removing the pool entry — the
   * entry stays `disconnected` so it remains visible in `getStatuses()` and is
   * NOT silently reconnected by the next unrelated `refresh()`.
   */
  async disconnectServer(id: string): Promise<McpServerStatus> {
    return this.pool.disconnect(id);
  }

  /** One server's cached tools in their ORIGINAL (un-namespaced) form. */
  listServerTools(id: string): McpToolInfo[] {
    return this.pool.listUpstreamTools(id);
  }

  /** Re-fetch one server's tool list and return it (Refresh button). */
  async refreshServerTools(id: string): Promise<McpToolInfo[]> {
    return this.pool.refreshUpstreamTools(id);
  }

  /** Load a server's latest config and require it to be server-dialed. */
  private async definitionForId(id: string): Promise<UpstreamDefinition> {
    const server = await this.uow.mcpServers.findById(id);
    if (!server) {
      throw new RegistryError(`MCP server not pooled: ${id}`, 'not_found');
    }
    const site = await this.dialSiteFor(server);
    if (site !== 'server' || server.transport.type === 'stdio') {
      throw new RegistryError(
        `MCP server "${server.name}" is dialed by the client, not the platform (dial site: ${site})`,
        'not_dialable',
      );
    }
    try {
      return {
        id: server.id,
        name: server.name,
        transport: await this.resolveTransport(server.transport, server.ownerId),
      };
    } catch (err) {
      // #25: an unresolvable ${cred:NAME} is a config problem — surface it as
      // a clean 409 not_dialable (naming the scope rule) instead of a raw 500.
      // Common cause: a global row referencing a personal credential — since
      // #21 a row resolves credentials in its own scope only.
      throw new RegistryError(
        `MCP server "${server.name}" cannot be dialed: ${
          err instanceof Error ? err.message : String(err)
        }. A ${server.scope}-scope row resolves ${
          server.scope === 'global'
            ? 'global credentials only — move the credential to global scope (or the row to personal)'
            : "its owner's credentials — check the credential's name/scope"
        }.`,
        'not_dialable',
      );
    }
  }

  /** Close every pooled connection. Call on app shutdown. */
  async shutdown(): Promise<void> {
    await this.pool.shutdown();
  }
}

/** A profile is visible to a user iff global, or personal + owned by them (#36). */
function profileVisibleBy(profile: Profile, userId: string): boolean {
  return profile.scope === 'global' || profile.ownerId === userId;
}

/** An MCP server is visible to a user iff global, or personal + owned by them (#36). */
function serverVisibleBy(server: McpServer, userId: string): boolean {
  return server.scope === 'global' || server.ownerId === userId;
}
