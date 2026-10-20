// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * Target adapter registry. Each target adapter registers itself here; the
 * planner looks one up by `AgentTarget`. Mirrors ECC's
 * `scripts/lib/install-targets/registry.js`.
 *
 * Phase 3.3 ships only the stub `generic` adapter. Real adapters (hermes /
 * claude-code / codex) register here as they land (3.4–3.6). `zcode` has no
 * adapter → `getAdapter('zcode')` throws `TARGET_UNSUPPORTED`.
 */
import type { AgentTarget } from '@harness-nexus/core';
import { InstallError } from '../errors.js';
import type { TargetAdapter } from './types.js';
import { stubAdapter } from './adapters/stub.js';
import { hermesAdapter } from './adapters/hermes.js';
import { codexAdapter } from './adapters/codex.js';
import { deepseekAdapter } from './adapters/deepseek.js';
import { piAdapter } from './adapters/pi.js';

const ADAPTERS: readonly TargetAdapter[] = Object.freeze([
  stubAdapter,
  hermesAdapter,
  codexAdapter,
  deepseekAdapter,
  piAdapter,
]);

/** List every registered adapter (for `--help` / discovery). */
export function listAdapters(): readonly TargetAdapter[] {
  return ADAPTERS;
}

/** The targets that have an install adapter (excludes zcode). */
export function supportedTargets(): readonly AgentTarget[] {
  return ADAPTERS.map((a) => a.target);
}

/**
 * Look up an adapter by target. Throws `TARGET_UNSUPPORTED` if none is
 * registered (e.g. `zcode`).
 */
export function getAdapter(target: AgentTarget): TargetAdapter {
  const adapter = ADAPTERS.find((a) => a.target === target);
  if (!adapter) {
    throw new InstallError(
      `No install adapter for target '${target}' (supported: ${supportedTargets().join(', ')})`,
      'TARGET_UNSUPPORTED',
    );
  }
  return adapter;
}
