// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { FastifyBaseLogger } from 'fastify';
import type { SkillBundle, SkillMeta, SkillSource } from '@harness-nexus/core';
import type { PluginResourceSource } from '@harness-nexus/shared';
import { assertPublicHttpUrl, readBodyCapped } from '../egress.js';
import type { MarketplaceFetcher } from './types.js';

/**
 * WellKnownSkillSource (Phase 7.4) — discovers skills via the
 * `/.well-known/skills/index.json` protocol. Mirrors Hermes's
 * `WellKnownSkillSource` (`skills_hub.py:1092`). Only handles URL-form queries
 * (`https://host` / `http://host[:port]`); it does NOT auto-discover hosts from
 * a free-text query — the user supplies the host.
 *
 * No auth. Always `community` trust. The discovery protocol: GET
 * `https://<host>/.well-known/skills/index.json` →
 * `{ skills: [{ name, description, files }] }`.
 *
 * #21: the query is a user-supplied URL, so the host must pass the egress
 * guard (public-only) and the index fetch is time-boxed and size-capped.
 */

/** Timeout + size cap for the index fetch (#21). */
const FETCH_TIMEOUT_MS = 5000;
const MAX_INDEX_BYTES = 2 * 1024 * 1024;

export interface WellKnownSourceOptions {
  fetcher?: MarketplaceFetcher;
  logger: FastifyBaseLogger;
}

interface WellKnownIndex {
  skills?: Array<{ name: string; description?: string; files?: string[] }>;
}

export class WellKnownSource implements SkillSource {
  private readonly fetcher: MarketplaceFetcher;
  private readonly log: FastifyBaseLogger;

  constructor(opts: WellKnownSourceOptions) {
    this.fetcher = opts.fetcher ?? globalThis.fetch;
    this.log = opts.logger;
  }

  sourceId(): string {
    return 'well-known';
  }

  async search(query: string, limit = 50): Promise<SkillMeta[]> {
    const q = query.trim();
    // Only URL-form queries make sense (we need a host to probe).
    if (!/^https?:\/\//i.test(q)) return [];
    let base: URL;
    try {
      base = await assertPublicHttpUrl(q);
    } catch (err) {
      this.log.warn({ query: q.slice(0, 100), err }, 'well-known source: host rejected');
      return [];
    }
    const indexUrl = `${base.origin}/.well-known/skills/index.json`;
    let index: WellKnownIndex | null = null;
    try {
      const res = await this.fetcher(indexUrl, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return [];
      index = JSON.parse(await readBodyCapped(res, MAX_INDEX_BYTES)) as WellKnownIndex;
    } catch (err) {
      this.log.warn({ indexUrl, err }, 'well-known index fetch failed');
      return [];
    }
    const skills = index.skills ?? [];
    const metas: SkillMeta[] = skills.slice(0, limit).map((s) => {
      const skillUrl = `${base.origin}/${s.name}/SKILL.md`;
      const pluginSource: PluginResourceSource = {
        type: 'plugin',
        // well-known skills don't fit git-subdir/url/npm cleanly; a single-file
        // SKILL.md at a direct URL maps to the `url` plugin-source kind.
        source: { source: 'url', url: skillUrl },
        plugin: s.name,
      };
      return {
        name: s.name,
        description: s.description ?? '',
        source: this.sourceId(),
        identifier: `well-known:${base.origin}/${s.name}`,
        trustLevel: 'community' as const,
        extra: { pluginSource },
      };
    });
    return metas;
  }

  async inspect(): Promise<SkillMeta | null> {
    return null;
  }

  async fetch(): Promise<SkillBundle | null> {
    return null;
  }

  trustLevelFor(): 'community' {
    return 'community';
  }
}
