// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { FastifyBaseLogger } from 'fastify';
import {
  AppError,
  marketplaceCatalogSchema,
  marketplacePluginSchema,
  type MarketplaceCatalog,
  type MarketplacePlugin,
} from '@harness-nexus/shared';
import type { MarketplaceFetcher } from './types.js';

/**
 * SkillCatalogService (Phase 7.2) — fetches, parses, and caches a marketplace
 * `marketplace.json` for the hub browse API. This is the server's first
 * outbound HTTP path; the allowlist + timeout bound that surface (see
 * `allowlist.ts` and `config.marketplaceFetchTimeoutMs`).
 *
 * Two patterns established here for the first time in the codebase (mirroring
 * the closest existing precedent, `McpRegistry`):
 *   1. Lazy TTL cache — `Map<id, { catalog, expiresAt }>`; expired entries are
 *      refetched on read. No `setTimeout` eviction (keeps the model simple).
 *   2. Per-key in-flight dedup — concurrent `getCatalog(sameId)` calls share
 *      one fetch promise, mirroring `McpRegistry.reloadPromise`.
 *
 * The fetcher is injectable: production passes `globalThis.fetch`; tests (and
 * the smoke script via `MARKETPLACE_FIXTURE_PATH`) pass a fixture reader so CI
 * never hits GitHub.
 */

export interface SkillCatalogServiceOptions {
  /** Outbound fetch implementation. Defaults to `globalThis.fetch`. */
  fetcher?: MarketplaceFetcher;
  /** Cache TTL in milliseconds. Defaults to 1 hour. */
  ttlMs?: number;
  /** Per-fetch timeout in milliseconds. Defaults to 10 seconds. */
  timeoutMs?: number;
  logger: FastifyBaseLogger;
}

interface CacheEntry {
  catalog: MarketplaceCatalog;
  /** epoch ms after which the entry is stale. */
  expiresAt: number;
}

export class SkillCatalogService {
  private readonly fetcher: MarketplaceFetcher;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly log: FastifyBaseLogger;
  private readonly cache = new Map<string, CacheEntry>();
  /** Per-id in-flight fetch promises (dedup). */
  private readonly inflight = new Map<string, Promise<MarketplaceCatalog>>();

  constructor(opts: SkillCatalogServiceOptions) {
    this.fetcher = opts.fetcher ?? globalThis.fetch;
    this.ttlMs = opts.ttlMs ?? 60 * 60 * 1000;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.log = opts.logger;
  }

  /**
   * Get the parsed catalog for a marketplace, fetching (and caching) if needed.
   * Throws `AppError(502, 'MARKETPLACE_FETCH_FAILED')` on network or non-200
   * responses; zod errors parsing the top-level shape also surface as 502.
   */
  async getCatalog(id: string, url: string): Promise<MarketplaceCatalog> {
    const cached = this.cache.get(id);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.catalog;
    }
    // Dedup concurrent fetches for the same id (mirrors McpRegistry.reloadPromise).
    const existing = this.inflight.get(id);
    if (existing) return existing;

    const promise = this.fetchAndParse(id, url).finally(() => this.inflight.delete(id));
    this.inflight.set(id, promise);
    return promise;
  }

  /**
   * List the plugins in a marketplace, filtered by optional `category` and
   * free-text `q` (matched against name/description, case-insensitive).
   */
  async listPlugins(
    id: string,
    url: string,
    filter?: { category?: string; q?: string },
  ): Promise<MarketplacePlugin[]> {
    const catalog = await this.getCatalog(id, url);
    const q = filter?.q?.trim().toLowerCase();
    const cat = filter?.category?.trim().toLowerCase();
    return catalog.plugins.filter((p) => {
      if (cat && (p.category?.toLowerCase() ?? '') !== cat) return false;
      if (q) {
        const haystack = `${p.name} ${p.description}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }

  private async fetchAndParse(id: string, url: string): Promise<MarketplaceCatalog> {
    let body: string;
    try {
      const res = await this.fetcher(url, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) {
        throw new AppError(
          `Marketplace "${id}" fetch returned HTTP ${res.status}`,
          502,
          'MARKETPLACE_FETCH_FAILED',
        );
      }
      body = await res.text();
    } catch (err) {
      if (err instanceof AppError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      this.log.warn({ id, url, err }, 'marketplace fetch failed');
      throw new AppError(
        `Marketplace "${id}" fetch failed: ${message}`,
        502,
        'MARKETPLACE_FETCH_FAILED',
      );
    }

    // Parse top-level shape first (rejects a non-marketplace response body).
    // `marketplaceCatalogSchema.plugins` is `unknown[]` so the string-source
    // entries don't fail the whole parse; they're filtered per-piece below.
    const parsed = marketplaceCatalogSchema.safeParse(JSON.parse(body));
    if (!parsed.success) {
      this.log.warn({ id, url, err: parsed.error }, 'marketplace parse failed');
      throw new AppError(
        `Marketplace "${id}" returned an unparseable catalog`,
        502,
        'MARKETPLACE_FETCH_FAILED',
      );
    }

    // Per-plugin validate: drop entries whose `source` is the string
    // relative-path form (not modeled by marketplaceSourceSchema) instead of
    // failing the whole catalog. ~30 of ~257 live official entries are these.
    const plugins: MarketplacePlugin[] = [];
    for (const raw of parsed.data.plugins) {
      const ok = marketplacePluginSchema.safeParse(raw);
      if (ok.success) plugins.push(ok.data);
    }

    const catalog: MarketplaceCatalog = { ...parsed.data, plugins };
    this.cache.set(id, { catalog, expiresAt: Date.now() + this.ttlMs });
    return catalog;
  }
}

// ---- Fastify type augmentation for the decorated catalog service ----
declare module 'fastify' {
  interface FastifyInstance {
    skillCatalog: SkillCatalogService;
  }
}
