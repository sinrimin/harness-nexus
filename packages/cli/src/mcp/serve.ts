// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * `hnx mcp serve` — the client MCP shim (Phase 8 C2).
 *
 * Spawned BY an Agent tool as a per-session stdio MCP server (the tool's MCP
 * config carries one stdio entry per profile). The shim:
 *   1. fetches its resolved config from the platform
 *      (`GET /api/client/mcp-config?profile=<id>` — machine PAT or user PAT);
 *   2. dials every CLIENT-dialed upstream locally via `mcp-runtime` (stdio /
 *      SSE / HTTP; credential plaintext lives in this process's memory only);
 *   3. dials the platform `/mcp?profile=<id>` outlet as one PASSTHROUGH
 *      upstream when the profile has server-dialed entries (their tools are
 *      already namespaced server-side);
 *   4. serves the merged, namespaced tool set over stdio until the tool
 *      closes our stdin.
 *
 * Config applies at process start — changes take effect next agent session.
 * NEVER write to stdout (it carries the MCP protocol); all logs go to stderr.
 * Uses the low-level `Server` (not `McpServer`) so upstream tools' raw JSON
 * inputSchemas pass through verbatim — no zod round-trip, no schema drift.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import {
  UpstreamPool,
  type ResolvedTransport,
  type UpstreamDefinition,
} from '@harness-nexus/mcp-runtime';
import { HarnessNexusClient, HarnessNexusError } from '@harness-nexus/sdk';
import type { ClientMcpConfig } from '@harness-nexus/shared';
import { InstallError } from '../errors.js';
import { DAEMON_VERSION } from '../daemon/client.js';

/** stderr-only logger for the pool (stdout belongs to the MCP protocol). */
const stderrLog = {
  info(_obj: object, msg: string): void {
    // eslint-disable-next-line no-console
    console.error(`[hnx-mcp] ${msg}`);
  },
  warn(obj: object, msg: string): void {
    const detail = 'err' in obj && obj.err instanceof Error ? `: ${obj.err.message}` : '';
    // eslint-disable-next-line no-console
    console.error(`[hnx-mcp] WARN ${msg}${detail}`);
  },
  debug(): void {
    /* quiet by default */
  },
};

export interface McpServeOptions {
  profileId: string;
  server: string;
  /** Machine PAT (from `hnx enroll`) or a user PAT. */
  token: string;
}

export async function runMcpServe(opts: McpServeOptions): Promise<void> {
  const client = new HarnessNexusClient({ baseUrl: opts.server, token: opts.token });
  let config: ClientMcpConfig;
  try {
    config = await client.getClientMcpConfig(opts.profileId);
  } catch (e) {
    throw new InstallError(
      `Failed to fetch MCP config for profile '${opts.profileId}': ${
        e instanceof HarnessNexusError
          ? `${e.code}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e)
      }`,
      'RESOLVE_FAILED',
      e,
    );
  }

  // Client-dialed upstreams (transports arrive resolved — memory-only secrets).
  // Cast: zod-inferred optionals (`| undefined`) vs the runtime's exact-optional
  // shape — identical at runtime, validated at the API boundary.
  const defs: UpstreamDefinition[] = [];
  for (const s of config.servers) {
    if (s.dialSite !== 'client') continue;
    defs.push({ id: s.id, name: s.name, transport: s.transport as ResolvedTransport });
  }
  // The platform outlet as ONE passthrough upstream (tools already namespaced).
  if (config.platform !== null) {
    defs.push({
      id: '__outlet__',
      name: 'harness-nexus',
      transport: {
        type: 'streamable-http',
        url: `${config.platform.baseUrl.replace(/\/$/, '')}/mcp?profile=${encodeURIComponent(
          config.profileId,
        )}`,
        headers: { Authorization: `Bearer ${opts.token}` },
      },
      namespaced: true,
    });
  }

  const pool = new UpstreamPool({
    logger: stderrLog,
    clientName: 'hnx-mcp-serve',
    clientVersion: DAEMON_VERSION,
  });
  await pool.sync(defs);
  await pool.settle();
  for (const s of pool.statuses()) {
    if (s.status === 'error') {
      stderrLog.warn({}, `upstream "${s.name}" failed: ${s.detail ?? 'unknown error'} (skipped)`);
    }
  }

  const server = new Server(
    { name: 'hnx-mcp-serve', version: DAEMON_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: pool.listTools().map((t) => ({
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      const result = await pool.callTool(name, args);
      return result as CallToolResult;
    } catch (e) {
      const text = e instanceof Error ? e.message : String(e);
      return { content: [{ type: 'text', text }], isError: true } satisfies CallToolResult;
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  stderrLog.info({}, `serving profile ${config.profileId} (${pool.listTools().length} tools)`);

  await new Promise<void>((resolve) => {
    server.onclose = () => {
      void pool.shutdown().finally(resolve);
    };
  });
}
