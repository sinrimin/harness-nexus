// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { SkillSource } from '@harness-nexus/core';

/**
 * Phase 7.1 no-op `SkillSource` implementation. Its only job is to prove the
 * port shape compiles and round-trips — it is NOT wired to any route (there is
 * no source registry yet; that arrives with Phase 7.2's marketplace fetch
 * endpoint). Real adapters (`github`, `url`, `claude-marketplace`, …) land in
 * 7.2 / 7.4 alongside the routes that use them.
 */
export class NoopSkillSource implements SkillSource {
  sourceId(): string {
    return 'noop';
  }

  async inspect(): Promise<null> {
    return null;
  }

  async fetch(): Promise<null> {
    return null;
  }

  // `search` is optional on the port — omitted.

  trustLevelFor(): 'community' {
    // Default tier per the port contract. Real adapters override when they
    // have a source-specific rule (see `resolveTrustTier` in @harness-nexus/shared).
    return 'community';
  }
}
