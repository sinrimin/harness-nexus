// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * Domain entities for Harness Nexus.
 *
 * This package is intentionally pure: no `import` of Fastify, the MCP SDK, or any
 * storage driver is allowed here. Concrete repository implementations live in
 * `@harness-nexus/server` under `infra/storage/*`. See `ports/` for the contracts.
 *
 * NOTE: These types are skeleton placeholders. Fields will evolve as modules are
 * implemented; keep them aligned with `packages/shared/src/schemas/*`.
 */

/** The kinds of managed assets an Agent tool can consume. */
export type ResourceKind = 'skill' | 'hook' | 'sub_agent' | 'rule' | 'mcp' | 'command';

/**
 * Tools a resource/profile can be installed into. Phase 3 priority order is
 * hermes → claude-code → codex → deepseek (3.8-a); `generic` is a placeholder.
 * `zcode` stays in the union (non-breaking) but has NO install adapter —
 * `hnx install --target zcode` is rejected (409 TARGET_UNSUPPORTED) until a
 * reference surface revives it. Mirrored in `@harness-nexus/shared`
 * (`schemas/profile.ts`); update both together. See
 * `wiki research-phase-3-ecc-install-patterns.md` +
 * `wiki research-phase-8-t1-deepseek-harness.md`.
 */
export type AgentTarget =
  'claude-code' | 'zcode' | 'hermes' | 'codex' | 'deepseek' | 'opencode' | 'pi' | 'generic';

/** Visibility/scope. `global` is admin-managed; `personal` is per-user. */
export type ResourceScope = 'global' | 'personal';

/**
 * A single installable asset (a skill, a hook script, an MCP server definition, …).
 * Binary/script contents are referenced by `source`, not embedded.
 */
export interface Resource {
  id: string;
  /** Stable identifier within the instance, e.g. "skill:docx". */
  key: string;
  kind: ResourceKind;
  name: string;
  description?: string;
  /** Version of the asset itself (semver-ish), independent of packaging. */
  version: string;
  /** Where the asset bytes live: a git ref, tarball URL, or local path. */
  source: ResourceSource;
  scope: ResourceScope;
  /** Owner user id; null for global resources. */
  ownerId: string | null;
  /** Target tools this resource is compatible with. */
  targets: AgentTarget[];
  labels?: Record<string, string>;
  /**
   * Two-stage delete (2026-09): soft-deleted first — hidden from management
   * lists, greyed in profile editors (saving strips it), skipped by every
   * deploy path; physically removed by a second DELETE once no profile
   * references it. Absent = live.
   */
  deletedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type ResourceSource =
  | { type: 'git'; url: string; ref?: string; path?: string }
  | { type: 'tarball'; url: string; checksum?: string }
  | { type: 'local'; path: string }
  | { type: 'inline'; content: string }
  | { type: 'inline-bundle'; files: Record<string, string> }
  // Phase 7.1 — a marketplace/plugin skill reference. Skills bundle inside
  // plugins in the CC/ZCode world; this variant preserves the plugin namespace
  // and the source-kind distinction that `git` cannot express. See
  // `wiki design-phase-7.1-plugin-source.md` Part 1a.
  | {
      type: 'plugin';
      /**
       * Mirrors the CC marketplace.json `source` kinds (research-corrected: 4
       * live kinds in the official catalog — url / git-subdir / string-path /
       * github; no npm in production, modeled for completeness). The string
       * relative-path form (`"./plugins/foo"`) is NOT accepted here — it only
       * makes sense inside a marketplace repo; Harness Nexus stores resolved specs.
       */
      source:
        | { source: 'github'; repo: string; ref?: string; sha?: string; path?: string }
        | { source: 'url'; url: string; ref?: string; sha?: string; path?: string }
        | {
            source: 'git-subdir';
            url: string;
            path: string;
            ref?: string;
            sha?: string;
          }
        | { source: 'npm'; package: string; version: string; registry?: string };
      /** The plugin this entry resolves to (the `plugin:skill` namespace half). */
      plugin: string;
      /**
       * Optional marketplace-entry version pin. Falls back to `sha` (for git
       * kinds) or the resolved git commit at install time. Absent ⇒ floating,
       * tracked to `ref` (default branch).
       */
      version?: string;
    };
