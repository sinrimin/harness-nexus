// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * Profile version auto-numbering (2026-09, agreed with the user):
 *
 * - Versions are server-assigned; the manual field is gone from the UI and the
 *   client-sent value is ignored.
 * - New profiles start at `0.1`.
 * - Digits are DECIMAL and each segment carries at 16: `0.1` … `0.15` →
 *   `1.0`. All-decimal keeps every generated version valid semver, which
 *   Claude Code's `plugin update` version comparison relies on (strict
 *   hexadecimal — `0.a` … `0.f` — was rejected for exactly that risk).
 * - A version bumps ONLY when the profile's entries change: name/description
 *   edits keep the version so installed machines don't pointlessly update
 *   (the bump is the marketplace publish switch).
 *
 * Legacy hand-typed versions (`1.0.0`, `0.3.2`, …) keep their shape; the
 * increment applies to the last segment with the same carry-at-16 rule.
 */

/** The version a newly created profile starts from. */
export const INITIAL_PROFILE_VERSION = '0.1';

/**
 * Increment a dotted version: last segment +1, carrying at 16 leftward
 * (`0.15` → `1.0`, `0.15.15` → `1.0.0`). Non-numeric segments count as 0.
 */
export function bumpProfileVersion(version: string): string {
  const nums = version.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : 0));
  if (nums.length === 0) nums.push(0);
  for (let i = nums.length - 1; i >= 0; i--) {
    const bumped = (nums[i] ?? 0) + 1;
    if (bumped < 16) {
      nums[i] = bumped;
      break;
    }
    nums[i] = 0;
    if (i === 0) nums.unshift(1);
  }
  return nums.join('.');
}
