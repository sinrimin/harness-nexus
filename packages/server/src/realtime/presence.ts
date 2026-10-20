// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * Pure machine-presence state (Phase 8 C1) — no socket.io types, no I/O.
 *
 * The realtime plugin feeds connect/disconnect events in; routes read
 * `isOnline()`. A machine may hold several concurrent daemon sockets
 * (reconnect races); online = at least one live socket. Online/offline is
 * derived here and NEVER persisted — the Machines UI shows honest presence.
 */
export class MachinePresence {
  private socketToMachine = new Map<string, string>();
  private counts = new Map<string, number>();

  isOnline(machineId: string): boolean {
    return (this.counts.get(machineId) ?? 0) > 0;
  }

  listOnline(): string[] {
    return [...this.counts.keys()];
  }

  /**
   * Register a daemon socket.
   * @returns true when the machine transitions offline → online (the moment
   *   the /app push should fire).
   */
  connected(machineId: string, socketId: string): boolean {
    this.socketToMachine.set(socketId, machineId);
    const wasOnline = this.isOnline(machineId);
    this.counts.set(machineId, (this.counts.get(machineId) ?? 0) + 1);
    return !wasOnline;
  }

  /**
   * Remove a daemon socket.
   * @returns the machineId when this disconnect took the machine fully
   *   offline, else null (other sockets still hold it online).
   */
  disconnected(socketId: string): string | null {
    const machineId = this.socketToMachine.get(socketId);
    if (machineId === undefined) return null;
    this.socketToMachine.delete(socketId);
    const remaining = (this.counts.get(machineId) ?? 1) - 1;
    if (remaining <= 0) {
      this.counts.delete(machineId);
      return machineId;
    }
    this.counts.set(machineId, remaining);
    return null;
  }

  /**
   * Logically drop every socket of a machine (enrollment PAT revoked /
   * machine deleted). The plugin still disconnects the raw sockets; this only
   * resets presence bookkeeping.
   * @returns true if the machine was online.
   */
  forceOffline(machineId: string): boolean {
    const wasOnline = this.isOnline(machineId);
    for (const [socketId, mid] of this.socketToMachine) {
      if (mid === machineId) this.socketToMachine.delete(socketId);
    }
    this.counts.delete(machineId);
    return wasOnline;
  }
}
