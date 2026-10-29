// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * cwd helpers for the session rail's folder headers (#99 D3): the name is the
 * last segment, the small print is the PARENT (the name already answers "which
 * project"; the parent answers "under which root"). Both split on `/` only —
 * the daemon reports POSIX cwds everywhere (the Windows fix in #43 normalizes
 * host-side).
 */

export function cwdBasename(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, '');
  const last = trimmed.split('/').pop();
  return last === undefined || last === '' ? cwd : last;
}

/** The cwd minus its last segment, or null when that parent is `/` (a bare
 *  top-level directory has no useful "under which root" to print). */
export function cwdParent(cwd: string): string | null {
  const parts = cwd.replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length <= 1) return null;
  const parent = `/${parts.slice(0, -1).join('/')}`;
  return parent === '/' ? null : parent;
}
