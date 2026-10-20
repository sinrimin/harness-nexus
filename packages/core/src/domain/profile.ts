// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { AgentTarget, ResourceKind } from './resource.js';

/**
 * A Profile is a named, versioned bundle combining resources (MCP servers,
 * skills, hooks, sub-agents, rules) plus optional third-party harness packages
 * (e.g. ECC, Superpower). One-click install applies one or more profiles to a
 * target Agent tool.
 */
export interface Profile {
  id: string;
  /** Human-readable name, e.g. "Frontend Daily". */
  name: string;
  description?: string;
  /** Semver of the profile manifest itself. */
  version: string;
  /**
   * Single Agent tool this profile is shaped for (Phase 3.2). Immutable
   * post-create — the install pipeline (3.3) reads it to pick the target
   * writer, and the creation form narrows offered resources/hook events by it.
   * Migrating to a different tool is by cross-target import (3.4), not by
   * mutating this field (PATCH target → 409 TARGET_IMMUTABLE).
   */
  target: AgentTarget;
  scope: 'global' | 'personal';
  ownerId: string | null;
  entries: ProfileEntry[];
  /** Imported third-party harness release packages bundled into this profile. */
  imports?: ProfileImport[];
  createdAt: string;
  updatedAt: string;
}

/** A reference to a resource included in a profile, optionally pinned. */
export interface ProfileEntry {
  /** Either an internal Resource id or a `kind:key` reference. */
  resourceId: string;
  kind: ResourceKind;
  /** Optional version pin; omit to float to latest. */
  pinnedVersion?: string;
  /** Target-specific install overrides (e.g. an MCP server config fragment). */
  installOptions?: Record<string, unknown>;
}

/** A third-party harness package (ECC, Superpower, …) pulled into a profile. */
export interface ProfileImport {
  /** Origin kind, used to pick the right adapter. */
  origin: 'ecc' | 'superpower' | 'custom';
  /** Release artifact URL or local path. */
  source: string;
  /** Optional checksum for integrity verification. */
  checksum?: string;
}
