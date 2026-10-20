// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * Phase 8 C4 — a unit of replayable work executed by a machine's daemon over
 * `/ctl` (`job:dispatch` → `job:progress` → `job:result`). C4 ships the
 * `deploy` type (remote profile install reusing the 3.3 pipeline); Phase 9 W2
 * adds `harness` (install/upgrade/pin the harness runtime itself — no
 * AgentInstance side effects). `scan` / `import` stay interactive (C3) and
 * remain reserved in the type union. See wiki design-phase-8-c4.md.
 */
import type { AgentTarget } from './resource.js';

export type JobType = 'deploy' | 'import' | 'scan' | 'harness';

export type JobStatus = 'queued' | 'dispatched' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  machineId: string;
  ownerId: string;
  type: JobType;
  status: JobStatus;
  /** `{profileId, directory?}` for deploys (validated in shared). */
  payload: Record<string, unknown>;
  /** Terminal data (a `DeployResultData`-shaped object for deploys). */
  result: unknown;
  error: string | null;
  /** Delivery attempts; disconnect/ack-timeout recoveries increment it. */
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * One agent on a machine — the addressable unit C5 chats with and C6
 * orchestrates. Two sources (Phase 9 W1):
 *  - `deploy` — upserted by a successful deploy job, keyed (machine, profile).
 *  - `detected` — auto-registered when an inventory report shows an installed
 *    harness runtime for (machine, target) and no deploy row exists; it is the
 *    Agent in its current (possibly default) state, chatable, and a later
 *    deploy upgrades the row in place.
 */
export interface AgentInstance {
  id: string;
  machineId: string;
  ownerId: string;
  target: AgentTarget;
  /** null for detected instances — they did not come from a profile. */
  profileId: string | null;
  profileVersion: string | null;
  /** Display name (the profile's name at deploy time; `<target>` for detected). */
  name: string;
  /** Install root / agent home on the machine (daemon-reported, display + chat cwd). */
  directory: string;
  /** null for detected instances — no job produced them. */
  jobId: string | null;
  source: 'deploy' | 'detected';
  createdAt: string;
  updatedAt: string;
}
