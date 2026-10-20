// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { AgentTarget, InventoryArtifact, InventoryItemKind } from '@harness-nexus/shared';
import type { DiscoveredItem } from './common.js';

/** One row of an `inventory:payload` event (success or per-item error). */
export interface PayloadItem {
  kind: InventoryItemKind;
  name: string;
  ok: boolean;
  error?: string;
  artifact?: InventoryArtifact;
}

/**
 * A per-target scanner. `discover` re-runs on every collect — the daemon never
 * trusts server-supplied paths.
 */
export interface TargetScanner {
  target: AgentTarget;
  /** The agent's home dir (may not exist — discover then returns null). */
  homeOf(homeDir: string): string;
  discover(home: string): DiscoveredItem[] | null;
  /** Whole-home platform markers beyond the ledger (e.g. shim MCP names). */
  platformMarkers(home: string): string[];
  collect(home: string, item: DiscoveredItem): Promise<PayloadItem>;
}

/** The config-file MCP entry shape all three parsers normalize to. */
export interface RawMcpEntry {
  type?: string; // 'stdio' | 'sse' | 'http' | undefined
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}
