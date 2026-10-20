// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { randomUUID } from 'node:crypto';
import type { RuntimeConfigViewEvent } from '@harness-nexus/shared';

/**
 * Runtime config-view request bookkeeping (Phase 9 W4) — the same
 * request/response shape as C3's InventoryCoordinator, one file view at a
 * time: a REST handler registers a waiter, emits `runtime:config.get` into
 * the machine's /ctl room, and the daemon's `runtime:config` reply resolves
 * it here. Outcomes are values, not exceptions — the route maps `reason` to
 * HTTP codes.
 */

export interface ViewOutcome {
  ok: boolean;
  reason?: 'timeout' | 'disconnected';
  view?: Omit<RuntimeConfigViewEvent, 'requestId'>;
}

interface ViewWaiter {
  machineId: string;
  resolve: (outcome: ViewOutcome) => void;
  timer: NodeJS.Timeout;
}

export class ConfigViewerCoordinator {
  private readonly waiters = new Map<string, ViewWaiter>(); // requestId → waiter

  constructor(private readonly timeoutMs: number) {}

  /** Register the waiter for a view we are about to emit. */
  awaitView(
    machineId: string,
    requestId: string = randomUUID(),
  ): {
    requestId: string;
    done: Promise<ViewOutcome>;
  } {
    const done = new Promise<ViewOutcome>((resolve) => {
      const waiter: ViewWaiter = {
        machineId,
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(requestId);
          resolve({ ok: false, reason: 'timeout' });
        }, this.timeoutMs),
      };
      this.waiters.set(requestId, waiter);
    });
    return { requestId, done };
  }

  /** A view arrived; resolves its waiter. Returns false for unknown/late ids. */
  onView(requestId: string, view: Omit<RuntimeConfigViewEvent, 'requestId'>): boolean {
    const waiter = this.waiters.get(requestId);
    if (!waiter) return false;
    clearTimeout(waiter.timer);
    this.waiters.delete(requestId);
    if (view.error !== undefined) {
      waiter.resolve({ ok: false, view });
      return true;
    }
    waiter.resolve({ ok: true, view });
    return true;
  }

  /** Machine went offline: fail everything it was waiting on. */
  failMachine(machineId: string): void {
    for (const [requestId, waiter] of [...this.waiters.entries()]) {
      if (waiter.machineId !== machineId) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(requestId);
      waiter.resolve({ ok: false, reason: 'disconnected' });
    }
  }
}
