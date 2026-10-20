// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { SkillSource } from '@harness-nexus/core';
import { SkillCatalogService } from '../src/infra/source-fetchers/catalog-service.js';
import { SkillSearchRouter } from '../src/infra/source-fetchers/search-router.js';
import type { MarketplaceEntry } from '../src/infra/source-fetchers/allowlist.js';
import type { Principal } from '../src/services/principal.js';
import {
  listMarketplacePlugins,
  listSkillMarketplaces,
  searchSkills,
  type SkillsDeps,
} from '../src/services/skills.js';

/**
 * #53 slice 2 — the skill hub service, tested DIRECTLY against fake fetchers
 * (no HTTP, no Fastify app). Pins the decisions that moved out of the route:
 * the required-query/clamp rules and the allowlist 404 (existence-hiding for
 * non-allowlisted marketplace ids).
 */

const user: Principal = { userId: 'u-1', role: 'user' };

/** Minimal pino-shaped logger stub (the infra services only warn). */
const log = { warn: () => undefined } as unknown as FastifyBaseLogger;

function catalogJson(): string {
  return JSON.stringify({
    name: 'fixture-marketplace',
    plugins: [
      {
        name: 'docx',
        description: 'Work with Word documents',
        category: 'documents',
        source: { source: 'github', repo: 'anthropics/skills' },
      },
      {
        name: 'pdf',
        description: 'Work with PDF files',
        category: 'documents',
        source: { source: 'github', repo: 'anthropics/skills' },
      },
      {
        name: 'lsp-tools',
        description: 'Language servers',
        source: './plugins/lsp-tools',
      },
    ],
  });
}

/** A search source that records the limit it was handed. */
function fakeSource(
  seen: { query?: string; limit?: number }[],
  metas: { identifier: string; trustLevel: 'community' | 'trusted' | 'builtin' }[] = [
    { identifier: 'a/demo', trustLevel: 'community' },
  ],
): SkillSource {
  return {
    sourceId: () => 'fake',
    inspect: async () => null,
    fetch: async () => null,
    trustLevelFor: () => 'community',
    search: async (query: string, limit?: number) => {
      seen.push({ query, limit });
      return metas.map((m) => ({
        name: m.identifier,
        description: 'd',
        source: 'fake',
        identifier: m.identifier,
        trustLevel: m.trustLevel,
      }));
    },
  };
}

function deps(search?: SkillSearchRouter): SkillsDeps {
  const allowlist: MarketplaceEntry[] = [
    { id: 'fixtures', url: 'https://example/marketplace.json' },
  ];
  return {
    search:
      search ?? new SkillSearchRouter({ sources: [fakeSource([])], timeoutMs: 500, logger: log }),
    catalog: new SkillCatalogService({
      fetcher: (async () => ({ ok: true, text: async () => catalogJson() })) as typeof fetch,
      logger: log,
    }),
    allowlist,
  };
}

describe('svc skills — search decisions (no HTTP)', () => {
  it('requires a non-empty ?q=', async () => {
    await expect(searchSkills(deps(), user, {})).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
    await expect(searchSkills(deps(), user, { q: '   ' })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('clamps ?limit= into 1..200 before fanning out', async () => {
    const seen: { limit?: number }[] = [];
    const d = deps(
      new SkillSearchRouter({ sources: [fakeSource(seen)], timeoutMs: 500, logger: log }),
    );
    await searchSkills(d, user, { q: 'demo' });
    expect(seen[0]?.limit).toBe(50); // default
    await searchSkills(d, user, { q: 'demo', limit: '99999' });
    expect(seen[1]?.limit).toBe(200); // clamped upper
    await searchSkills(d, user, { q: 'demo', limit: 'abc' });
    expect(seen[2]?.limit).toBe(50); // non-finite falls back
  });
});

describe('svc skills — marketplace allowlist (no HTTP)', () => {
  it('lists the configured entries verbatim', () => {
    const entries = listSkillMarketplaces(deps(), user);
    expect(entries.map((e) => e.id)).toEqual(['fixtures']);
  });

  it('404-hides a marketplace id that is not allowlisted', async () => {
    await expect(listMarketplacePlugins(deps(), user, 'nope')).rejects.toMatchObject({
      statusCode: 404,
      code: 'MARKETPLACE_NOT_ALLOWED',
    });
  });

  it('fetches a allowlisted catalog and filters by category/q', async () => {
    const all = await listMarketplacePlugins(deps(), user, 'fixtures');
    expect(all.map((p) => p.name)).toEqual(['docx', 'pdf']); // string-source entry dropped
    const docs = await listMarketplacePlugins(deps(), user, 'fixtures', { category: 'documents' });
    expect(docs.map((p) => p.name)).toEqual(['docx', 'pdf']);
    const hit = await listMarketplacePlugins(deps(), user, 'fixtures', { q: 'word' });
    expect(hit.map((p) => p.name)).toEqual(['docx']);
  });
});
