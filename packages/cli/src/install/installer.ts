// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * Installer — materializes an `InstallPlan` to disk and writes the install-state
 * ledger. Mirrors ECC's `applyInstallPlan`
 * (`scripts/lib/install/apply.js`). Three operation kinds:
 *  - `copy-file`  — copy a resolved artifact verbatim.
 *  - `write-file` — write adapter-generated inline content.
 *  - `merge-json` — deep-merge a JSON value into an existing config file.
 *
 * If the plan is `sensitive` (carries decrypted direct-mode credentials), the
 * target root is chmod'd to 0700.
 */
import fs from 'node:fs';
import path from 'node:path';
import { InstallError } from '../errors.js';
import { writeInstallState, type LedgerOperation } from './install-state.js';
import type { InstallPlan, Operation } from './types.js';

/** True for plain objects (not arrays/null) — used by deepMergeJson. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merge `patch` into `base` (objects recurse; non-objects replace). */
export function deepMergeJson(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return structuredClone(patch);
  const merged: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    merged[k] =
      isPlainObject(v) && isPlainObject(merged[k])
        ? deepMergeJson(merged[k], v)
        : structuredClone(v);
  }
  return merged;
}

/** Capture the destination's pre-install content for the ledger (null = absent). */
function snapshot(op: Operation): LedgerOperation {
  const previousContent = fs.existsSync(op.destinationPath)
    ? fs.readFileSync(op.destinationPath, 'utf8')
    : null;
  return { ...op, previousContent };
}

function applyOperation(op: Operation): void {
  fs.mkdirSync(path.dirname(op.destinationPath), { recursive: true });

  switch (op.kind) {
    case 'copy-file':
      fs.copyFileSync(op.sourcePath, op.destinationPath);
      break;
    case 'write-file':
      fs.writeFileSync(op.destinationPath, op.content, 'utf8');
      break;
    case 'merge-json': {
      const existing = fs.existsSync(op.destinationPath)
        ? (JSON.parse(fs.readFileSync(op.destinationPath, 'utf8')) as unknown)
        : {};
      const merged = deepMergeJson(existing, op.mergePayload);
      fs.writeFileSync(op.destinationPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
      break;
    }
  }
}

/**
 * Materialize a plan to disk. Creates parent dirs, writes every operation, then
 * records the install-state ledger — each ledger op carrying the pre-install
 * snapshot of its destination (`null` if absent), which is what
 * `hnx uninstall` restores. If the plan is sensitive, the target root gets
 * restrictive permissions (0700).
 */
export function applyInstall(
  plan: InstallPlan,
  meta: { profileId: string; profileName: string; profileVersion: string },
): void {
  // #21: containment pre-flight — every operation must land inside the plan's
  // target root, checked BEFORE anything is written. Resource names and
  // bundle keys join paths in the adapters; this is the single choke point
  // that keeps a crafted `..`/absolute component from escaping the install
  // directory no matter which adapter built the plan.
  const root = path.resolve(plan.targetRoot);
  for (const op of plan.operations) {
    const dest = path.resolve(op.destinationPath);
    if (dest !== root && !dest.startsWith(root + path.sep)) {
      throw new InstallError(
        `Refusing to write outside the install root: ${op.destinationPath}`,
        'UNSAFE_DESTINATION',
      );
    }
  }

  const ledgerOps: LedgerOperation[] = [];
  try {
    for (const op of plan.operations) {
      ledgerOps.push(snapshot(op));
      applyOperation(op);
    }
  } catch (e) {
    throw new InstallError(
      `Failed to write ${plan.operations.length} operations: ${(e as Error).message}`,
      'APPLY_FAILED',
      e,
    );
  }

  writeInstallState(
    plan,
    {
      installedAt: new Date().toISOString(),
      target: {
        id: plan.adapter.id,
        target: plan.adapter.target,
        kind: plan.adapter.kind,
        root: plan.targetRoot,
      },
      profile: { id: meta.profileId, name: meta.profileName, version: meta.profileVersion },
    },
    ledgerOps,
  );

  if (plan.sensitive) {
    try {
      fs.chmodSync(plan.targetRoot, 0o700);
    } catch {
      // chmod best-effort (e.g. on some filesystems); the warning is printed by the caller.
    }
  }
}
