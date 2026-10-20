// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { homedir } from 'node:os';
import type { AgentTarget, InventoryItem, InventorySnapshot } from '@harness-nexus/shared';
import { isPlatformPath, readLedger, type DiscoveredItem } from './common.js';
import { claudeCodeScanner } from './scanners/claude-code.js';
import { codexScanner } from './scanners/codex.js';
import { hermesScanner } from './scanners/hermes.js';
import { deepseekScanner } from './scanners/deepseek.js';
import { opencodeScanner } from './scanners/opencode.js';
import { piScanner } from './scanners/pi.js';
import type { PayloadItem, TargetScanner } from './types.js';

/**
 * Inventory scan entry point (Phase 8 C3). Owns the cross-scanner assembly:
 * origin resolution (ledger paths + scanner markers), (kind, name) dedupe,
 * snapshot shaping, and the collect fan-out. Kept in lockstep with the
 * server's SCANNABLE_TARGETS (modules/inventory.ts).
 */

export const SCANNERS: TargetScanner[] = [
  claudeCodeScanner,
  codexScanner,
  hermesScanner,
  deepseekScanner,
  opencodeScanner,
  piScanner,
];

export function scannerFor(target: AgentTarget): TargetScanner | undefined {
  return SCANNERS.find((s) => s.target === target);
}

function toWireItem(item: DiscoveredItem, platform: boolean): InventoryItem {
  return {
    kind: item.kind,
    name: item.name,
    origin: platform ? 'platform' : 'local',
    path: item.relPath,
    ...(item.summary ? { summary: item.summary } : {}),
    ...(item.preview ? { contentPreview: item.preview } : {}),
    importable: item.importable,
    ...(item.note ? { note: item.note } : {}),
    ...(item.meta ? { meta: item.meta } : {}),
  };
}

/** Scan one target. A missing agent home still reports an (empty) snapshot. */
export function scanTarget(target: AgentTarget, homeDir = homedir()): InventorySnapshot {
  const scanner = scannerFor(target);
  if (!scanner) {
    throw new Error(`no scanner for target '${target}'`);
  }
  const home = scanner.homeOf(homeDir);
  const ledger = readLedger(home);
  const markers = scanner.platformMarkers(home);
  const discovered = scanner.discover(home) ?? [];

  // (kind, name) must address items uniquely — first occurrence wins, later
  // duplicates (e.g. the same skill name in two Hermes plugins) are dropped.
  const items: InventoryItem[] = [];
  const seen = new Set<string>();
  for (const d of discovered) {
    const key = `${d.kind}:${d.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(toWireItem(d, d.platform === true || isPlatformPath(d.absPath, ledger)));
  }

  // Platform evidence: ledger destinations, shim/marketplace MCP names, or any
  // item already resolved as platform-written. No evidence ⇒ false (definitely
  // nothing of ours), never a guess.
  const platformApplied =
    ledger.platformPaths.size > 0 ||
    markers.length > 0 ||
    items.some((i) => i.origin === 'platform');

  return {
    target,
    scannedAt: new Date().toISOString(),
    agents: [
      {
        name: `~${home.slice(homeDir.length)}`,
        directory: home,
        profileApplied: platformApplied,
        items,
      },
    ],
  };
}

/** Scan every supported target (daemon start / default scan request). */
export function scanAllTargets(homeDir = homedir()): InventorySnapshot[] {
  return SCANNERS.map((s) => scanTarget(s.target, homeDir));
}

/**
 * Collect bodies for a selection. Paths are re-derived by a FRESH discover —
 * the daemon never trusts server-supplied paths.
 */
export async function collectItems(
  target: AgentTarget,
  selections: readonly { kind: InventoryItem['kind']; name: string }[],
  homeDir = homedir(),
): Promise<PayloadItem[]> {
  const scanner = scannerFor(target);
  if (!scanner) {
    return selections.map((s) => ({
      kind: s.kind,
      name: s.name,
      ok: false,
      error: 'unknown target',
    }));
  }
  const home = scanner.homeOf(homeDir);
  const discovered = scanner.discover(home) ?? [];
  const byKey = new Map(discovered.map((d) => [`${d.kind}:${d.name}`, d]));

  const out: PayloadItem[] = [];
  for (const sel of selections) {
    const item = byKey.get(`${sel.kind}:${sel.name}`);
    if (!item) {
      out.push({ kind: sel.kind, name: sel.name, ok: false, error: 'not found in fresh scan' });
      continue;
    }
    try {
      out.push(await scanner.collect(home, item));
    } catch (e) {
      out.push({
        kind: sel.kind,
        name: sel.name,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return out;
}
