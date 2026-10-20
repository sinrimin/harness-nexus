// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
  marketplacePluginSchema,
  marketplacePluginToResourceSource,
} from '../src/schemas/marketplace.js';

describe('marketplacePluginSchema (archive arm, Phase 3.5)', () => {
  it('parses an archive source with url + optional sha256', () => {
    const r = marketplacePluginSchema.safeParse({
      name: 'daily',
      description: 'd',
      source: { source: 'archive', url: 'https://host/a.zip', sha256: 'abc' },
    });
    expect(r.success).toBe(true);
  });

  it('rejects an archive source without a url', () => {
    const r = marketplacePluginSchema.safeParse({
      name: 'daily',
      description: 'd',
      source: { source: 'archive' },
    });
    expect(r.success).toBe(false);
  });
});

describe('marketplacePluginToResourceSource', () => {
  it('maps github entries, folding commit into sha', () => {
    const out = marketplacePluginToResourceSource({
      name: 'n',
      description: 'd',
      source: { source: 'github', repo: 'anthropics/skills', commit: 'deadbeef' },
    });
    expect(out).toMatchObject({
      type: 'plugin',
      plugin: 'n',
      source: { source: 'github', repo: 'anthropics/skills', sha: 'deadbeef' },
    });
  });

  it('returns null for archive entries (no faithful plugin-source mapping)', () => {
    const out = marketplacePluginToResourceSource({
      name: 'n',
      description: 'd',
      source: { source: 'archive', url: 'https://host/a.zip' },
    });
    expect(out).toBeNull();
  });
});
