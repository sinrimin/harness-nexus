// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * ProfileResolver — fetches a profile and resolves every entry's `resourceId`
 * into its concrete artifact via the SDK against a running Harness Nexus server.
 *
 * A profile is a reference bundle: `entries[].resourceId` points at a server-side
 * `McpServer` (for `kind: 'mcp'`) or `Resource` (other kinds). The resolver
 * dereferences them so adapters can emit target-native files. This is the only
 * outbound path in the CLI; there is no local-manifest fallback (a profile's
 * resource bodies and the aggregated `/mcp` endpoint both require the server).
 *
 * See `wiki design-phase-3-install.md` Part 4.
 */
import { HarnessNexusClient, HarnessNexusError } from '@harness-nexus/sdk';
import type { Profile, McpServer } from '@harness-nexus/core';
import { InstallError } from '../errors.js';
import type { ResolvedArtifact, ResolvedProfile } from './types.js';

export interface ResolveOptions {
  /** Base URL of the Harness Nexus server. */
  server: string;
  /** PAT (or JWT) authenticating against the server. */
  token: string;
  /** The profile id to resolve. */
  profileId: string;
}

/**
 * Fetch the profile + every entry's artifact. Throws `RESOLVE_FAILED` if the
 * profile or any referenced resource is missing or the request errors.
 */
export async function resolveProfile(opts: ResolveOptions): Promise<ResolvedProfile> {
  const client = new HarnessNexusClient({ baseUrl: opts.server, token: opts.token });

  let profile: Profile;
  try {
    ({ profile } = await client.getProfile(opts.profileId));
  } catch (e) {
    throw new InstallError(
      `Failed to fetch profile '${opts.profileId}': ${describeError(e)}`,
      'RESOLVE_FAILED',
      e,
    );
  }

  const artifacts: ResolvedArtifact[] = [];
  for (const [index, entry] of profile.entries.entries()) {
    try {
      if (entry.kind === 'mcp') {
        // MCP entries reference a McpServer.id. Fetch the full server list once
        // and find by id (there is no single-get MCP endpoint in the SDK today).
        const servers = await client.listMcpServers();
        const server = servers.find((s: McpServer) => s.id === entry.resourceId);
        if (!server) {
          throw new Error(`MCP server '${entry.resourceId}' not found`);
        }
        artifacts.push({ entryId: entry.resourceId, kind: 'mcp', mcpServer: server });
      } else {
        const { resource } = await client.getResource(entry.resourceId);
        artifacts.push({ entryId: entry.resourceId, kind: entry.kind, resource });
      }
    } catch (e) {
      throw new InstallError(
        `Failed to resolve profile entry #${index} (kind=${entry.kind}, id=${entry.resourceId}): ${describeError(e)}`,
        'RESOLVE_FAILED',
        e,
      );
    }
  }

  return { profile, artifacts };
}

function describeError(e: unknown): string {
  if (e instanceof HarnessNexusError) return `${e.code}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}
