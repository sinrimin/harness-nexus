// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { z } from 'zod';

/**
 * MCP connection & credential validation schemas — single source of truth for
 * request shapes across server, SDK, and web. See wiki design-phase-2.1-credentials.md
 * (credentials + placeholder injection) and wiki design-phase-8-c2.md
 * (the dial-site model that replaced the 3.1 proxy/direct mode).
 *
 * These mirror the domain types in @harness-nexus/core; keep them in sync.
 *
 * Dial-site policy (Phase 8 C2): every McpServer has a `dialSite`.
 *   - `client` — the `hnx mcp serve` shim dials it on the user's machine
 *     (requires every referenced credential to be distributable).
 *   - `server` — the platform dials it; exposed via the `/mcp` outlet. The
 *     only home for non-distributable credentials.
 *   - `auto`   — derived: client iff all referenced credentials are
 *     distributable (or none), else server. See `dial-site.ts`.
 * stdio can only be dialed client-side (409 STDIO_REQUIRES_CLIENT at the route
 * layer — a server cannot spawn processes on the user's machine).
 *
 * Credential injection (Phase 2.1): a credential's secret is referenced by name
 * via a `${cred:NAME}` placeholder inside any transport string field (url,
 * command, args, env values, header values). The placeholder is resolved to
 * the decrypted plaintext at connect time — server-side for server-dialed
 * rows, by the client shim for client-dialed rows (fetched resolved over TLS
 * from the client-config API; plaintext then lives in shim memory only).
 * See `utils/placeholders.ts`.
 */

const scopeSchema = z.enum(['global', 'personal']);
const dialSiteSchema = z.enum(['auto', 'client', 'server']);

// ---- credentials ----
// A credential is a pure named secret — no `kind`. The name is the handle used
// in `${cred:NAME}` placeholders.
export const createCredentialSchema = z.object({
  name: z.string().min(1).max(64),
  secret: z.string().min(1).max(8192),
  scope: scopeSchema,
  /**
   * Phase 8 C2 — may the plaintext leave the server (resolved into a client
   * shim's memory)? Personal credentials are ALWAYS distributable (the
   * owner's own machines); for global credentials this is an admin opt-in,
   * default false (the locked policy: non-distributable globals are served
   * only through the platform `/mcp` outlet).
   */
  distributable: z.boolean().optional(),
});

export const updateCredentialSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  secret: z.string().min(1).max(8192).optional(),
  distributable: z.boolean().optional(),
});

// ---- transport ----
// Header values (and url) may carry `${cred:NAME}` placeholders, resolved at
// connect/install time. stdio accepts the same placeholders in command/args/env.
const headersBase = {
  headers: z.record(z.string(), z.string()).optional(),
};

export const stdioTransportSchema = z.object({
  type: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

export const mcpTransportSchema = z.discriminatedUnion('type', [
  stdioTransportSchema,
  z.object({ type: z.literal('sse'), url: z.string().url(), ...headersBase }),
  z.object({
    type: z.literal('streamable-http'),
    url: z.string().url(),
    ...headersBase,
  }),
]);

/** True iff the transport can only be dialed client-side (stdio). */
export function requiresClient(transport: { type: 'stdio' | 'sse' | 'streamable-http' }): boolean {
  return transport.type === 'stdio';
}

// ---- mcp servers ----
// The stdio + server-dial incompatibility is enforced in the route handler
// (AppError 409 STDIO_REQUIRES_CLIENT), not here, so the error carries the
// right code rather than a generic 400 validation error.
export const createMcpServerSchema = z.object({
  name: z.string().min(1).max(64),
  transport: mcpTransportSchema,
  dialSite: dialSiteSchema.default('auto'),
  scope: scopeSchema,
});

export const updateMcpServerSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  transport: mcpTransportSchema.optional(),
  dialSite: dialSiteSchema.optional(),
});

export type CreateCredentialInput = z.infer<typeof createCredentialSchema>;
export type UpdateCredentialInput = z.infer<typeof updateCredentialSchema>;
export type CreateMcpServerInput = z.infer<typeof createMcpServerSchema>;
export type UpdateMcpServerInput = z.infer<typeof updateMcpServerSchema>;

// ---- client config fetch (Phase 8 C2) ----
// The response of GET /api/client/mcp-config?profile=<id> — the `hnx mcp serve`
// shim's entire world model. Resolved transports (placeholders substituted with
// plaintext) appear for CLIENT-dialed servers ONLY; server-dialed servers are
// listed by name without a transport (the shim reaches them through the
// platform /mcp outlet, addressed by `platform.baseUrl`).
export const clientMcpConfigSchema = z.object({
  profileId: z.string(),
  /** Present iff any entry resolves to a server dial — dial `${baseUrl}/mcp?profile=<id>`. */
  platform: z.object({ baseUrl: z.string().url() }).nullable(),
  servers: z.array(
    z.union([
      z.object({
        id: z.string(),
        name: z.string(),
        dialSite: z.literal('client'),
        transport: z.discriminatedUnion('type', [
          z.object({
            type: z.literal('stdio'),
            command: z.string(),
            args: z.array(z.string()).optional(),
            env: z.record(z.string(), z.string()).optional(),
          }),
          z.object({
            type: z.literal('sse'),
            url: z.string(),
            headers: z.record(z.string(), z.string()).optional(),
          }),
          z.object({
            type: z.literal('streamable-http'),
            url: z.string(),
            headers: z.record(z.string(), z.string()).optional(),
          }),
        ]),
      }),
      z.object({ id: z.string(), name: z.string(), dialSite: z.literal('server') }),
    ]),
  ),
});

export type ClientMcpConfig = z.infer<typeof clientMcpConfigSchema>;

// ---- tool inspection (Phase 2.4) ----
// The externally-exposed shape of a single upstream's tool, read out of the
// McpRegistry pool (NOT persisted — transient, cached in-memory per connection).
// Distinct from the registry's internal AggregatedTool: this is the
// UN-namespaced per-server form surfaced to the UI (`GET /api/mcp-servers/:id/tools`).
// Defined in shared so server, SDK, and web all share one shape.
export const mcpToolInfoSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()),
});

export type McpToolInfo = z.infer<typeof mcpToolInfoSchema>;
