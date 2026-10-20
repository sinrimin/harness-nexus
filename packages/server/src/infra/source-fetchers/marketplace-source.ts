// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { SkillBundle, SkillMeta, SkillSource } from '@harness-nexus/core';
import {
  marketplacePluginToResourceSource,
  resolveTrustTier,
  type MarketplacePlugin,
} from '@harness-nexus/shared';
import type { SkillCatalogService } from './catalog-service.js';
import type { MarketplaceEntry } from './allowlist.js';

/**
 * MarketplaceSource (Phase 7.4) — adapts 7.2's `SkillCatalogService` (single-
 * marketplace catalog fetch) into the multi-source `SkillSource` interface so
 * configured marketplaces contribute to the unified search. The 7.2 catalog
 * cache is reused unchanged — no duplicate fetching.
 *
 * This is the same mechanism as Hermes's `ClaudeMarketplaceSource`
 * (`skills_hub.py:2607`): read `.claude-plugin/marketplace.json`, expose its
 * entries as `SkillMeta`. Trust is computed from the entry's source repo owner
 * (`resolveTrustTier`).
 */

export interface MarketplaceSourceOptions {
  catalog: SkillCatalogService;
  allowlist: MarketplaceEntry[];
}

export class MarketplaceSource implements SkillSource {
  private readonly catalog: SkillCatalogService;
  private readonly allowlist: MarketplaceEntry[];

  constructor(opts: MarketplaceSourceOptions) {
    this.catalog = opts.catalog;
    this.allowlist = opts.allowlist;
  }

  sourceId(): string {
    return 'marketplace';
  }

  async search(query: string, limit = 50): Promise<SkillMeta[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const results: SkillMeta[] = [];
    for (const mkt of this.allowlist) {
      let plugins: MarketplacePlugin[];
      try {
        plugins = await this.catalog.listPlugins(mkt.id, mkt.url, { q });
      } catch {
        // 7.2 catalog fetch errors (502) are already logged inside; a failed
        // marketplace contributes nothing to the unified search.
        continue;
      }
      for (const p of plugins) {
        results.push(this.toMeta(mkt.id, p));
        if (results.length >= limit) return results;
      }
    }
    return results;
  }

  async inspect(): Promise<SkillMeta | null> {
    return null;
  }

  async fetch(): Promise<SkillBundle | null> {
    return null;
  }

  trustLevelFor(): 'community' {
    return 'community'; // per-result trust is computed in toMeta (varies by entry)
  }

  private toMeta(marketplaceId: string, p: MarketplacePlugin): SkillMeta {
    return {
      name: p.displayName ?? p.name,
      description: p.description,
      source: this.sourceId(),
      // Namespace by marketplace id so cross-marketplace name collisions don't
      // dedupe away distinct entries.
      identifier: `${marketplaceId}:${p.name}`,
      trustLevel: resolveTrustTier(p.source),
      extra: {
        marketplace: marketplaceId,
        pluginName: p.name,
        category: p.category,
        homepage: p.homepage,
        author: p.author?.name,
        pluginSource: marketplacePluginToResourceSource(p),
      },
    };
  }
}
