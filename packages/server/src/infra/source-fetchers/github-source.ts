// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { FastifyBaseLogger } from 'fastify';
import type { SkillBundle, SkillMeta, SkillSource } from '@harness-nexus/core';
import { resolveTrustTier, type PluginResourceSource } from '@harness-nexus/shared';
import type { MarketplaceFetcher } from './types.js';

/**
 * GitHubSource (Phase 7.4) — searches curated "taps" (GitHub repos) for skills
 * by walking each repo's recursive file tree (one API call per tap, vs the
 * naive per-directory approach that blows the rate limit). Mirrors Hermes's
 * `GitHubSource` (`~/.hermes/hermes-agent/tools/skills_hub.py:507`), trimmed to
 * the `search` path (`inspect`/`fetch` return null here — install-time fetch is
 * Phase 3.3's job).
 *
 * Trust: `resolveTrustTier({ source: 'github', repo })` — the 4 default taps
 * are exactly `TRUSTED_REPOS`, so default-tap results surface as `trusted`.
 *
 * Rate-limit handling: a 403/429 from GitHub logs a warning and the source
 * contributes an empty result for that tap (partial-results-first, matching
 * Hermes). No throw — the parallel search router still returns other sources.
 *
 * Auth: optional `GITHUB_TOKEN` (5000 req/hr authenticated vs 60/hr anonymous).
 * Hermes's `gh auth token` subprocess + GitHub App fallbacks are deliberately
 * not ported — too heavy for Harness Nexus; a user with a token sets the env.
 */

export interface GitHubTap {
  /** `owner/repo` (no scheme). */
  repo: string;
  /** Optional subdirectory to narrow the tree scan. */
  path?: string;
}

export interface GitHubSourceOptions {
  fetcher?: MarketplaceFetcher;
  /** Optional GitHub PAT; anonymous (60 req/hr) when absent. */
  token?: string | undefined;
  /** Repos to scan. Defaults to the 4 `TRUSTED_REPOS`. */
  taps?: GitHubTap[];
  logger: FastifyBaseLogger;
}

interface TreeCacheEntry {
  /** Directory paths containing a SKILL.md (relative to repo root). */
  dirs: string[];
  /** epoch ms after which the tree is refetched. */
  expiresAt: number;
}

const TREE_CACHE_TTL_MS = 60 * 60 * 1000; // 1h — trees change rarely
const DEFAULT_TAPS: GitHubTap[] = [
  { repo: 'openai/skills' },
  { repo: 'anthropics/skills' },
  { repo: 'huggingface/skills' },
  { repo: 'NVIDIA/skills' },
];

interface GitHubTreeEntry {
  path: string;
  type: string;
}

interface GitHubTreeResponse {
  tree?: GitHubTreeEntry[];
  truncated?: boolean;
  message?: string; // present on error
}

export class GitHubSource implements SkillSource {
  private readonly fetcher: MarketplaceFetcher;
  private readonly token: string | undefined;
  private readonly taps: GitHubTap[];
  private readonly log: FastifyBaseLogger;
  private readonly treeCache = new Map<string, TreeCacheEntry>();

  constructor(opts: GitHubSourceOptions) {
    this.fetcher = opts.fetcher ?? globalThis.fetch;
    this.token = opts.token;
    this.taps = opts.taps ?? DEFAULT_TAPS;
    this.log = opts.logger;
  }

  sourceId(): string {
    return 'github';
  }

  async search(query: string, limit = 50): Promise<SkillMeta[]> {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const results: SkillMeta[] = [];
    for (const tap of this.taps) {
      const dirs = await this.getSkillDirs(tap);
      for (const dir of dirs) {
        // The directory name is the skill name (matches Hermes + the CC plugin
        // convention `skills/<name>/SKILL.md`).
        const name = dir.split('/').pop() ?? dir;
        if (!name.toLowerCase().includes(q)) continue;
        results.push(this.toMeta(tap.repo, dir, name));
        if (results.length >= limit) return results;
      }
    }
    return results;
  }

  async inspect(): Promise<SkillMeta | null> {
    return null; // 7.4 ships search only; inspect arrives with install-time fetch (Phase 3.3)
  }

  async fetch(): Promise<SkillBundle | null> {
    return null; // materialization is Phase 3.3
  }

  trustLevelFor(identifier: string): ReturnType<SkillSource['trustLevelFor']> {
    // identifier shape: `owner/repo[/path]` — extract `owner/repo` for trust.
    const parts = identifier.split('/');
    if (parts.length >= 2) {
      const repo = `${parts[0]}/${parts[1]}`;
      return resolveTrustTier({ source: 'github', repo });
    }
    return 'community';
  }

  /** Fetch + cache the recursive tree, then return dirs containing SKILL.md. */
  private async getSkillDirs(tap: GitHubTap): Promise<string[]> {
    const cached = this.treeCache.get(tap.repo);
    if (cached && cached.expiresAt > Date.now()) {
      return this.filterByTapPath(cached.dirs, tap.path);
    }

    const url = `https://api.github.com/repos/${tap.repo}/git/trees/HEAD?recursive=1`;
    let tree: GitHubTreeResponse | null = null;
    try {
      const res = await this.fetcher(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
      });
      if (res.status === 403 || res.status === 429) {
        this.log.warn(
          { repo: tap.repo, status: res.status },
          'github rate-limited; skipping tap (set GITHUB_TOKEN to raise the limit)',
        );
        return [];
      }
      if (!res.ok) {
        this.log.warn({ repo: tap.repo, status: res.status }, 'github tree fetch non-200');
        return [];
      }
      tree = (await res.json()) as GitHubTreeResponse;
    } catch (err) {
      this.log.warn({ repo: tap.repo, err }, 'github tree fetch failed');
      return [];
    }

    // Collect every dir that contains a SKILL.md. A path like
    // `skills/docx/SKILL.md` ⇒ dir `skills/docx`. Nested skills are included.
    const dirs = new Set<string>();
    for (const entry of tree.tree ?? []) {
      if (entry.type === 'blob' && entry.path.endsWith('/SKILL.md')) {
        dirs.add(entry.path.slice(0, -'/SKILL.md'.length));
      } else if (entry.type === 'blob' && entry.path === 'SKILL.md') {
        dirs.add('');
      }
    }
    const dirArray = [...dirs].sort();
    this.treeCache.set(tap.repo, {
      dirs: dirArray,
      expiresAt: Date.now() + TREE_CACHE_TTL_MS,
    });
    return this.filterByTapPath(dirArray, tap.path);
  }

  private filterByTapPath(dirs: string[], path?: string): string[] {
    if (!path) return dirs;
    const prefix = path.endsWith('/') ? path : `${path}/`;
    return dirs.filter((d) => d === path || d.startsWith(prefix));
  }

  private toMeta(repo: string, dir: string, name: string): SkillMeta {
    const identifier = dir ? `${repo}/${dir}` : repo;
    const pluginSource: PluginResourceSource = {
      type: 'plugin',
      source: { source: 'github', repo, ...(dir ? { path: dir } : {}) },
      plugin: name,
    };
    return {
      name,
      description: '', // tree API doesn't carry descriptions; inspect() would (Phase 3.3)
      source: this.sourceId(),
      identifier,
      trustLevel: resolveTrustTier({ source: 'github', repo }),
      repo,
      ...(dir ? { path: dir } : {}),
      extra: { pluginSource },
    };
  }
}
