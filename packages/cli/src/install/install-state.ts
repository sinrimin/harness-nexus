// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * install-state ledger — a JSON record written on every `--apply`, enabling
 * future `doctor` (drift detection) / `repair` / `uninstall` (remove only
 * managed files). Mirrors ECC's `ecc.install.v1` ledger concept (see
 * `wiki research-phase-3-ecc-install-patterns.md` Pattern 5).
 *
 * Phase 3.3 only writes + reads the ledger; the doctor/repair/uninstall
 * subcommands come later.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { InstallPlan } from './types.js';

export const INSTALL_STATE_SCHEMA_VERSION = 'harness-nexus.install.v1';

/**
 * One ledger operation: the plan op plus the pre-install snapshot of the
 * destination file (`null` = the file did not exist). Snapshots live ONLY in
 * the ledger — plans stay pure — and are what `hnx uninstall` restores.
 */
export type LedgerOperation = InstallPlan['operations'][number] & {
  previousContent?: string | null;
};

export interface InstallState {
  schemaVersion: typeof INSTALL_STATE_SCHEMA_VERSION;
  installedAt: string;
  target: { id: string; target: string; kind: string; root: string };
  profile: { id: string; name: string; version: string };
  operations: LedgerOperation[];
}

/** Write the ledger to its path inside the target root. */
export function writeInstallState(
  plan: InstallPlan,
  state: Omit<InstallState, 'schemaVersion' | 'operations'>,
  operations: LedgerOperation[] = plan.operations,
): void {
  const full: InstallState = {
    schemaVersion: INSTALL_STATE_SCHEMA_VERSION,
    ...state,
    operations,
  };
  fs.mkdirSync(path.dirname(plan.installStatePath), { recursive: true });
  fs.writeFileSync(plan.installStatePath, `${JSON.stringify(full, null, 2)}\n`, 'utf8');
}

/** Read a previously-written ledger (returns null if absent). */
export function readInstallState(installStatePath: string): InstallState | null {
  if (!fs.existsSync(installStatePath)) return null;
  return JSON.parse(fs.readFileSync(installStatePath, 'utf8')) as InstallState;
}
