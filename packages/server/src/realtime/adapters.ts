// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { randomUUID } from 'node:crypto';
import type { AdaptersReportResultEvent } from '@harness-nexus/shared';

/**
 * Adapter-report request bookkeeping (Phase 9 W11 C) — the same shape as the
 * W7 sessions coordinator: a REST handler registers a waiter, emits
 * `adapters:report` into the machine's /ctl room, and the daemon's reply
 * resolves it here. Outcomes are values, not exceptions — the route maps
 * `reason` to HTTP codes.
 */

export interface AdaptersReportOutcome {
  ok: boolean;
  reason?: 'timeout' | 'disconnected';
  adapters?: AdaptersReportResultEvent['adapters'];
  error?: string;
}

interface ReportWaiter {
  machineId: string;
  resolve: (outcome: AdaptersReportOutcome) => void;
  timer: NodeJS.Timeout;
}

export class AdaptersReportCoordinator {
  private readonly waiters = new Map<string, ReportWaiter>(); // requestId → waiter

  constructor(private readonly timeoutMs: number) {}

  /** Register the waiter for a report we are about to emit. */
  awaitReport(
    machineId: string,
    requestId: string = randomUUID(),
  ): {
    requestId: string;
    done: Promise<AdaptersReportOutcome>;
  } {
    const done = new Promise<AdaptersReportOutcome>((resolve) => {
      const waiter: ReportWaiter = {
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

  /** A report arrived; resolves its waiter. Returns false for unknown/late ids. */
  onReport(requestId: string, evt: Omit<AdaptersReportResultEvent, 'requestId'>): boolean {
    const waiter = this.waiters.get(requestId);
    if (!waiter) return false;
    clearTimeout(waiter.timer);
    this.waiters.delete(requestId);
    if (evt.error !== undefined) {
      waiter.resolve({ ok: false, error: evt.error });
      return true;
    }
    waiter.resolve({ ok: true, adapters: evt.adapters ?? [] });
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
