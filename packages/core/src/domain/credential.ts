// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * A Credential is a reusable named secret that Harness Nexus injects into an MCP
 * transport at resolve time. It is referenced by name via a `${cred:NAME}`
 * placeholder inside transport string fields (url, command, args, env values,
 * header values); the placeholder is replaced with the decrypted plaintext when
 * the connection is opened (proxy mode) or at install time (direct mode).
 *
 * This is distinct from PersonalAccessToken, which authenticates a user *into*
 * Harness Nexus. A Credential authenticates Harness Nexus *out to* a third party.
 *
 * The `secret` field holds AES-256-GCM ciphertext (see server crypto module);
 * the plaintext is never returned by the API (responses carry a masked
 * preview instead). See wiki design-phase-2.1-credentials.md.
 */

export interface Credential {
  id: string;
  name: string;
  /** AES-256-GCM ciphertext (base64). Plaintext is write-only at the API. */
  secret: string;
  scope: 'global' | 'personal';
  /** null iff scope === 'global'; otherwise the owning user id. */
  ownerId: string | null;
  /**
   * Phase 8 C2 — may the resolved plaintext leave the server (into a client
   * shim's memory)? Personal credentials are always distributable (the
   * owner's own machines); global credentials carry an admin opt-in, default
   * false — non-distributable globals are served only through the platform
   * `/mcp` outlet. See wiki design-phase-8-c2.md.
   */
  distributable: boolean;
  createdAt: string;
  updatedAt: string;
}
