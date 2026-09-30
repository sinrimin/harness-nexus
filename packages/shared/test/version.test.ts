import { describe, expect, it } from 'vitest';
import { compareVersions } from '../src/version.js';

describe('compareVersions (#37)', () => {
  it('orders numeric cores left to right', () => {
    expect(compareVersions('0.1.0', '0.2.0')).toBeLessThan(0);
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('2.0.0', '10.0.0')).toBeLessThan(0);
  });

  it('treats missing segments and prerelease tails per semver', () => {
    expect(compareVersions('0.1', '0.1.0')).toBe(0);
    expect(compareVersions('0.1.0-alpha.7', '0.1.0')).toBeLessThan(0);
    expect(compareVersions('0.1.0-alpha.7', '0.1.0-alpha.10')).toBeLessThan(0);
    expect(compareVersions('0.1.0-alpha.7', '0.1.0-beta.1')).toBeLessThan(0);
    expect(compareVersions('0.1.0-rc.1', '0.1.0-alpha.9')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0-alpha', '0.1.0-alpha.1')).toBeLessThan(0);
  });

  it('keeps ordering sane for the client/server mismatch chips', () => {
    // The daemon warns when it is OLDER than the server.
    expect(compareVersions('0.1.0-alpha.7', '0.1.0-alpha.8')).toBeLessThan(0);
    expect(compareVersions('0.1.0-alpha.8', '0.1.0-alpha.8')).toBe(0);
    expect(compareVersions('0.1.0-alpha.9', '0.1.0-alpha.8')).toBeGreaterThan(0);
  });

  it('degrades instead of throwing on junk', () => {
    expect(compareVersions('junk', '0.1.0')).toBeLessThan(0);
    expect(compareVersions('0.1.0-what.ever', '0.1.0')).toBeLessThan(0);
  });
});
