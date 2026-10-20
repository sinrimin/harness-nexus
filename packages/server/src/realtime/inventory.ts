// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { randomUUID } from 'node:crypto';
import type { MachineInventorySnapshot } from '@harness-nexus/core';
import type { InventoryPayloadEvent } from '@harness-nexus/shared';

/**
 * Inventory request bookkeeping (Phase 8 C3). See wiki design-phase-8-c3.md.
 *
 * C3 uses direct request/response over /ctl — no Job rows: a REST handler
 * emits `inventory:scan` / `inventory:collect` into the machine's room and
 * awaits the daemon's `inventory:report` / `inventory:payload` here. C4's job
 * system formalizes queue/replay semantics and absorbs both flows.
 *
 * Outcomes are values, not exceptions — routes map `reason` to HTTP codes.
 * One in-flight scan per machine (a second concurrent request is told so);
 * collect waiters are keyed by requestId and also fail on machine disconnect.
 */

export type ScanFailureReason = 'timeout' | 'disconnected' | 'in-progress';

export interface ScanOutcome {
  ok: boolean;
  reason?: ScanFailureReason;
  /** Snapshots received so far — complete on success, partial on failure. */
  snapshots: MachineInventorySnapshot[];
  /** Targets still outstanding when the outcome was settled. */
  missing: string[];
}

export interface PayloadOutcome {
  ok: boolean;
  reason?: 'timeout' | 'disconnected';
  items?: InventoryPayloadEvent['items'];
}

interface ScanWaiter {
  machineId: string;
  pending: Set<string>;
  snapshots: MachineInventorySnapshot[];
  resolve: (outcome: ScanOutcome) => void;
  timer: NodeJS.Timeout;
}

interface CollectWaiter {
  machineId: string;
  resolve: (outcome: PayloadOutcome) => void;
  timer: NodeJS.Timeout;
}

export class InventoryCoordinator {
  private readonly scans = new Map<string, ScanWaiter>(); // machineId → waiter
  private readonly collects = new Map<string, CollectWaiter>(); // requestId → waiter

  constructor(private readonly timeoutMs: number) {}

  /**
   * Start awaiting one report per target. Returns null iff a scan is already
   * in flight for this machine (→ 409 SCAN_IN_PROGRESS at the route).
   */
  beginScan(
    machineId: string,
    targets: readonly string[],
  ): { requestId: string; done: Promise<ScanOutcome> } | null {
    if (this.scans.has(machineId)) return null;
    const requestId = randomUUID();
    const done = new Promise<ScanOutcome>((resolve) => {
      const waiter: ScanWaiter = {
        machineId,
        pending: new Set(targets),
        snapshots: [],
        resolve,
        timer: setTimeout(() => {
          this.scans.delete(machineId);
          resolve({
            ok: false,
            reason: 'timeout',
            snapshots: waiter.snapshots,
            missing: [...waiter.pending],
          });
        }, this.timeoutMs),
      };
      this.scans.set(machineId, waiter);
    });
    return { requestId, done };
  }

  /** A report arrived: store it with the (single) scan waiter if one matches. */
  onReport(machineId: string, snapshot: MachineInventorySnapshot): void {
    const waiter = this.scans.get(machineId);
    if (!waiter) return;
    waiter.pending.delete(snapshot.target);
    waiter.snapshots.push(snapshot);
    if (waiter.pending.size === 0) {
      clearTimeout(waiter.timer);
      this.scans.delete(machineId);
      waiter.resolve({ ok: true, snapshots: waiter.snapshots, missing: [] });
    }
  }

  /** Register a waiter for a collect we are about to emit. */
  awaitPayload(machineId: string, requestId: string): Promise<PayloadOutcome> {
    return new Promise<PayloadOutcome>((resolve) => {
      const waiter: CollectWaiter = {
        machineId,
        resolve,
        timer: setTimeout(() => {
          this.collects.delete(requestId);
          resolve({ ok: false, reason: 'timeout' });
        }, this.timeoutMs),
      };
      this.collects.set(requestId, waiter);
    });
  }

  /** A payload arrived; resolves its waiter. Returns false for unknown/late ids. */
  onPayload(requestId: string, items: InventoryPayloadEvent['items']): boolean {
    const waiter = this.collects.get(requestId);
    if (!waiter) return false;
    clearTimeout(waiter.timer);
    this.collects.delete(requestId);
    waiter.resolve({ ok: true, items });
    return true;
  }

  /** Machine went offline: fail everything it was waiting on. */
  failMachine(machineId: string): void {
    const scan = this.scans.get(machineId);
    if (scan) {
      clearTimeout(scan.timer);
      this.scans.delete(machineId);
      scan.resolve({
        ok: false,
        reason: 'disconnected',
        snapshots: scan.snapshots,
        missing: [...scan.pending],
      });
    }
    for (const [requestId, waiter] of [...this.collects.entries()]) {
      if (waiter.machineId !== machineId) continue;
      clearTimeout(waiter.timer);
      this.collects.delete(requestId);
      waiter.resolve({ ok: false, reason: 'disconnected' });
    }
  }
}
