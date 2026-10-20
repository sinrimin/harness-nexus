// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { randomUUID } from 'node:crypto';
import type { WorkspaceListEvent } from '@harness-nexus/shared';

/**
 * Workspace listing request bookkeeping (Phase 9 W6) — the same
 * request/response shape as the W4 config viewer: a REST handler registers a
 * waiter, emits `workspace:list` into the machine's /ctl room, and the
 * daemon's reply resolves it here. Outcomes are values, not exceptions — the
 * route maps `reason` to HTTP codes. Many pickers may browse concurrently;
 * waiters are keyed by requestId, one per directory level being expanded.
 */

export interface WorkspaceListOutcome {
  ok: boolean;
  reason?: 'timeout' | 'disconnected';
  directories?: WorkspaceListEvent['directories'];
  /** 9 W9 C — regular files at the level (old daemons omit it). */
  files?: WorkspaceListEvent['files'];
  error?: string;
}

interface ListWaiter {
  machineId: string;
  resolve: (outcome: WorkspaceListOutcome) => void;
  timer: NodeJS.Timeout;
}

export class WorkspaceCoordinator {
  private readonly waiters = new Map<string, ListWaiter>(); // requestId → waiter

  constructor(private readonly timeoutMs: number) {}

  /** Register the waiter for a listing we are about to emit. */
  awaitList(
    machineId: string,
    requestId: string = randomUUID(),
  ): {
    requestId: string;
    done: Promise<WorkspaceListOutcome>;
  } {
    const done = new Promise<WorkspaceListOutcome>((resolve) => {
      const waiter: ListWaiter = {
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

  /** A listing arrived; resolves its waiter. Returns false for unknown/late ids. */
  onList(requestId: string, evt: Omit<WorkspaceListEvent, 'requestId'>): boolean {
    const waiter = this.waiters.get(requestId);
    if (!waiter) return false;
    clearTimeout(waiter.timer);
    this.waiters.delete(requestId);
    if (evt.error !== undefined) {
      waiter.resolve({ ok: false, error: evt.error });
      return true;
    }
    waiter.resolve({ ok: true, directories: evt.directories ?? [], files: evt.files ?? [] });
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
