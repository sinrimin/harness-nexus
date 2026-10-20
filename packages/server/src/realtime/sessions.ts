// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { randomUUID } from 'node:crypto';
import type { SessionsListResultEvent } from '@harness-nexus/shared';

/**
 * Native session request bookkeeping (Phase 9 W7; delete arm #55) — the same
 * request/response shape as the W6 workspace coordinator: a REST handler
 * registers a waiter, emits into the machine's /ctl room, and the daemon's
 * reply resolves it here. Outcomes are values, not exceptions — the route
 * maps `reason` to HTTP codes.
 */

export interface SessionsListOutcome {
  ok: boolean;
  reason?: 'timeout' | 'disconnected';
  sessions?: SessionsListResultEvent['sessions'];
  supported?: boolean;
  error?: string;
}

/** #55 — a delete settles with no payload; only ok/reason/error matter. */
export interface SessionsDeleteOutcome {
  ok: boolean;
  reason?: 'timeout' | 'disconnected';
  error?: string;
}

interface Waiter<O> {
  machineId: string;
  resolve: (outcome: O) => void;
  timer: NodeJS.Timeout;
}

export class SessionsCoordinator {
  private readonly listWaiters = new Map<string, Waiter<SessionsListOutcome>>();
  private readonly deleteWaiters = new Map<string, Waiter<SessionsDeleteOutcome>>();

  constructor(private readonly timeoutMs: number) {}

  /** Register the waiter for a listing we are about to emit. */
  awaitList(
    machineId: string,
    requestId: string = randomUUID(),
  ): {
    requestId: string;
    done: Promise<SessionsListOutcome>;
  } {
    return {
      requestId,
      done: this.register(this.listWaiters, requestId, machineId, {
        ok: false,
        reason: 'timeout',
      }),
    };
  }

  /** A listing arrived; resolves its waiter. Returns false for unknown/late ids. */
  onList(requestId: string, evt: Omit<SessionsListResultEvent, 'requestId'>): boolean {
    const waiter = this.listWaiters.get(requestId);
    if (!waiter) return false;
    this.listWaiters.delete(requestId);
    clearTimeout(waiter.timer);
    if (evt.error !== undefined) {
      waiter.resolve({ ok: false, error: evt.error });
      return true;
    }
    waiter.resolve({
      ok: true,
      sessions: evt.sessions ?? [],
      supported: evt.supported ?? true,
    });
    return true;
  }

  /** #55 — register the waiter for a delete we are about to emit. */
  awaitDelete(
    machineId: string,
    requestId: string = randomUUID(),
  ): {
    requestId: string;
    done: Promise<SessionsDeleteOutcome>;
  } {
    return {
      requestId,
      done: this.register(this.deleteWaiters, requestId, machineId, {
        ok: false,
        reason: 'timeout',
      }),
    };
  }

  /** #55 — a delete settled; resolves its waiter. False for unknown/late ids. */
  onDelete(requestId: string, evt: { error?: string | undefined }): boolean {
    const waiter = this.deleteWaiters.get(requestId);
    if (!waiter) return false;
    this.deleteWaiters.delete(requestId);
    clearTimeout(waiter.timer);
    waiter.resolve(evt.error !== undefined ? { ok: false, error: evt.error } : { ok: true });
    return true;
  }

  /** Machine went offline: fail everything it was waiting on (both arms). */
  failMachine(machineId: string): void {
    for (const waiters of [this.listWaiters, this.deleteWaiters]) {
      for (const [requestId, waiter] of [...waiters.entries()]) {
        if (waiter.machineId !== machineId) continue;
        waiters.delete(requestId);
        clearTimeout(waiter.timer);
        waiter.resolve({ ok: false, reason: 'disconnected' });
      }
    }
  }

  private register<O extends SessionsListOutcome | SessionsDeleteOutcome>(
    waiters: Map<string, Waiter<O>>,
    requestId: string,
    machineId: string,
    timeout: O,
  ): Promise<O> {
    return new Promise<O>((resolve) => {
      const waiter: Waiter<O> = {
        machineId,
        resolve,
        timer: setTimeout(() => {
          waiters.delete(requestId);
          resolve(timeout);
        }, this.timeoutMs),
      };
      waiters.set(requestId, waiter);
    });
  }
}
