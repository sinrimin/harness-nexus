// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { McpServer } from '@harness-nexus/core';
import { BUILTIN_MCP_SERVICE_ID, type BuiltinMcpService } from '@harness-nexus/shared';
import { NOTES_TOOL_DEFS } from './notes-tools.js';

/**
 * The built-in MCP service (#106) — the platform's own toolset, shown on the
 * MCP management page as ONE global, non-modifiable service. There is no DB
 * row and no pool entry: the tools are the virtual namespaces injected into
 * `/mcp` profile sessions by `buildSession` (proxy.ts), which is also where
 * each call receives its Principal — an in-process service must never lose
 * the caller's identity, so the UpstreamPool (whose `callTool` carries none)
 * is the wrong home.
 *
 * Visibility is PROFILE-GATED (#107): a session lists and dispatches the
 * namespace only when the profile carries `{ mcpServerId: 'builtin' }`.
 *
 * New built-in tool groups register HERE: define the defs + dispatcher wiring
 * in proxy.ts, then extend `tools`. The descriptor is display truth only.
 */
export function builtinMcpService(): BuiltinMcpService {
  return {
    id: BUILTIN_MCP_SERVICE_ID,
    // First group: the notes agent tools (#88).
    tools: NOTES_TOOL_DEFS.map((def) => ({
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
    })),
  };
}

/**
 * A synthetic server-dialed McpServer for the install pipelines (CLI resolver
 * + deploy bundle): every adapter keys on `kind === 'mcp'` artifact presence
 * to emit the ONE `hnx mcp serve` shim entry, and the shim fetches the real
 * config from the server — so the row is a placeholder, never dialed itself.
 */
export function builtinMcpServerRow(baseUrl: string): McpServer {
  return {
    id: BUILTIN_MCP_SERVICE_ID,
    name: 'Built-in tools',
    transport: { type: 'streamable-http', url: `${baseUrl.replace(/\/$/, '')}/mcp` },
    dialSite: 'server',
    scope: 'global',
    ownerId: null,
    createdAt: '1970-01-01T00:00:00.000Z',
    updatedAt: '1970-01-01T00:00:00.000Z',
  };
}
