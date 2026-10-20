// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { chatReconcileAckSchema } from '@harness-nexus/shared';

/**
 * 9 W11 E — the server half of the disconnect grace window (kills D5).
 *
 * Socket-level presence has NO debounce: the last /ctl socket dropping used
 * to reap every channel of the machine instantly, so a sub-second transport
 * blip killed all channels ("my tab vanished"; demonstrated live twice on
 * the rig). The guard delays that reap by `graceMs`; a reconnect within the
 * window cancels it and runs the RECONCILE handshake instead — the server
 * announces its live rows (`chat:reconcile`), the daemon drops what it holds
 * that is not listed and acks with what it holds, and the server closes
 * ghost rows (`retainOnly`). If the daemon really died, its own grace
 * timers died with it: the delayed reap fires, and the W11 A ledger sweep
 * collects the orphaned adapter processes on the next boot.
 *
 * Ownership stays server-side (Principle 1): the daemon never re-adopts
 * rows, it only drops what the server disowned.
 */

/** The subset of Socket.IO's timed-emit surface the handshake needs. */
export interface ReconcileEmitter {
  timeout(ms: number): {
    emit(
      event: 'chat:reconcile',
      payload: unknown,
      ack: (err: unknown, res: unknown) => void,
    ): void;
  };
}

export interface ReconnectGuardDeps {
  liveSessionIds(machineId: string): string[];
  retainOnly(machineId: string, held: Set<string>): Promise<void>;
  onMachineOffline(machineId: string): Promise<void>;
}

export class ReconnectGuard {
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private deps: ReconnectGuardDeps,
    private graceMs = 8000,
    /** A W11 daemon acks in milliseconds; the cap just bounds the wait. */
    private ackTimeoutMs = Math.min(5000, graceMs),
  ) {}

  /**
   * A /ctl socket (re)connected: cancel any pending reap and reconcile.
   * Called on EVERY connection — a fresh daemon (restart, hard-death
   * survivor) owns nothing but what it acks, which is exactly what flushes
   * ghosts that a reconnect race would otherwise leave wedged against the
   * machine budget.
   */
  onCtlConnect(socket: ReconcileEmitter, machineId: string): void {
    this.cancel(machineId);
    const sessionIds = this.deps.liveSessionIds(machineId).slice(0, 64);
    socket.timeout(this.ackTimeoutMs).emit('chat:reconcile', { sessionIds }, (err, res) => {
      // No/invalid ack (pre-W11 daemon without the handler, wedged daemon,
      // or the socket died mid-handshake): fall back to the reaping path —
      // through the SAME grace (the socket may simply have blipped again;
      // an instant reap here would defeat the window).
      const parsed = chatReconcileAckSchema.safeParse(res);
      if (err !== null || !parsed.success) {
        this.onWentOffline(machineId);
        return;
      }
      void this.deps.retainOnly(machineId, new Set(parsed.data.held));
    });
  }

  /** The machine's last /ctl socket dropped: reap after the grace window. */
  onWentOffline(machineId: string): void {
    if (this.timers.has(machineId)) return;
    const t = setTimeout(() => {
      this.timers.delete(machineId);
      void this.deps.onMachineOffline(machineId);
    }, this.graceMs);
    t.unref();
    this.timers.set(machineId, t);
  }

  cancel(machineId: string): void {
    const t = this.timers.get(machineId);
    if (t !== undefined) {
      clearTimeout(t);
      this.timers.delete(machineId);
    }
  }
}
