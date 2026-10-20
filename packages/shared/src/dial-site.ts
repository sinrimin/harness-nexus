// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { CRED_PLACEHOLDER_RE } from './utils/placeholders.js';

/**
 * Dial-site derivation (Phase 8 C2) — replaces the Phase 3.1 proxy/direct
 * `mode`. Pure and shared so the server (pool filter + client-config API) and
 * the `hnx mcp serve` shim compute identical answers. See
 * wiki design-phase-8-c2.md for the normative matrix.
 */

/** Where an McpServer is dialed. `auto` is derived away before any dialing. */
export type DialSite = 'auto' | 'client' | 'server';

/** A resolved dial site — `auto` has been derived away. */
export type ResolvedDialSite = 'client' | 'server';

/**
 * Structural transport shape for scanning. Avoids importing `core` (shared is
 * the bottom of the dependency graph); mirrors the zod `mcpTransportSchema`.
 */
export interface ScannableTransport {
  type: 'stdio' | 'sse' | 'streamable-http';
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

function scan(value: string | undefined, out: Set<string>): void {
  if (!value) return;
  for (const m of value.matchAll(CRED_PLACEHOLDER_RE)) {
    const name = m[1];
    if (name) out.add(name);
  }
}

/** Every distinct `${cred:NAME}` referenced anywhere in a transport config. */
export function transportPlaceholderNames(transport: ScannableTransport): string[] {
  const names = new Set<string>();
  scan(transport.url, names);
  if (transport.headers) for (const v of Object.values(transport.headers)) scan(v, names);
  scan(transport.command, names);
  if (transport.args) for (const a of transport.args) scan(a, names);
  if (transport.env) for (const v of Object.values(transport.env)) scan(v, names);
  return [...names];
}

/**
 * Derive who dials an upstream:
 *   - explicit `client` / `server` wins (the admin override);
 *   - `auto` ⇒ client iff the transport references no credential, or every
 *     referenced credential is distributable; otherwise server (the platform
 *     `/mcp` outlet is the only place a non-distributable secret may live).
 *
 * Note stdio transports can only ever be dialed client-side (a server cannot
 * spawn processes on the user's machine) — enforced at the route layer.
 */
export function resolveDialSite(
  server: { dialSite: DialSite; transport: ScannableTransport },
  isDistributable: (name: string) => boolean,
): ResolvedDialSite {
  if (server.dialSite === 'client') return 'client';
  if (server.dialSite === 'server') return 'server';
  const names = transportPlaceholderNames(server.transport);
  if (names.length === 0) return 'client';
  return names.every((name) => isDistributable(name)) ? 'client' : 'server';
}
