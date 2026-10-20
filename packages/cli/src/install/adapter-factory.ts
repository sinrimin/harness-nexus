// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * Target adapter factory — mirrors ECC's `createInstallTargetAdapter`
 * (`scripts/lib/install-targets/helpers.js`). A small config object yields a
 * frozen `TargetAdapter` with sensible defaults; adapters needing format
 * transformation override `planOperations`. Adding a target = one new file.
 *
 * See `wiki research-phase-3-ecc-install-patterns.md` Pattern 1–2.
 */
import os from 'node:os';
import path from 'node:path';
import type { AgentTarget } from '@harness-nexus/core';
import type {
  InstallPlan,
  Operation,
  ResolveInput,
  TargetAdapter,
  ValidationIssue,
} from './types.js';

export interface AdapterConfig {
  id: string;
  target: AgentTarget;
  kind: 'home' | 'project';
  /** Path segments under the home/project root (e.g. ['.hermes'], ['.codex']). */
  rootSegments: string[];
  /** Ledger filename written inside the target root. */
  installStateFilename?: string;
  /**
   * Override the default planOperations. The default writes a single
   * `write-file` op recording the profile metadata — real adapters replace this
   * with per-artifact emission.
   */
  planOperations?: (
    resolved: import('./types.js').ResolvedProfile,
    input: ResolveInput,
    adapter: TargetAdapter,
  ) => InstallPlan;
}

const DEFAULT_INSTALL_STATE_FILENAME = 'harness-nexus-install-state.json';

/**
 * Produce a frozen target adapter from a config. The default `planOperations`
 * emits a minimal `harness-nexus-profile.json` so the pipeline is exercisable
 * end-to-end before real adapters land (3.4+).
 */
export function createTargetAdapter(config: AdapterConfig): TargetAdapter {
  const installStateFilename = config.installStateFilename ?? DEFAULT_INSTALL_STATE_FILENAME;

  const adapter: TargetAdapter = {
    id: config.id,
    target: config.target,
    kind: config.kind,

    resolveRoot(input: ResolveInput = {}): string {
      if (input.outDir) return input.outDir;
      const base = input.homeDir ?? os.homedir();
      return path.join(base, ...config.rootSegments);
    },

    planOperations(resolved, input) {
      if (config.planOperations) return config.planOperations(resolved, input, adapter);
      return defaultPlanOperations(adapter, resolved, input, installStateFilename);
    },

    validate(input: ResolveInput = {}): ValidationIssue[] {
      const issues: ValidationIssue[] = [];
      if (config.kind === 'home' && !input.homeDir && !os.homedir()) {
        issues.push({
          severity: 'error',
          code: 'missing-home-dir',
          message: 'A home directory is required for home-scope install targets.',
        });
      }
      return issues;
    },
  };

  return Object.freeze(adapter);
}

/**
 * The default plan: write a single JSON metadata file describing the resolved
 * profile. This is NOT a real target format — it exists so the plan/apply
 * pipeline can be exercised end-to-end in 3.3 before any real adapter ships.
 * Real adapters override `planOperations` to emit their native layout.
 */
function defaultPlanOperations(
  adapter: TargetAdapter,
  resolved: import('./types.js').ResolvedProfile,
  input: ResolveInput,
  installStateFilename: string,
): InstallPlan {
  const targetRoot = adapter.resolveRoot(input);
  const installStatePath = path.join(targetRoot, installStateFilename);
  const profileMetaPath = path.join(targetRoot, 'harness-nexus-profile.json');

  const meta = {
    name: resolved.profile.name,
    target: resolved.profile.target,
    version: resolved.profile.version,
    entries: resolved.profile.entries.map((e) => ({ kind: e.kind, resourceId: e.resourceId })),
    artifactCount: resolved.artifacts.length,
  };

  const operations: Operation[] = [
    {
      kind: 'write-file',
      content: `${JSON.stringify(meta, null, 2)}\n`,
      destinationPath: profileMetaPath,
    },
  ];

  return {
    adapter: { id: adapter.id, target: adapter.target, kind: adapter.kind },
    targetRoot,
    installStatePath,
    operations,
    sensitive: false,
  };
}
