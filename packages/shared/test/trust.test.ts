// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { resolveTrustTier } from '../src/trust.js';

describe('resolveTrustTier', () => {
  it('marks the trusted repos as trusted (case-insensitive owner)', () => {
    expect(resolveTrustTier({ source: 'github', repo: 'anthropics/skills' })).toBe('trusted');
    expect(resolveTrustTier({ source: 'github', repo: 'Anthropics/Skills' })).toBe('trusted');
  });

  it('marks unknown github repos community', () => {
    expect(resolveTrustTier({ source: 'github', repo: 'someone/else' })).toBe('community');
  });

  it('extracts trusted owner/repo from github URLs (url / git-subdir / archive)', () => {
    expect(resolveTrustTier({ source: 'url', url: 'https://github.com/openai/skills' })).toBe(
      'trusted',
    );
    expect(
      resolveTrustTier({ source: 'git-subdir', url: 'https://github.com/huggingface/skills' }),
    ).toBe('trusted');
    // Phase 3.5: archive zips resolve trust the same way when hosted on github.
    expect(
      resolveTrustTier({
        source: 'archive',
        url: 'https://github.com/NVIDIA/skills/releases/download/v1/pkg.zip',
      }),
    ).toBe('trusted');
  });

  it('treats npm packages and non-github archives as community', () => {
    expect(resolveTrustTier({ source: 'npm', package: 'some-pkg' })).toBe('community');
    expect(resolveTrustTier({ source: 'archive', url: 'https://harness-nexus.local/a.zip' })).toBe(
      'community',
    );
  });
});
