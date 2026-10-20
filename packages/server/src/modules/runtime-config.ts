// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { FastifyInstance } from 'fastify';
import type { RuntimeConfig } from '@harness-nexus/core';
import {
  AppError,
  runtimeConfigGetRequestSchema,
  type RuntimeConfigView,
} from '@harness-nexus/shared';
import { jobView } from '../jobs/service.js';
import { principalOf } from './principal.js';
import {
  getRuntimeConfig,
  planRuntimeConfigUpsert,
  resolveRuntimeTarget,
  saveRuntimeConfig,
} from '../services/runtime-config.js';

/**
 * Runtime provider-config routes (Phase 9 W3 + W4) — the HTTP shell over the
 * pure decisions in `services/runtime-config.ts` (#53 slice 14).
 * wiki design-phase-9-harness-runtime.md §4.3/§6.
 *
 * One spec per (machine, target). Every route is OWNER-ONLY (404
 * existence-hiding, #36: machines are personal — admins are not overseers) and
 * PUT queues an `apply-config` harness job. The spec references a credential by
 * name; the referenced credential must be distributable (the plaintext leaves
 * the server inside the daemon's machine-PAT bundle) — the same gate the
 * dial-site model applies. The secret itself NEVER appears in any response
 * here; the daemon fetches `{spec, secret}` from `/api/client/runtime-config`.
 */
export async function runtimeConfigRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth] };

  const toView = (row: RuntimeConfig): RuntimeConfigView => ({
    machineId: row.machineId,
    target: row.target,
    providerLabel: row.spec.providerLabel,
    ...(row.spec.baseUrl !== null ? { baseUrl: row.spec.baseUrl } : {}),
    api: row.spec.api,
    model: row.spec.model,
    credentialName: row.spec.credentialName,
    ...(row.spec.providerId !== null && row.spec.providerId !== undefined
      ? { providerId: row.spec.providerId }
      : {}),
    ...(row.spec.models !== null && row.spec.models !== undefined
      ? { models: row.spec.models }
      : {}),
    ...(row.spec.modelEntries !== null && row.spec.modelEntries !== undefined
      ? { modelEntries: row.spec.modelEntries }
      : {}),
    ...(row.spec.claudeCode !== null && row.spec.claudeCode !== undefined
      ? { claudeCode: row.spec.claudeCode }
      : {}),
    ...(row.spec.opencode !== null && row.spec.opencode !== undefined
      ? { opencode: row.spec.opencode }
      : {}),
    ...(row.spec.codex !== null && row.spec.codex !== undefined ? { codex: row.spec.codex } : {}),
    ...(row.spec.deepseek !== null && row.spec.deepseek !== undefined
      ? { deepseek: row.spec.deepseek }
      : {}),
    ...(row.spec.pi !== null && row.spec.pi !== undefined ? { pi: row.spec.pi } : {}),
    ...(row.spec.extra !== null ? { extra: row.spec.extra } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  // ---- GET /api/machines/:id/runtimes/:target/config — redacted view (W4) ----
  // Live round-trip to the daemon: the files are masked DAEMON-SIDE before
  // they ever reach the server. Requires the machine online (nothing is
  // cached — a stale config view would lie) and the viewer capability.
  app.get<{ Params: { id: string; target: string } }>(
    '/api/machines/:id/runtimes/:target/config',
    guard,
    async (req) => {
      const { machine, target } = await resolveRuntimeTarget(
        { uow: app.uow },
        principalOf(req),
        req.params.id,
        req.params.target,
      );
      // #53 residue: the whole W4 arm is a live daemon round-trip — presence,
      // the capability the LIVE daemon advertised, the ctl emit, and the
      // waiter are realtime-only concerns (services decide, callers act).
      // Order matters: an offline machine (capabilities not yet mirrored
      // onto the row) must answer MACHINE_OFFLINE, not
      // DAEMON_NO_RUNTIME_CONFIG_VIEW (config-view.test.ts pins it).
      if (!app.realtime.presence.isOnline(machine.id)) {
        throw new AppError('Machine daemon is offline', 409, 'MACHINE_OFFLINE');
      }
      if (!machine.capabilities.includes('runtime-config-view')) {
        throw new AppError(
          'Daemon does not advertise the runtime-config-view capability (upgrade hnx on the machine)',
          409,
          'DAEMON_NO_RUNTIME_CONFIG_VIEW',
        );
      }
      const { requestId, done } = app.realtime.configView.awaitView(machine.id);
      const request = runtimeConfigGetRequestSchema.parse({
        requestId,
        target,
      });
      app.io.of('/ctl').to(`machine:${machine.id}`).emit('runtime:config.get', request);
      const outcome = await done;
      if (!outcome.ok) {
        if (outcome.reason === 'disconnected') {
          throw new AppError('Machine daemon is offline', 409, 'MACHINE_OFFLINE');
        }
        throw new AppError('Daemon did not answer the config view in time', 504, 'VIEW_TIMEOUT');
      }
      const view = outcome.view!;
      if (view.error !== undefined) {
        throw new AppError(view.error, 502, 'DAEMON_VIEW_FAILED');
      }
      return { target: view.target, files: view.files ?? [], redacted: view.redacted };
    },
  );

  // ---- GET /api/machines/:id/runtime-config/:target — echo the spec (never a secret) ----
  app.get<{ Params: { id: string; target: string } }>(
    '/api/machines/:id/runtime-config/:target',
    guard,
    async (req) => {
      const row = await getRuntimeConfig(
        { uow: app.uow },
        principalOf(req),
        req.params.id,
        req.params.target,
      );
      return { config: toView(row) };
    },
  );

  // ---- PUT /api/machines/:id/runtime-config/:target — upsert + queue apply-config ----
  app.put<{ Params: { id: string; target: string } }>(
    '/api/machines/:id/runtime-config/:target',
    guard,
    async (req, reply) => {
      const plan = await planRuntimeConfigUpsert(
        { uow: app.uow },
        principalOf(req),
        req.params.id,
        req.params.target,
        req.body,
      );

      // #53 residue: the soft capability gate reads LIVE presence (an online
      // daemon without the W3 config executor would settle the job as
      // unsupported — refuse early; an offline machine may queue). It stays
      // BETWEEN the service's validation (above) and its save (below):
      // hoisting it would reorder observable failures (409 capability before
      // the 404/409 credential gates), deferring it would persist a row the
      // gate then rejects. Hence the plan → gate → save split.
      if (
        app.realtime.presence.isOnline(plan.machine.id) &&
        !plan.machine.capabilities.includes('runtime-config')
      ) {
        throw new AppError(
          'Daemon does not advertise the runtime-config capability (upgrade hnx on the machine)',
          409,
          'DAEMON_NO_RUNTIME_CONFIG',
        );
      }

      const row = await saveRuntimeConfig({ uow: app.uow }, plan);

      // #53 residue: dispatch — queue the apply-config harness job AFTER the
      // save (createJob dispatches to the daemon when online).
      const job = await app.realtime.jobs.createJob({
        machineId: plan.machine.id,
        ownerId: req.user!.id,
        type: 'harness',
        payload: { type: 'harness', action: 'apply-config', target: plan.row.target },
      });
      return reply.code(plan.created ? 201 : 200).send({ config: toView(row), job: jobView(job) });
    },
  );
}
