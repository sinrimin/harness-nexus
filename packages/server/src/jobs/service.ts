import type { Job, AgentInstance, UnitOfWork } from '@harness-nexus/core';
import {
  deployResultDataSchema,
  type JobProgressEvent,
  type JobResultEvent,
  type JobView,
} from '@harness-nexus/shared';
import { AppError } from '@harness-nexus/shared';
import { generateId } from '../infra/crypto.js';

/**
 * Job state machine (Phase 8 C4). wiki design-phase-8-c4.md.
 *
 *   create → queued → dispatched → running → succeeded | failed
 *                └── cancel (queued only)
 *   disconnect / ack-timeout sweep: dispatched|running → queued (attempts+1),
 *   attempts ≥ max ⇒ failed JOB_ABANDONED. Terminal states never move again —
 *   late daemon events for a terminal job are ignored (stale replay after
 *   recovery must not clobber the redelivered attempt).
 *
 * The service is transport-agnostic: it takes `emit` callbacks (realtime
 * wires them to /ctl rooms and /app pushes). Progress phase/message is
 * transient — only status transitions persist.
 */

export interface JobServiceDeps {
  uow: UnitOfWork;
  /** Is the machine's daemon connected right now? */
  isOnline: (machineId: string) => boolean;
  /** Send `job:dispatch` into the machine's /ctl room. */
  dispatch: (job: JobView) => void;
  /** Push `job:update` to the owner (+admins) on /app. */
  update: (job: JobView) => void;
}

const TERMINAL: ReadonlySet<Job['status']> = new Set(['succeeded', 'failed', 'cancelled']);

export function jobView(job: Job): JobView {
  return {
    id: job.id,
    machineId: job.machineId,
    ownerId: job.ownerId,
    type: job.type,
    status: job.status,
    payload: job.payload,
    ...(job.result !== null ? { result: job.result } : { result: null }),
    ...(job.error !== null ? { error: job.error } : {}),
    attempts: job.attempts,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export class JobService {
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: JobServiceDeps,
    private readonly opts: { ackTimeoutMs: number; sweepIntervalMs: number; maxAttempts: number },
  ) {}

  start(): void {
    if (this.sweepTimer) return;
    // Ack-timeout sweep: a `dispatched` job whose daemon never acknowledged
    // work (no progress) reverts to queued for redelivery. `running` jobs are
    // NEVER swept by timer — the daemon may legitimately still be working;
    // disconnect is their recovery path.
    this.sweepTimer = setInterval(() => void this.sweep(), this.opts.sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  private async sweep(): Promise<void> {
    const cutoff = Date.now() - this.opts.ackTimeoutMs;
    for (const job of await this.deps.uow.jobs.listRecoverable()) {
      if (job.status !== 'dispatched') continue;
      if (Date.parse(job.updatedAt) > cutoff) continue;
      await this.requeue(job, 'dispatch ack timeout');
    }
  }

  private async requeue(job: Job, reason: string): Promise<Job> {
    const attempts = job.attempts + 1;
    const now = new Date().toISOString();
    if (attempts >= this.opts.maxAttempts) {
      const failed = await this.deps.uow.jobs.save({
        ...job,
        status: 'failed',
        error: `job abandoned after ${attempts} delivery attempts (last: ${reason})`,
        attempts,
        updatedAt: now,
      });
      this.deps.update(jobView(failed));
      return failed;
    }
    const queued = await this.deps.uow.jobs.save({
      ...job,
      status: 'queued',
      attempts,
      updatedAt: now,
    });
    this.deps.update(jobView(queued));
    return queued;
  }

  async createJob(input: {
    machineId: string;
    ownerId: string;
    type: 'deploy' | 'harness';
    payload: Record<string, unknown>;
  }): Promise<Job> {
    const now = new Date().toISOString();
    const job: Job = {
      id: generateId(),
      machineId: input.machineId,
      ownerId: input.ownerId,
      type: input.type,
      status: 'queued',
      payload: input.payload,
      result: null,
      error: null,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.uow.jobs.save(job);
    this.deps.update(jobView(job));
    await this.tryDispatch(job);
    return (await this.deps.uow.jobs.findById(job.id))!;
  }

  /** Dispatch if queued and the daemon is online (no-op otherwise). */
  private async tryDispatch(job: Job): Promise<void> {
    if (job.status !== 'queued') return;
    if (!this.deps.isOnline(job.machineId)) return;
    const dispatched = await this.deps.uow.jobs.save({
      ...job,
      status: 'dispatched',
      updatedAt: new Date().toISOString(),
    });
    this.deps.update(jobView(dispatched));
    this.deps.dispatch(jobView(dispatched));
  }

  /** Machine came online — drain its queue (oldest first). */
  async dispatchPending(machineId: string): Promise<void> {
    const jobs = (await this.deps.uow.jobs.listByMachine(machineId))
      .filter((j) => j.status === 'queued')
      .reverse(); // listByMachine is newest-first
    for (const job of jobs) {
      await this.tryDispatch(job);
    }
  }

  /** Daemon reported progress — accepted for queued/dispatched/running. */
  async onProgress(machineId: string, event: JobProgressEvent): Promise<void> {
    const job = await this.deps.uow.jobs.findById(event.jobId);
    if (!job || job.machineId !== machineId) return;
    if (job.status === 'running' || TERMINAL.has(job.status)) return;
    const running = await this.deps.uow.jobs.save({
      ...job,
      status: 'running',
      updatedAt: new Date().toISOString(),
    });
    this.deps.update(jobView(running));
  }

  /** Daemon reported a terminal result. */
  async onResult(machineId: string, event: JobResultEvent): Promise<void> {
    const job = await this.deps.uow.jobs.findById(event.jobId);
    if (!job || job.machineId !== machineId) return;
    if (TERMINAL.has(job.status)) return; // stale replay — ignore
    const now = new Date().toISOString();
    if (!event.ok) {
      const failed = await this.deps.uow.jobs.save({
        ...job,
        status: 'failed',
        error: event.error ?? 'unknown error',
        result: null,
        updatedAt: now,
      });
      this.deps.update(jobView(failed));
      return;
    }
    const succeeded = await this.deps.uow.jobs.save({
      ...job,
      status: 'succeeded',
      result: event.data ?? null,
      error: null,
      updatedAt: now,
    });
    this.deps.update(jobView(succeeded));

    if (job.type === 'deploy') {
      const parsed = deployResultDataSchema.safeParse(event.data);
      // #6: marketplace deploys (claude-code plugins) never register an
      // AgentInstance — Claude Code owns the install, and a plugin install is
      // not a runtime install; chat keys off the runtime detector's instance.
      if (parsed.success && parsed.data.method !== 'marketplace') {
        await this.registerInstance(succeeded, parsed.data);
      }
    }
  }

  /**
   * Deploy succeeded — upsert the AgentInstance. Identity: re-deploying the
   * same (machine, profile) upgrades that row; deploying onto a target with a
   * DETECTED instance (Phase 9 W1) upgrades that row in place; otherwise a
   * fresh `source: 'deploy'` row.
   */
  private async registerInstance(
    job: Job,
    data: {
      name: string;
      directory: string;
      target: string;
      profileId: string;
      profileVersion?: string | undefined;
    },
  ): Promise<void> {
    const now = new Date().toISOString();
    const target = data.target as AgentInstance['target'];
    const existing =
      (await this.deps.uow.agentInstances.findByMachineAndProfile(job.machineId, data.profileId)) ??
      (await this.deps.uow.agentInstances.findByMachineAndTarget(job.machineId, target));
    const instance: AgentInstance = {
      id: existing?.id ?? generateId(),
      machineId: job.machineId,
      ownerId: job.ownerId,
      target,
      profileId: data.profileId,
      profileVersion: data.profileVersion ?? null,
      source: 'deploy',
      name: data.name,
      directory: data.directory,
      jobId: job.id,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await this.deps.uow.agentInstances.save(instance);
  }

  /** Cancel a queued job (dispatched/running already live on the daemon). */
  async cancel(jobId: string, requester: { id: string }): Promise<Job> {
    const job = await this.deps.uow.jobs.findById(jobId);
    if (!job || job.ownerId !== requester.id) {
      throw new AppError('Job not found', 404, 'JOB_NOT_FOUND');
    }
    if (job.status !== 'queued') {
      throw new AppError(
        `Job is already ${job.status} — only queued jobs can be cancelled`,
        409,
        'JOB_NOT_CANCELLABLE',
      );
    }
    const cancelled = await this.deps.uow.jobs.save({
      ...job,
      status: 'cancelled',
      updatedAt: new Date().toISOString(),
    });
    this.deps.update(jobView(cancelled));
    return cancelled;
  }

  /** Machine went offline — recoverable jobs requeue (or abandon) for replay. */
  async recoverMachine(machineId: string): Promise<void> {
    for (const job of await this.deps.uow.jobs.listRecoverable()) {
      if (job.machineId !== machineId) continue;
      if (job.status === 'queued') continue;
      await this.requeue(job, 'daemon disconnected');
    }
  }

  /** Machine is being deleted — drop its jobs/instances (cascade). */
  async purgeMachine(machineId: string): Promise<void> {
    await this.deps.uow.jobs.deleteByMachine(machineId);
    await this.deps.uow.agentInstances.deleteByMachine(machineId);
  }
}
