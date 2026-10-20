// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/** User and access-control entities. */

/**
 * The two roles. Phase 1 supports exactly these; authorization branches on this
 * single field. See wiki design-phase-1-auth.md.
 */
export type Role = 'admin' | 'user';

export interface User {
  id: string;
  username: string;
  email?: string;
  /** argon2id hash. Null only for future passwordless accounts. */
  passwordHash: string | null;
  /** Exactly one role per user (not an array). */
  role: Role;
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
}

/**
 * Personal Access Token. The raw token is shown once at creation; only its
 * sha256 hash is stored. `prefix` (first chars) is kept for UI recognition.
 * Format: `hnpat_<base64url(32 random bytes)>`.
 */
export interface PersonalAccessToken {
  id: string;
  userId: string;
  name: string;
  /** sha256 of the full `hnpat_…` token. */
  tokenHash: string;
  /** First chars of the raw token, for display only. */
  prefix: string;
  /** Free-form scope tags; reserved for finer-grained checks beyond Phase 1. */
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

/**
 * Where an MCP server upstream is dialed (Phase 8 C2 — replaces the Phase 3.1
 * proxy/direct `mode`).
 *
 * - `client` — the `hnx mcp serve` shim dials it on the user's machine
 *   (stdio / SSE / Streamable HTTP; localhost + LAN upstreams reachable).
 * - `server` — the platform dials it and serves it via the `/mcp` outlet;
 *   the ONLY home for upstreams whose credentials must not leave the server
 *   or that only the platform's network can reach.
 * - `auto`  — derived at use time: client iff every referenced credential is
 *   distributable (or none), else server. See `dial-site.ts` in shared.
 */
export type DialSite = 'auto' | 'client' | 'server';

/** A registered MCP server that this instance consumes (as a client) or serves. */
export interface McpServer {
  id: string;
  name: string;
  /** Transport used to connect to the upstream MCP server. */
  transport: McpTransport;
  /**
   * Who dials this upstream (Phase 8 C2). The registry pools exactly the rows
   * that resolve to `server`; everything else is dialed by the client shim.
   */
  dialSite: DialSite;
  scope: 'global' | 'personal';
  ownerId: string | null;
  /**
   * Two-stage delete (2026-09): the first DELETE soft-deletes (the row leaves
   * management lists and every deploy path skips it; profile editors grey it
   * out and strip it on save). Once no profile references it, a second DELETE
   * physically removes the row. Absent = live.
   */
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type McpTransport =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | {
      type: 'sse';
      url: string;
      /**
       * Static header values. Credential secrets are referenced as
       * `${cred:NAME}` placeholders here (and in `url`), resolved to the
       * decrypted plaintext at connect time (proxy) / install time (direct).
       */
      headers?: Record<string, string>;
    }
  | {
      type: 'streamable-http';
      url: string;
      /** Same placeholder semantics as `sse`. */
      headers?: Record<string, string>;
    };
