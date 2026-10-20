// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * Stub adapter — a placeholder for `target: 'generic'`. It uses the factory's
 * default `planOperations`, which writes a minimal `harness-nexus-profile.json`
 * metadata file. This exists so the plan/apply pipeline is exercisable
 * end-to-end in Phase 3.3 before any real target adapter ships (3.4+).
 *
 * Real adapters (hermes / claude-code / codex) override `planOperations` to
 * emit their native layout. This stub intentionally does NOT emit any real
 * target format.
 *
 * NOTE: `generic` is the only registered adapter in 3.3. A profile with
 * `target: 'hermes'` will hit `TARGET_UNSUPPORTED` until the Hermes adapter
 * lands (3.4) — that's expected; the stub is a pipeline demonstrator only.
 */
import { createTargetAdapter } from '../adapter-factory.js';

export const stubAdapter = createTargetAdapter({
  id: 'generic-stub',
  target: 'generic',
  kind: 'home',
  rootSegments: ['.harness-nexus'],
});
