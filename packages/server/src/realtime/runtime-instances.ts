// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { Machine, RuntimeInfoData, UnitOfWork } from '@harness-nexus/core';
import { generateId } from '../infra/crypto.js';

/**
 * Detected AgentInstance sync (Phase 9 W1). Every inventory report that
 * carries a runtime arm drives this: an installed runtime with no deploy row
 * for the target auto-registers a `source: 'detected'` instance (the chatable
 * Agent in its current state); a runtime that STAYS absent for two
 * consecutive reports removes it (hysteresis against a flaky probe).
 *
 * `runtime: null` (old daemon build, or a non-runtime-managed target) is NO
 * signal — it neither registers nor removes, so upgrading hnx can never
 * delete rows just because the old daemon never probed.
 *
 * The miss counter is in-memory by design: it guards probe flakiness within a
 * server's lifetime; a restart simply re-derives state from the next report.
 */
export class DetectedInstanceSync {
  private readonly misses = new Map<string, number>();

  constructor(
    private readonly uow: UnitOfWork,
    private readonly opts = { removalThreshold: 2 },
  ) {}

  /**
   * Fold one report in. `runtime` is the snapshot target's probe result (the
   * caller picked it out of the event's `runtimes` array); `directory` is the
   * snapshot's agent home — the detected instance's chat cwd.
   */
  async onReport(
    machine: Machine,
    runtime: RuntimeInfoData | null,
    directory: string | undefined,
  ): Promise<void> {
    if (runtime === null) return;
    const key = `${machine.id}:${runtime.target}`;

    if (!runtime.installed) {
      const misses = (this.misses.get(key) ?? 0) + 1;
      if (misses < this.opts.removalThreshold) {
        this.misses.set(key, misses);
        return;
      }
      this.misses.delete(key);
      const existing = await this.uow.agentInstances.findByMachineAndTarget(
        machine.id,
        runtime.target,
      );
      if (existing) await this.uow.agentInstances.delete(existing.id);
      return;
    }

    this.misses.delete(key);
    const existing = await this.uow.agentInstances.findByMachineAndTarget(
      machine.id,
      runtime.target,
    );
    if (existing) {
      if (directory !== undefined && existing.directory !== directory) {
        await this.uow.agentInstances.save({
          ...existing,
          directory,
          updatedAt: new Date().toISOString(),
        });
      }
      return;
    }
    // A deploy row for the target owns the Agent — never double-register.
    const hasDeploy = (await this.uow.agentInstances.listByMachine(machine.id)).some(
      (a) => a.target === runtime.target && a.source === 'deploy',
    );
    if (hasDeploy) return;

    const now = new Date().toISOString();
    await this.uow.agentInstances.save({
      id: generateId(),
      machineId: machine.id,
      ownerId: machine.ownerId,
      target: runtime.target,
      profileId: null,
      profileVersion: null,
      name: runtime.target,
      directory: directory ?? `~/.${runtime.target}`,
      jobId: null,
      source: 'detected',
      createdAt: now,
      updatedAt: now,
    });
  }

  /** Machine deleted — drop its hysteresis state (rows cascade in storage). */
  forgetMachine(machineId: string): void {
    for (const key of this.misses.keys()) {
      if (key.startsWith(`${machineId}:`)) this.misses.delete(key);
    }
  }
}
