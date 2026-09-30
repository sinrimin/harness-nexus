import type { FastifyInstance } from 'fastify';
import type { Machine, RuntimeConfig } from '@harness-nexus/core';
import {
  AppError,
  runtimeConfigGetRequestSchema,
  runtimeConfigSpecSchema,
  runtimeSpecUnsupportedReason,
  runtimeTargetSchema,
  type RuntimeConfigSpec,
  type RuntimeConfigView,
} from '@harness-nexus/shared';
import { generateId } from '../infra/crypto.js';
import { findCredentialForOwner } from '../infra/credential-scope.js';
import { jobView } from '../jobs/service.js';

/**
 * Runtime provider-config routes (Phase 9 W3 + W4).
 * wiki design-phase-9-harness-runtime.md §4.3/§6.
 *
 * One spec per (machine, target). Every route is OWNER-ONLY (404
 * existence-hiding, #36: machines are personal — admins are not overseers) and
 * PUT queues an `apply-config` harness job. The spec references a credential by
 * name; the referenced credential must be distributable (the plaintext leaves
 * the server inside the daemon's machine-PAT bundle) — the same gate the
 * dial-site model applies. The secret itself NEVER appears in any response
 * here; the daemon fetches `{spec, secret}` from `/api/client/runtime-config`.
 *
 * W4 adds the redacted effective-config view (§5/§6): a live round-trip to
 * the daemon (`runtime:config.get` → `runtime:config`), gated on presence +
 * the `runtime-config-view` capability, returning display-pathed files whose
 * secret-ish values the daemon has already masked.
 */
export async function runtimeConfigRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth] };

  const visibleMachine = async (id: string, requester: { id: string }): Promise<Machine> => {
    const machine = await app.uow.machines.findById(id);
    if (!machine || machine.ownerId !== requester.id) {
      throw new AppError('Machine not found', 404, 'MACHINE_NOT_FOUND');
    }
    return machine;
  };

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
      const machine = await visibleMachine(req.params.id, req.user!);
      const parsedTarget = runtimeTargetSchema.safeParse(req.params.target);
      if (!parsedTarget.success) {
        throw new AppError(
          `Target '${req.params.target}' is not runtime-managed`,
          400,
          'RUNTIME_TARGET_INVALID',
        );
      }
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
        target: parsedTarget.data,
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
      const machine = await visibleMachine(req.params.id, req.user!);
      const parsedTarget = runtimeTargetSchema.safeParse(req.params.target);
      if (!parsedTarget.success) {
        throw new AppError(
          `Target '${req.params.target}' is not runtime-managed`,
          400,
          'RUNTIME_TARGET_INVALID',
        );
      }
      const row = await app.uow.runtimeConfigs.findByMachineAndTarget(
        machine.id,
        parsedTarget.data,
      );
      if (!row) {
        throw new AppError('No runtime config for this target', 404, 'RUNTIME_CONFIG_NOT_FOUND');
      }
      return { config: toView(row) };
    },
  );

  // ---- PUT /api/machines/:id/runtime-config/:target — upsert + queue apply-config ----
  app.put<{ Params: { id: string; target: string } }>(
    '/api/machines/:id/runtime-config/:target',
    guard,
    async (req, reply) => {
      const machine = await visibleMachine(req.params.id, req.user!);
      const parsedTarget = runtimeTargetSchema.safeParse(req.params.target);
      if (!parsedTarget.success) {
        throw new AppError(
          `Target '${req.params.target}' is not runtime-managed`,
          400,
          'RUNTIME_TARGET_INVALID',
        );
      }
      const target = parsedTarget.data;

      const spec: RuntimeConfigSpec = runtimeConfigSpecSchema.parse(req.body);
      const unsupported = runtimeSpecUnsupportedReason(target, spec);
      if (unsupported !== null) {
        throw new AppError(unsupported, 409, 'RUNTIME_CONFIG_UNSUPPORTED');
      }

      // The credential gate (dial-site rules): the plaintext must be allowed to
      // leave the server, and it must resolve in the CALLER's namespace (#21) —
      // another user's same-named personal secret does not exist as far as
      // this caller is concerned.
      const cred = await findCredentialForOwner(app.uow, spec.credentialName, req.user!.id);
      if (!cred) {
        throw new AppError(
          `Credential "${spec.credentialName}" not found`,
          404,
          'CREDENTIAL_NOT_FOUND',
        );
      }
      if (!cred.distributable) {
        throw new AppError(
          `Credential "${spec.credentialName}" is not distributable — a runtime config's key is applied on the machine (opt in via the credential's distributable flag)`,
          409,
          'CREDENTIAL_NOT_DISTRIBUTABLE',
        );
      }

      // W10 — `providerId` is provenance only, but it must still name a
      // provider visible to the caller at PUT time (a dangling ref later is
      // fine: the spec is a snapshot and the form falls back to manual).
      if (spec.providerId !== undefined) {
        const provider = await app.uow.llmProviders.findById(spec.providerId);
        if (!provider || (provider.scope === 'personal' && provider.ownerId !== req.user!.id)) {
          throw new AppError('Provider not found', 404, 'PROVIDER_NOT_FOUND');
        }
      }

      // W10 — extra switchable models: dedupe and drop the default (the
      // writers prepend `model` themselves; the stored value is the extras
      // only, and an empty remainder normalizes back to null).
      const uniqueExtras =
        spec.models !== undefined ? [...new Set(spec.models)].filter((m) => m !== spec.model) : [];
      const models = uniqueExtras.length > 0 ? uniqueExtras : null;

      // Soft capability gate (harness jobs' rule): an online daemon without the
      // W3 config executor would settle the job as unsupported — refuse early.
      // An offline machine may queue.
      if (
        app.realtime.presence.isOnline(machine.id) &&
        !machine.capabilities.includes('runtime-config')
      ) {
        throw new AppError(
          'Daemon does not advertise the runtime-config capability (upgrade hnx on the machine)',
          409,
          'DAEMON_NO_RUNTIME_CONFIG',
        );
      }

      const existing = await app.uow.runtimeConfigs.findByMachineAndTarget(machine.id, target);
      const now = new Date().toISOString();
      const row: RuntimeConfig = {
        id: existing?.id ?? generateId(),
        machineId: machine.id,
        ownerId: machine.ownerId,
        target,
        spec: {
          providerLabel: spec.providerLabel,
          baseUrl: spec.baseUrl ?? null,
          api: spec.api,
          model: spec.model,
          credentialName: spec.credentialName,
          providerId: spec.providerId ?? null,
          models,
          extra: spec.extra ?? null,
        },
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await app.uow.runtimeConfigs.save(row);

      const job = await app.realtime.jobs.createJob({
        machineId: machine.id,
        ownerId: req.user!.id,
        type: 'harness',
        payload: { type: 'harness', action: 'apply-config', target },
      });
      return reply.code(existing ? 200 : 201).send({ config: toView(row), job: jobView(job) });
    },
  );
}
