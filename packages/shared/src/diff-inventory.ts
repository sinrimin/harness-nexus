// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { InventoryDiff, InventoryDiffEntry, InventoryItem } from './schemas/inventory.js';

/**
 * Pure inventory-vs-profile diff (Phase 8 C3). See wiki design-phase-8-c3.md.
 *
 * The caller (server route) resolves profile entries to `{kind, name}` pairs
 * first — non-mcp entries carry the RESOURCE name (adapters name artifacts
 * after it, so the round trip is name-stable), mcp entries carry the McpServer
 * name. Matching here is by `(kind, name)`.
 *
 * The MCP arm is deliberately coarse: one profile install emits ONE shim entry
 * (`harness-nexus[-<slug>]`), so every mcp profile entry is considered applied
 * iff the snapshot holds any `origin: 'platform'` mcp item.
 *
 * Items with `origin: 'platform'` that no profile entry claims (they belong to
 * another installed profile) are neither candidates nor drift — they stay
 * visible in the inventory table only.
 */

/** The computed part of `InventoryDiff` — the route fills `profileId` / `target`. */
export type InventoryDiffBody = Omit<InventoryDiff, 'profileId' | 'target'>;

export function diffInventory(
  profileEntries: readonly { kind: InventoryDiffEntry['kind']; name: string }[],
  items: readonly InventoryItem[],
): InventoryDiffBody {
  const itemByKey = new Map(items.map((item) => [`${item.kind}:${item.name}`, item]));
  const claimed = new Set<string>();
  const hasPlatformMcp = items.some((item) => item.kind === 'mcp' && item.origin === 'platform');

  const upToDate: InventoryDiff['upToDate'] = [];
  const missingOnMachine: InventoryDiffEntry[] = [];

  for (const entry of profileEntries) {
    if (entry.kind === 'mcp') {
      // Coarse arm: the shim entry represents the profile's whole MCP set.
      if (hasPlatformMcp) upToDate.push({ kind: entry.kind, name: entry.name, origin: 'platform' });
      else missingOnMachine.push({ kind: entry.kind, name: entry.name });
      continue;
    }
    const item = itemByKey.get(`${entry.kind}:${entry.name}`);
    if (item) {
      claimed.add(`${item.kind}:${item.name}`);
      upToDate.push({ kind: entry.kind, name: entry.name, origin: item.origin });
    } else {
      missingOnMachine.push({ kind: entry.kind, name: entry.name });
    }
  }

  const notInProfile = items.filter(
    (item) =>
      item.kind !== 'mcp' && item.origin === 'local' && !claimed.has(`${item.kind}:${item.name}`),
  );

  return {
    upToDate,
    missingOnMachine,
    notInProfile,
    summary: {
      profileEntries: profileEntries.length,
      applied: upToDate.length,
      missing: missingOnMachine.length,
      candidates: notInProfile.length,
    },
  };
}
