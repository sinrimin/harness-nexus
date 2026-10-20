// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * Planner — resolves a target adapter, validates input, and asks the adapter to
 * plan file operations. Produces an `InstallPlan` with NO filesystem writes
 * (the dry-run artifact). Mirrors ECC's `planInstallTargetScaffold`.
 *
 * The target resolution rules (from `wiki design-phase-3-install.md`):
 *  - If `target` is given and the profile is target-bound and they differ →
 *    `TARGET_MISMATCH`.
 *  - If `target` is omitted, use the profile's own target.
 *  - `zcode` (and any unregistered target) → `TARGET_UNSUPPORTED` (from registry).
 */
import type { AgentTarget } from '@harness-nexus/core';
import { InstallError } from '../errors.js';
import { getAdapter } from './registry.js';
import type { InstallPlan, ResolvedProfile, ResolveInput } from './types.js';

export interface PlanOptions {
  /** Explicit --target override; falls back to the profile's own target. */
  target?: AgentTarget;
  /** Passthrough to the adapter (outDir / homeDir). */
  input?: ResolveInput;
}

/** Resolve the effective target, enforcing the mismatch rule. */
function resolveTarget(profile: ResolvedProfile, requested?: AgentTarget): AgentTarget {
  if (requested && requested !== profile.profile.target) {
    throw new InstallError(
      `Target '${requested}' does not match profile's target '${profile.profile.target}' (target is immutable; create a new profile or import instead)`,
      'TARGET_MISMATCH',
    );
  }
  return requested ?? profile.profile.target;
}

/**
 * Plan an install: pick the adapter, validate, and produce the operation list.
 * Does NOT write anything — the caller prints the plan (dry-run) or passes it
 * to `applyInstall`.
 */
export function planInstall(resolved: ResolvedProfile, opts: PlanOptions = {}): InstallPlan {
  const target = resolveTarget(resolved, opts.target);
  const adapter = getAdapter(target);

  const issues = adapter.validate(opts.input ?? {});
  const blocking = issues.filter((i) => i.severity === 'error');
  if (blocking.length > 0) {
    throw new InstallError(blocking.map((i) => i.message).join('; '), 'VALIDATION_FAILED');
  }

  return adapter.planOperations(resolved, opts.input ?? {});
}
