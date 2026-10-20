// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * Uninstaller — reverses an `hnx install --apply` using the install-state
 * ledger (Phase 3.5 loose ends; the ledger's "enabling uninstall" promise from
 * 3.3 finally cashed in).
 *
 * Semantics:
 *  - For every ledger operation, in REVERSE order (later writes depended on
 *    earlier ones, so undoing last-first restores the original state):
 *      destination had a pre-install snapshot → restore it;
 *      destination did not exist           → delete the file we created.
 *  - If the current file content differs from what we last wrote (the user
 *    edited it after install), the current content is preserved next to it as
 *    `<file>.hnx.bak` before restoring — user edits are never silently lost.
 *  - Empty directories created by the install are pruned up to (but excluding)
 *    the target root; the ledger file itself is removed last.
 *
 * This is why the Hermes adapter records its config.yaml merge as a single
 * write-file op with a full pre-merge snapshot (3.4): uninstall rolls the
 * `mcp_servers:` entries back without touching the user's other config —
 * unlike `hermes plugins remove`, which leaves stale config behind.
 */
import fs from 'node:fs';
import path from 'node:path';
import { InstallError } from '../errors.js';
import { readInstallState, type InstallState, type LedgerOperation } from './install-state.js';
import { getAdapter } from './registry.js';
import type { AgentTarget } from '@harness-nexus/core';
import type { ResolveInput } from './types.js';

/** What uninstall will do to one destination path. */
export interface UninstallStep {
  destinationPath: string;
  action: 'restore' | 'delete';
  /** Pre-install content to restore (null → the file is ours to delete). */
  previousContent: string | null;
  /** True when the current file was modified after our install (→ .hnx.bak). */
  conflicts: boolean;
  /** False when the file is already gone — nothing to do at apply time. */
  exists: boolean;
}

export interface UninstallPlan {
  targetRoot: string;
  installStatePath: string;
  profile: InstallState['profile'];
  installedAt: string;
  steps: UninstallStep[];
}

/** The exact bytes the install last wrote to a destination, for drift checks. */
function writtenContent(op: LedgerOperation): string {
  if (op.kind === 'write-file') return op.content;
  if (op.kind === 'merge-json') return `${JSON.stringify(op.mergePayload, null, 2)}\n`;
  return ''; // copy-file: drift check not meaningful; restore/delete regardless
}

/** Read the ledger for a target root and compute the reverse steps. */
export function planUninstall(opts: {
  target: AgentTarget;
  input?: ResolveInput;
}): UninstallPlan | null {
  const adapter = getAdapter(opts.target);
  const root = adapter.resolveRoot(opts.input ?? {});
  const installStatePath = path.join(root, 'harness-nexus-install-state.json');
  const state = readInstallState(installStatePath);
  if (!state) return null;

  const steps: UninstallStep[] = [];
  for (const op of [...state.operations].reverse()) {
    const exists = fs.existsSync(op.destinationPath);
    const current = exists ? fs.readFileSync(op.destinationPath, 'utf8') : null;
    const conflicts = exists && current !== null && current !== writtenContent(op);
    steps.push({
      destinationPath: op.destinationPath,
      action: op.previousContent != null ? 'restore' : 'delete',
      previousContent: op.previousContent ?? null,
      conflicts,
      exists,
    });
  }
  return {
    targetRoot: root,
    installStatePath,
    profile: state.profile,
    installedAt: state.installedAt,
    steps,
  };
}

/** Execute an uninstall plan (see module doc for semantics). */
export function applyUninstall(plan: UninstallPlan): number {
  let touched = 0;
  try {
    for (const step of plan.steps) {
      if (!step.exists) continue;
      if (step.conflicts) {
        fs.copyFileSync(step.destinationPath, `${step.destinationPath}.hnx.bak`);
      }
      if (step.action === 'restore') {
        fs.writeFileSync(step.destinationPath, step.previousContent as string, 'utf8');
      } else {
        fs.rmSync(step.destinationPath);
      }
      pruneEmptyDirs(path.dirname(step.destinationPath), plan.targetRoot);
      touched += 1;
    }
    if (fs.existsSync(plan.installStatePath)) {
      fs.rmSync(plan.installStatePath);
      touched += 1;
    }
  } catch (e) {
    throw new InstallError(
      `Failed to uninstall: ${(e as Error).message} (ledger left in place — re-run to continue)`,
      'APPLY_FAILED',
      e,
    );
  }
  return touched;
}

/** Remove empty directories from `dir` up to (excluding) `stop`. */
function pruneEmptyDirs(dir: string, stop: string): void {
  let current = path.resolve(dir);
  const top = path.resolve(stop);
  while (current.startsWith(top) && current !== top) {
    try {
      fs.rmdirSync(current); // fails with ENOTEMPTY if the dir has content — stop there
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}
