// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * Outbound-fetcher type for marketplace catalogs (Phase 7.2).
 *
 * The server's first outbound HTTP path. Kept as an injectable function type
 * (rather than calling `globalThis.fetch` directly) so tests can substitute a
 * fixture reader and avoid hitting GitHub. The default implementation — used
 * in production — is `globalThis.fetch` (Node ≥18 has it natively; the server
 * targets Node 22+).
 *
 * The signature matches `globalThis.fetch` exactly so the default needs no
 * adapter. Tests typically return `{ ok: true, async text() { return fixture; } }`
 * and ignore `init`.
 */

export type MarketplaceFetcher = typeof globalThis.fetch;
