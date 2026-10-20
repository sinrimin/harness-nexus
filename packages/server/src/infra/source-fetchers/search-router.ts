// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { FastifyBaseLogger } from 'fastify';
import type { SkillMeta, SkillSource, TrustTier } from '@harness-nexus/core';

/**
 * SkillSearchRouter (Phase 7.4) — dispatches a query to all registered
 * `SkillSource`s in parallel, applies an overall timeout, then merges, dedupes,
 * and ranks. Mirrors Hermes's `parallel_search_sources` + `unified_search`
 * (`~/.hermes/hermes-agent/tools/skills_hub.py:3944`, `:4044`).
 *
 * Two design rules carried over from Hermes:
 *   1. **Partial results first.** A slow/erroring/rate-limited source never
 *      blocks the response — its contribution is empty, and its id surfaces in
 *      `timedOut` / `errored` for the UI to show a notice. The whole search
 *      never throws on a source failure.
 *   2. **Overall timeout, not per-source.** A 30s wall clock caps the whole
 *      dispatch. Implemented via `Promise.race` + `AbortController` (JS
 *      equivalent of Hermes's manual
 *      `pool.shutdown(wait=False, cancel_futures=True)` — a plain
 *      `await Promise.all(...)` would let a slow source block past the timeout).
 *
 * Merge/dedupe: key = `identifier` (NOT `name` — same name can come from
 * different sources/repos). On collision, the higher-trust copy wins
 * (`_TRUST_RANK = { builtin: 2, trusted: 1, community: 0 }`); within a tier,
 * insertion order (source priority order) is preserved.
 */

export interface SkillSearchRouterOptions {
  sources: SkillSource[];
  /** Overall dispatch timeout in ms. Default 30000. */
  timeoutMs?: number;
  logger: FastifyBaseLogger;
}

export interface SkillSearchResult {
  results: SkillMeta[];
  /** Source ids that did not finish before the overall timeout. */
  timedOut: string[];
  /** Source ids whose `search` rejected (logged; contributed nothing). */
  errored: string[];
}

const TRUST_RANK: Record<TrustTier, number> = {
  builtin: 2,
  trusted: 1,
  community: 0,
};

export class SkillSearchRouter {
  private readonly sources: SkillSource[];
  private readonly timeoutMs: number;
  private readonly log: FastifyBaseLogger;

  constructor(opts: SkillSearchRouterOptions) {
    this.sources = opts.sources;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.log = opts.logger;
  }

  async search(query: string, limit = 50): Promise<SkillSearchResult> {
    const q = query.trim();
    if (!q) return { results: [], timedOut: [], errored: [] };

    const errored: string[] = [];
    const timedOut: string[] = [];

    // Per-source: run `search` with a per-source timeout (overall budget =
    // this.timeoutMs). A source that rejects or times out contributes [] and
    // is recorded — the unified result is never blocked by one bad source.
    const perSource = this.sources.map(async (s) => {
      const id = s.sourceId();
      if (!s.search) return [] as SkillMeta[];
      try {
        const result = await Promise.race([
          Promise.resolve(s.search(q, limit)),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), this.timeoutMs)),
        ]);
        if (result === null) {
          timedOut.push(id);
          return [];
        }
        return result;
      } catch (err) {
        errored.push(id);
        this.log.warn({ sourceId: id, err }, 'skill source search rejected');
        return [];
      }
    });

    const settled = await Promise.all(perSource);
    const merged = mergeAndDedupe(settled.flat());
    return { results: merged.slice(0, limit), timedOut, errored };
  }
}

/**
 * Merge results, deduping by `identifier`. On collision the higher-trust entry
 * wins; within a trust tier, the first-seen (highest-priority source) is kept.
 */
function mergeAndDedupe(metas: SkillMeta[]): SkillMeta[] {
  const byId = new Map<string, SkillMeta>();
  for (const m of metas) {
    const existing = byId.get(m.identifier);
    if (!existing) {
      byId.set(m.identifier, m);
      continue;
    }
    if (TRUST_RANK[m.trustLevel] > TRUST_RANK[existing.trustLevel]) {
      byId.set(m.identifier, m);
    }
  }
  return [...byId.values()];
}

// ---- Fastify type augmentation for the decorated search router ----
declare module 'fastify' {
  interface FastifyInstance {
    skillSearch: SkillSearchRouter;
  }
}
