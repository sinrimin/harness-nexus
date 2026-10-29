// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { cwdBasename, cwdParent } from './cwd.js';

describe('cwdBasename', () => {
  it('returns the last segment', () => {
    expect(cwdBasename('/root/projects/video-view')).toBe('video-view');
  });

  it('strips trailing slashes before splitting', () => {
    expect(cwdBasename('/root/projects/video-view/')).toBe('video-view');
    expect(cwdBasename('/root/projects/video-view//')).toBe('video-view');
  });

  it('falls back to the whole cwd at the root', () => {
    expect(cwdBasename('/')).toBe('/');
  });
});

describe('cwdParent', () => {
  it('returns everything above the last segment', () => {
    expect(cwdParent('/root/projects/video-view')).toBe('/root/projects');
  });

  it('returns the root for a second-level directory', () => {
    expect(cwdParent('/root/projects')).toBe('/root');
  });

  it('hides the parent when it would be "/" (no "under which root" to say)', () => {
    expect(cwdParent('/root')).toBeNull();
    expect(cwdParent('/')).toBeNull();
  });

  it('ignores trailing slashes', () => {
    expect(cwdParent('/root/projects/video-view/')).toBe('/root/projects');
  });
});
