// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * Marketplace allowlist parsing (Phase 7.2).
 *
 * The server fetches `marketplace.json` only from explicitly-allowed sources
 * (`MARKETPLACE_ALLOWLIST` env). This bounds the server's outbound network
 * surface — the first such surface in the codebase — to a small, auditable set.
 *
 * Two entry forms are accepted (comma-separated):
 *   - `name=owner/repo`   → resolved to the GitHub raw URL of the default
 *                           branch's `.claude-plugin/marketplace.json`.
 *   - `name=<full-url>`   → used verbatim (any HTTPS URL to a marketplace.json).
 *
 * Default (when the env var is unset/empty): the official CC marketplace.
 */

const DEFAULT_ALLOWLIST = 'claude-plugins-official=anthropics/claude-plugins-official';

/** A parsed allowlist entry: a stable id + the resolved fetch URL. */
export interface MarketplaceEntry {
  id: string;
  url: string;
}

/**
 * Parse the `MARKETPLACE_ALLOWLIST` env value into entries. Accepts the env
 * object (defaulting to `process.env`) to stay testable — same injection style
 * as `loadConfig(env)`.
 */
export function parseAllowlist(
  raw: string = DEFAULT_ALLOWLIST,
  _env?: NodeJS.ProcessEnv,
): MarketplaceEntry[] {
  const entries: MarketplaceEntry[] = [];
  for (const token of raw.split(',')) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue; // malformed — skip silently (allowlist is best-effort)
    const id = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    const url = resolveUrl(value);
    if (id && url) entries.push({ id, url });
  }
  // De-dup by id, last wins.
  const byId = new Map<string, MarketplaceEntry>();
  for (const e of entries) byId.set(e.id, e);
  return [...byId.values()];
}

/**
 * Resolve an allowlist value to a fetchable URL.
 *   - `owner/repo` (no scheme) → GitHub raw URL on the default branch.
 *   - any URL (has `://`)     → used verbatim.
 *   - anything else           → null (skipped).
 */
export function resolveUrl(value: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value; // already a URL
  // `owner/repo` — GitHub shorthand. Reject anything with spaces or slashes
  // beyond the single owner/repo separator.
  const m = value.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/);
  if (m) {
    return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/main/.claude-plugin/marketplace.json`;
  }
  return null;
}

/** Look up an allowlist entry by id. Returns the URL or null if not allowed. */
export function resolveAllowlistId(entries: MarketplaceEntry[], id: string): string | null {
  return entries.find((e) => e.id === id)?.url ?? null;
}

// ---- Fastify type augmentation for the decorated allowlist ----
declare module 'fastify' {
  interface FastifyInstance {
    marketplaceAllowlist: MarketplaceEntry[];
  }
}
