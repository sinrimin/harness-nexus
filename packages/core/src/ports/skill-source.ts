// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * Skill-sourcing port — a uniform interface for fetching skill metadata and
 * bytes from heterogeneous sources (a marketplace, a GitHub repo, a direct
 * URL, …). Mirrors Hermes's `SkillSource` ABC
 * (`~/.hermes/hermes-agent/tools/skills_hub.py:424-449`).
 *
 * This is a PORT — a pure interface. Concrete adapters live in
 * `@harness-nexus/server` under `src/infra/source-fetchers/*`. Phase 7.1 ships
 * one no-op implementation (to prove the shape); 7.2 ships the marketplace
 * adapter; 7.4 ships the rest.
 *
 * NOTE on `trustLevelFor`: Hermes's ABC provides a concrete default returning
 * `"community"` (overridden by adapters that know better). TypeScript
 * interfaces cannot carry method bodies, so this port declares it as a
 * required method — implementers should return `'community'` unless they have
 * a source-specific tier (see `shared/trust.ts` `resolveTrustTier` for the
 * shared rule over the `plugin` source shape).
 */

import type { SkillBundle, SkillMeta, TrustTier } from '../domain/skill.js';

export interface SkillSource {
  /** Stable id for this source kind: 'github' | 'url' | 'claude-marketplace' | … */
  sourceId(): string;
  /** Metadata only — no bytes. Returns null if the identifier is unknown here. */
  inspect(identifier: string): Promise<SkillMeta | null>;
  /** The bytes (a SKILL.md + its bundle). Phase 7.2+; 7.1's impl returns null. */
  fetch(identifier: string): Promise<SkillBundle | null>;
  /**
   * Optional: search across this source's catalog. Multi-source adapters only
   * (7.4+); the single-marketplace fetcher (7.2) lists the whole catalog and
   * does not implement this.
   */
  search?(query: string, limit?: number): Promise<SkillMeta[]>;
  /**
   * Trust tier for a given identifier. Implementers should return `'community'`
   * unless they have a source-specific rule (e.g. github's `TRUSTED_REPOS`).
   */
  trustLevelFor(identifier: string): TrustTier;
}
