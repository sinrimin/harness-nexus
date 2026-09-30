import type { Socket } from 'socket.io-client';
import {
  jobDispatchEventSchema,
  harnessJobPayloadSchema,
  deployJobPayloadSchema,
  type JobView,
  deployResultDataSchema,
} from '@harness-nexus/shared';
import { HarnessNexusClient } from '@harness-nexus/sdk';
import { planInstall } from '../install/planner.js';
import { applyInstall } from '../install/installer.js';
import type { ResolvedProfile } from '../install/types.js';
import { runHarnessJob } from './runtime.js';
import { runApplyConfigJob } from './runtime-config.js';
import { runMarketplaceDeploy } from './cc-marketplace.js';
import { logOp } from './logbook.js';

/**
 * Daemon-side job executor (Phase 8 C4 + Phase 9 W2).
 * wiki design-phase-8-c4.md · phase-9-harness-runtime.md.
 *
 * A deploy job is the 3.3 pipeline with a different trigger: fetch the
 * resolved bundle with the machine PAT (`GET /api/client/deploy-bundle` —
 * machine PAT exception #2), plan, apply + ledger, reporting `job:progress`
 * per phase and one terminal `job:result`. A harness job (W2) runs the
 * runtime install/upgrade/pin command table instead. Plans are idempotent
 * overwrites, so a redelivered job (server recovered it after a disconnect)
 * simply re-runs. `scan`/`import` job types are reserved by the protocol —
 * C3's interactive flows handle them; arriving here they settle as
 * unsupported.
 */

export interface JobExecutorOptions {
  server: string;
  /** The daemon's machine PAT. */
  token: string;
}

export function attachJobHandlers(socket: Socket, opts: JobExecutorOptions): void {
  socket.on('job:dispatch', (payload: unknown, ack?: (res: unknown) => void) => {
    const parsed = jobDispatchEventSchema.safeParse(payload);
    if (!parsed.success) {
      ack?.({ error: 'proto:invalid' });
      return;
    }
    // Ack = ACCEPTED, not completed — the server's dispatched state means
    // "with the daemon", the terminal result arrives separately.
    ack?.({ accepted: true });
    const job = parsed.data.job;
    if (job.type === 'deploy') {
      void runDeploy(socket, opts, job);
      return;
    }
    if (job.type === 'harness') {
      const parsed = harnessJobPayloadSchema.safeParse(job.payload);
      if (!parsed.success) {
        // Old daemons settle unknown ACTIONS the same way — one shared answer.
        socket.emit('job:result', {
          jobId: job.id,
          ok: false,
          error: 'harness payload invalid (upgrade hnx on the machine)',
        });
        return;
      }
      if (parsed.data.action === 'apply-config') {
        void runApplyConfigJob(socket, opts, job);
        return;
      }
      void runHarnessJob(socket, job);
      return;
    }
    socket.emit('job:result', {
      jobId: job.id,
      ok: false,
      error: `job type '${job.type}' is not supported by this daemon`,
    });
  });
}

async function runDeploy(socket: Socket, opts: JobExecutorOptions, job: JobView): Promise<void> {
  const parsed = deployJobPayloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    socket.emit('job:result', {
      jobId: job.id,
      ok: false,
      error: 'deploy payload invalid (upgrade hnx on the machine)',
    });
    return;
  }
  // #6: the marketplace arm routes claude-code deploys to CC's own plugin CLI.
  if (parsed.data.marketplace) {
    await runMarketplaceDeploy(socket, job, parsed.data.profileId, parsed.data.marketplace, {
      token: opts.token,
    });
    return;
  }
  const payload = parsed.data;
  const startedAt = Date.now();
  const progress = (phase: string, message?: string): void => {
    socket.emit('job:progress', { jobId: job.id, phase, ...(message ? { message } : {}) });
  };
  const result = (ok: boolean, extra: { error?: string; data?: unknown }): void => {
    socket.emit('job:result', { jobId: job.id, ok, ...extra });
    // #38 — server-initiated deploys leave a trail on the machine they ran on.
    const target = (extra.data as { target?: string } | undefined)?.target;
    logOp({
      op: 'deploy',
      outcome: ok ? 'ok' : 'error',
      ms: Date.now() - startedAt,
      detail: `profile ${payload.profileId}${extra.error !== undefined ? ` — ${extra.error}` : ''}`,
      ...(target !== undefined ? { target } : {}),
    });
  };

  try {
    const client = new HarnessNexusClient({ baseUrl: opts.server, token: opts.token });
    progress('resolve', `fetching profile ${payload.profileId}`);
    const bundle = (await client.getDeployBundle(payload.profileId)) as ResolvedProfile;

    // Adapters read the server base from HN_SERVER when emitting the
    // `hnx mcp serve` shim entry (same as `hnx install`).
    process.env.HN_SERVER = opts.server;

    progress('plan', 'planning install');
    const plan = planInstall(bundle, {
      ...(payload.directory ? { input: { outDir: payload.directory } } : {}),
    });

    progress('apply', `writing ${plan.operations.length} operation(s)`);
    applyInstall(plan, {
      profileId: bundle.profile.id,
      profileName: bundle.profile.name,
      profileVersion: bundle.profile.version,
    });

    const data = deployResultDataSchema.parse({
      name: bundle.profile.name,
      directory: plan.targetRoot,
      target: plan.adapter.target,
      profileId: bundle.profile.id,
      ...(bundle.profile.version ? { profileVersion: bundle.profile.version } : {}),
    });
    result(true, { data });
  } catch (e) {
    result(false, { error: e instanceof Error ? e.message : String(e) });
  }
}
