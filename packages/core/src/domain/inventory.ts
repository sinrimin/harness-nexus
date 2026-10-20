// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * Phase 8 C3 — the latest inventory snapshot for one (machine, target). The
 * daemon's scanners produce it (normalized in `@harness-nexus/shared`
 * `schemas/inventory.ts` — keep the item/agent shapes in sync); the server
 * stores exactly one row per pair and computes diffs against profiles from it.
 * See wiki design-phase-8-c3.md.
 */
import type { AgentTarget } from './resource.js';

/** Plain mirror of `InventoryItem` in shared (core stays framework-free). */
export interface InventoryItemData {
  kind: 'skill' | 'command' | 'sub_agent' | 'rule' | 'mcp';
  name: string;
  origin: 'platform' | 'local';
  path: string;
  summary?: string | undefined;
  contentPreview?: string | undefined;
  importable: boolean;
  note?: string | undefined;
  meta?:
    | {
        multi?: boolean | undefined;
        transport?: 'stdio' | 'sse' | 'http' | undefined;
        command?: string | undefined;
        url?: string | undefined;
      }
    | undefined;
}

/** Plain mirror of `InventoryAgent` in shared. C3 fills exactly one per snapshot. */
export interface InventoryAgentData {
  name: string;
  directory: string;
  profileApplied: boolean | null;
  items: InventoryItemData[];
}

/** Plain mirror of `RuntimeInfo` in shared (Phase 9 W1). */
export interface RuntimeInfoData {
  target: 'claude-code' | 'codex' | 'deepseek' | 'opencode' | 'pi';
  installed: boolean;
  binPath?: string | undefined;
  version?: string | undefined;
  installMethod?: 'npm' | 'native' | 'brew' | 'unknown' | undefined;
}

export interface MachineInventorySnapshot {
  id: string;
  machineId: string;
  target: AgentTarget;
  daemonVersion: string | null;
  reportedAt: string;
  /** Daemon clock at scan time. */
  scannedAt: string;
  agents: InventoryAgentData[];
  /**
   * This target's harness runtime probe (Phase 9 W1). null = the reporting
   * daemon build does not probe runtimes (or the target is not runtime-managed)
   * — distinct from `installed: false`.
   */
  runtime: RuntimeInfoData | null;
}
