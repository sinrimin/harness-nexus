// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { BuiltinMcpService } from '@harness-nexus/shared';
import { NOTES_TOOL_DEFS } from './notes-tools.js';

/**
 * The built-in MCP service (#106) — the platform's own toolset, shown on the
 * MCP management page as ONE global, non-modifiable service. There is no DB
 * row and no pool entry: the tools are the virtual namespaces injected into
 * every `/mcp` profile session by `buildSession` (proxy.ts), which is also
 * where each call receives its Principal — an in-process service must never
 * lose the caller's identity, so the UpstreamPool (whose `callTool` carries
 * none) is the wrong home.
 *
 * New built-in tool groups register HERE: define the defs + dispatcher wiring
 * in proxy.ts, then extend `tools`. This descriptor is display truth only.
 */
export function builtinMcpService(): BuiltinMcpService {
  return {
    id: 'builtin',
    // First group: the notes agent tools (#88).
    tools: NOTES_TOOL_DEFS.map((def) => ({
      name: def.name,
      description: def.description,
      inputSchema: def.inputSchema,
    })),
  };
}
