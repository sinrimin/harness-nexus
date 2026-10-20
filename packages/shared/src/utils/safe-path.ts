// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * Path-safety predicate for file keys that get joined onto a target directory
 * (skill bundle entries, plugin-source subpaths, emitted archive entries).
 * Shared by the resource routes, the inventory import, and the marketplace
 * emitter so every ingestion point applies the same rule (#21).
 */
export function isUnsafeRelativePath(p: string): boolean {
  return p === '' || p.startsWith('/') || p.includes('..') || p.includes('\\');
}
