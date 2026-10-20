// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { z } from 'zod';

/**
 * Claude Code / ZCode marketplace.json schema (Phase 7.2).
 *
 * Models the live `anthropics/claude-plugins-official` `.claude-plugin/
 * marketplace.json` shape (ground-truth verified 2026-07). Used by the
 * server-side `SkillCatalogService` to parse a fetched catalog before caching
 * and filtering it for the hub search UI (7.3).
 *
 * Key facts captured here (see `wiki design-phase-7.2-marketplace-fetch.md`):
 *   - Top level has exactly 5 keys: `$schema`, `name`, `description`, `owner`,
 *     `plugins`. There is NO `renames` map in the live official catalog.
 *   - `source` is a discriminated union on the `source` field with 3 object
 *     arms (`git-subdir` / `url` / `github`). The string relative-path form
 *     (`"./plugins/foo"`) is intentionally NOT modeled — those ~30 in-repo
 *     entries are filtered out during parsing because they only make sense
 *     inside the marketplace's own repo and cannot be stored as a standalone
 *     installable spec.
 *   - `npm` is a documented source kind but is absent from the official
 *     catalog; it lives on `ResourceSource.plugin` (storage side), not here.
 *   - `github` entries carry BOTH `commit` and `sha` (treated as aliases; `sha`
 *     is the effective pin).
 *
 * The schema is non-strict (unknown keys pass through) so new fields the
 * official catalog adds don't break parsing — we only validate what we use.
 */

const marketplaceOwnerSchema = z.object({
  name: z.string().min(1),
  email: z.string().optional(),
  url: z.string().optional(),
});

/**
 * The 3 object `source` kinds that produce a standalone-installable spec.
 * The string relative-path form is excluded by construction (this is a
 * discriminated union on the `source` literal, which only objects carry).
 *
 * Phase 3.5 adds the `archive` arm — a plain HTTPS zip download, no git/npm.
 * It is what Harness Nexus EMITS (the marketplace-emitter surface) and what
 * Claude Code ≥2.1.224 consumes; the official catalog doesn't use it, so the
 * 7.2 parse path simply never sees it in the wild. `sha256` is optional
 * content pinning (spike-verified).
 */
export const marketplaceSourceSchema = z.discriminatedUnion('source', [
  z.object({
    source: z.literal('archive'),
    url: z.string().min(1),
    sha256: z.string().optional(),
  }),
  z.object({
    source: z.literal('git-subdir'),
    url: z.string().min(1),
    path: z.string().min(1),
    ref: z.string().optional(),
    sha: z.string().optional(),
  }),
  z.object({
    source: z.literal('url'),
    url: z.string().min(1),
    sha: z.string().optional(),
    ref: z.string().optional(),
    path: z.string().optional(),
  }),
  z.object({
    source: z.literal('github'),
    repo: z.string().min(1),
    commit: z.string().optional(),
    sha: z.string().optional(),
    path: z.string().optional(),
  }),
]);

export const marketplacePluginSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  source: marketplaceSourceSchema,
  // Search/filter-relevant optional fields. `category` is the primary filter
  // axis (present on ~243/257 live entries). `author`/`homepage`/`version`/
  // `displayName`/`tags`/`keywords` are carried for display. `lspServers`/
  // `strict`/`skills` are dropped — unused by the hub UI.
  displayName: z.string().optional(),
  category: z.string().optional(),
  homepage: z.string().optional(),
  version: z.string().optional(),
  author: marketplaceOwnerSchema.optional(),
  tags: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
});

export const marketplaceCatalogSchema = z.object({
  $schema: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  owner: marketplaceOwnerSchema.optional(),
  /**
   * The raw plugin entries, validated as `unknown` here so that entries with
   * the string relative-path `source` form (not modeled) don't fail the whole
   * catalog parse. The catalog service validates each entry with
   * `marketplacePluginSchema` and drops the invalid ones, producing a
   * `MarketplaceCatalog` whose `plugins` are typed `MarketplacePlugin[]`.
   */
  plugins: z.array(z.unknown()),
});

export type MarketplaceSource = z.infer<typeof marketplaceSourceSchema>;
export type MarketplacePlugin = z.infer<typeof marketplacePluginSchema>;
/**
 * Parsed marketplace shape. Note `plugins` is `MarketplacePlugin[]` at the
 * type level (the catalog service filters out unmodeled string-source entries
 * before constructing this), even though the runtime zod schema accepts
 * `unknown[]` to avoid rejecting the whole catalog on those entries.
 */
export interface MarketplaceCatalog {
  $schema?: string | undefined;
  name: string;
  description?: string | undefined;
  owner?: z.infer<typeof marketplaceOwnerSchema> | undefined;
  plugins: MarketplacePlugin[];
}

/**
 * The `ResourceSource.plugin` shape, mirrored locally (shared does not depend
 * on core — same layering pattern as `TrustTier`/`AgentTarget`). Keep in sync
 * with `core/src/domain/resource.ts` `ResourceSource.plugin`. Callers that
 * need the domain type cast at the boundary (`as Resource['source']`).
 */
export interface PluginResourceSource {
  type: 'plugin';
  source:
    | { source: 'github'; repo: string; ref?: string; sha?: string; path?: string }
    | { source: 'url'; url: string; ref?: string; sha?: string; path?: string }
    | { source: 'git-subdir'; url: string; path: string; ref?: string; sha?: string }
    | { source: 'npm'; package: string; version: string; registry?: string };
  plugin: string;
  version?: string;
}

/**
 * Extract the `plugin`-source shape from a search result's `extra.pluginSource`
 * (Phase 7.4). Every SkillSource adapter precomputes and attaches the
 * `PluginResourceSource` it would save as, so the hub's "save as skill" path
 * doesn't need to reverse-engineer it from the identifier. Returns `null` for
 * results that didn't carry one (e.g. a future adapter that doesn't map to a
 * plugin source).
 */
export function skillMetaToResourceSource(meta: {
  extra?: { pluginSource?: unknown } | undefined;
}): PluginResourceSource | null {
  const ps = meta.extra?.pluginSource;
  return ps ? (ps as PluginResourceSource) : null;
}

/**
 * Convert a marketplace plugin entry into a `plugin`-source `ResourceSource`
 * for `POST /api/resources`. The marketplace `source` kinds map 1:1 onto the
 * plugin-source `source` union, with one wrinkle: the marketplace `github`
 * kind carries `commit` AND `sha` (aliases per the research doc); the storage
 * shape only has `sha`, so `commit` folds into `sha` when `sha` is absent.
 *
 * The marketplace catalog has no `npm` source kind (dropped in 7.2's
 * schema); this helper therefore never produces a `npm` arm from a real
 * catalog entry. The `npm` arm exists on `PluginResourceSource` for parity
 * with the storage type and for future direct-input paths.
 *
 * `pluginName` is the namespace half of the `plugin:skill` handle — usually
 * the marketplace entry's `name`.
 */
export function marketplacePluginToResourceSource(
  plugin: MarketplacePlugin,
  pluginName: string = plugin.name,
): PluginResourceSource | null {
  const s = plugin.source;
  let source: PluginResourceSource['source'];
  if (s.source === 'archive') {
    // An `archive` zip has no faithful `plugin`-source representation (the
    // storage-side plugin union models git/npm refs, not raw zips). Only our
    // own 3.5 emitter emits these today; the hub treats a null pluginSource
    // as "cannot save as a plugin-source skill".
    return null;
  }
  if (s.source === 'github') {
    source = {
      source: 'github',
      repo: s.repo,
      ...(s.sha ? { sha: s.sha } : s.commit ? { sha: s.commit } : {}),
      ...(s.path ? { path: s.path } : {}),
    };
  } else if (s.source === 'url') {
    source = {
      source: 'url',
      url: s.url,
      ...(s.sha ? { sha: s.sha } : {}),
      ...(s.ref ? { ref: s.ref } : {}),
      ...(s.path ? { path: s.path } : {}),
    };
  } else {
    // git-subdir
    source = {
      source: 'git-subdir',
      url: s.url,
      path: s.path,
      ...(s.sha ? { sha: s.sha } : {}),
      ...(s.ref ? { ref: s.ref } : {}),
    };
  }
  return {
    type: 'plugin',
    source,
    plugin: pluginName,
    ...(plugin.version ? { version: plugin.version } : {}),
  };
}
