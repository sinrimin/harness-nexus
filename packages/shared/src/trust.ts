// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * Trust-tier resolution for sourced skills (Phase 7.1).
 *
 * The single source of truth for the trusted repo set and the tier resolution
 * rules. Mirrors Hermes's `TRUSTED_REPOS` + `_resolve_trust_level`
 * (`~/.hermes/hermes-agent/tools/skills_guard.py:40-49`, `skills_hub.py:1050`).
 *
 * Layering note: `shared` does NOT depend on `@harness-nexus/core` (see
 * `packages/shared/package.json` — only `zod`). The `TrustTier` type is
 * therefore mirrored here via `z.infer`, matching how `AgentTarget` is handled
 * in `schemas/profile.ts`. Keep this in sync with
 * `core/src/domain/skill.ts` `TrustTier`.
 */

import { z } from 'zod';

/**
 * The zod schema mirror of `@harness-nexus/core` `TrustTier`. Surfaces 3 tiers;
 * Hermes's 4th (`agent-created`, off-by-default) is intentionally NOT modeled.
 */
export const trustTierSchema = z.enum(['builtin', 'trusted', 'community']);
export type TrustTier = z.infer<typeof trustTierSchema>;

/**
 * The 4 trusted repos (ground-truth verified from Hermes's `TRUSTED_REPOS`,
 * `tools/skills_guard.py:40-49`). Stored LOWERCASE — `resolveTrustTier`
 * lowercases the queried owner/repo before comparing, so entries must match
 * that form ('nvidia/skills', not 'NVIDIA/skills': a capitalized entry would
 * silently never match).
 */
export const TRUSTED_REPOS: ReadonlySet<string> = new Set<string>([
  'openai/skills',
  'anthropics/skills',
  'huggingface/skills',
  'nvidia/skills',
]);

/**
 * The plugin `source` shape — the narrow union accepted by `resolveTrustTier`.
 * Mirrors the nested union on `ResourceSource` `plugin` variant
 * (`core/src/domain/resource.ts`) but kept self-contained here so `shared`
 * need not import `core`.
 */
export type PluginSourceShape =
  | { source: 'github'; repo: string }
  | { source: 'url'; url: string }
  | { source: 'git-subdir'; url: string }
  | { source: 'npm'; package: string }
  | { source: 'archive'; url: string };

/**
 * Resolve the trust tier for a plugin source. Rules (mirror Hermes
 * `_resolve_trust_level`, skills_hub.py:1050-1061):
 *   - `official` source kind      ⇒ `builtin`  (Harness Nexus owns none today;
 *                                            no `official` kind is accepted
 *                                            in our plugin source union, so
 *                                            this branch is currently unused)
 *   - repo owner ∈ TRUSTED_REPOS  ⇒ `trusted`
 *   - otherwise                   ⇒ `community`
 *
 * The 4th Hermes tier (`agent-created`, off-by-default) is NOT surfaced.
 */
export function resolveTrustTier(source: PluginSourceShape): TrustTier {
  const ownerRepo = extractOwnerRepo(source);
  if (ownerRepo && TRUSTED_REPOS.has(ownerRepo.toLowerCase())) return 'trusted';
  return 'community';
}

/**
 * Best-effort `owner/repo` extraction for trust comparison. Returns null if
 * the source doesn't carry a parseable GitHub owner/repo (e.g. npm, or a
 * non-GitHub url).
 */
function extractOwnerRepo(source: PluginSourceShape): string | null {
  if (source.source === 'github') return source.repo;
  if (source.source === 'npm') return null;
  // url / git-subdir: try to pull owner/repo out of a github URL.
  const match = source.url.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?(?:[/?#]|$)/i);
  return match?.[1] ?? null;
}
