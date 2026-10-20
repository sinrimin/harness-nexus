// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { bumpProfileVersion, INITIAL_PROFILE_VERSION } from '../src/profile-version.js';

describe('bumpProfileVersion (decimal, carry at 16)', () => {
  it('increments the last segment', () => {
    expect(bumpProfileVersion('0.1')).toBe('0.2');
    expect(bumpProfileVersion('0.9')).toBe('0.10');
    expect(bumpProfileVersion('1.2.3')).toBe('1.2.4');
  });

  it('carries at 16, never emitting a hex digit', () => {
    expect(bumpProfileVersion('0.15')).toBe('1.0');
    expect(bumpProfileVersion('0.15.15')).toBe('1.0.0');
    expect(bumpProfileVersion('1.0.15')).toBe('1.1.0');
    // chain: 0.14 → 0.15 → 1.0 → 1.1
    expect(bumpProfileVersion(bumpProfileVersion('0.14'))).toBe('1.0');
    expect(bumpProfileVersion('1.0')).toBe('1.1');
  });

  it('handles single-segment and legacy odd shapes without inventing hex', () => {
    expect(bumpProfileVersion('15')).toBe('1.0');
    expect(bumpProfileVersion('v2')).toBe('1'); // non-numeric counts as 0 → 1
  });

  it('starts new profiles at 0.1', () => {
    expect(INITIAL_PROFILE_VERSION).toBe('0.1');
  });
});
