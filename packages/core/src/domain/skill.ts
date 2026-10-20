// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * Skill-sourcing domain types (Phase 7).
 *
 * These mirror the concepts in Hermes's `SkillSource` ABC and dataclasses
 * (`~/.hermes/hermes-agent/tools/skills_hub.py`), adapted to TypeScript. They
 * back the `SkillSource` port (`packages/core/src/ports/skill-source.ts`) used
 * by Phase 7.2+ fetchers and 7.4 multi-source adapters.
 *
 * Pure domain types only — no I/O, no framework imports.
 */

/**
 * User-visible trust tier for a sourced skill. Three surfaced tiers mirroring
 * Hermes's `INSTALL_POLICY` (the 4th, `agent-created`, is off-by-default in
 * Hermes and intentionally NOT modeled here):
 *   - `builtin`   — ships with the target tool (Harness Nexus owns none today).
 *   - `trusted`   — the 4 named repos in `TRUSTED_REPOS` (shared/trust.ts).
 *   - `community` — everything else (the default).
 */
export type TrustTier = 'builtin' | 'trusted' | 'community';

/**
 * Metadata for a skill discoverable through a `SkillSource`. Mirrors Hermes's
 * `SkillMeta` dataclass (skills_hub.py:130). Used by `inspect()` / `search()`.
 */
export interface SkillMeta {
  name: string;
  description: string;
  /** The `source_id` that produced this meta: 'github' | 'url' | 'claude-marketplace' | … */
  source: string;
  /** Source-specific identifier (e.g. 'anthropics/skills/skill-creator'). */
  identifier: string;
  trustLevel: TrustTier;
  repo?: string;
  path?: string;
  tags?: string[];
  /** Source-specific extras (category, author, homepage, …). */
  extra?: Record<string, unknown>;
}

/**
 * The materialized bytes of a skill. Mirrors Hermes's `SkillBundle`
 * dataclass (skills_hub.py:145). Returned by `fetch()`. One key must be
 * `SKILL.md` (validated at fetch/install time, not on this type).
 *
 * File content is `string | Uint8Array` (framework-agnostic; Node's `Buffer`
 * is a `Uint8Array` subclass so callers may pass either). core stays pure —
 * no Node `Buffer` reference here.
 */
export interface SkillBundle {
  name: string;
  /** Relative path → content. */
  files: Record<string, string | Uint8Array>;
  source: string;
  identifier: string;
  trustLevel: TrustTier;
  metadata?: Record<string, unknown>;
}
