// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  AppError,
  adaptersReportRequestSchema,
  createMachineJobSchema,
  deployJobPayloadSchema,
  sessionsDeleteRequestSchema,
  sessionsListRequestSchema,
} from '@harness-nexus/shared';
import { jobView } from '../jobs/service.js';
import { marketplaceNameFor } from '../marketplace/emitter.js';
import { principalOf } from './principal.js';
import { getMachine } from '../services/machines.js';
import { getAgentInstance, listMachineAgents } from '../services/agent-instances.js';
import {
  assertDeployableTarget,
  assertHarnessJobAllowed,
  getVisibleDeployProfile,
  isDeployableTarget,
  listMachineJobs,
  requireProfileInOwnerMarketplace,
} from '../services/jobs.js';

/**
 * Deploy jobs + harness jobs + agent instances (Phase 8 C4 · Phase 9 W2).
 * wiki design-phase-8-c4.md · phase-9-harness-runtime.md §4.2.
 *
 * The pure decisions live in `services/jobs.ts` + `services/agent-instances.ts`
 * (#53 slices 16 + 3); this file owns the realtime orchestration that remains:
 * the soft capability gates (they read LIVE presence — an online daemon
 * without the executor is refused early; an offline machine may queue), every
 * `createJob` dispatch, and the /ctl round-trips (sessions rail, adapters
 * report). All machine-scoped endpoints inherit the machine OWNER guard with
 * 404 existence-hiding (#36: admins are not tenant overseers — a machine is
 * personal like a credential).
 */

export async function jobsRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth] };

  // ---- POST /api/machines/:id/jobs — create a deploy or harness job ----
  app.post<{ Params: { id: string } }>('/api/machines/:id/jobs', guard, async (req, reply) => {
    const machine = await getMachine({ uow: app.uow }, principalOf(req), req.params.id);
    const input = createMachineJobSchema.parse(req.body);

    if (input.type === 'harness') {
      assertHarnessJobAllowed(input);
      // #53 residue: the soft capability gate reads LIVE presence (deploy's
      // rule): an ONLINE daemon without the harness executor would settle
      // every job as unsupported — refuse early. An OFFLINE machine may
      // queue; capability is knowable once hello'd.
      if (app.realtime.presence.isOnline(machine.id) && !machine.capabilities.includes('harness')) {
        throw new AppError(
          'Daemon does not advertise the harness capability (upgrade hnx on the machine)',
          409,
          'DAEMON_NO_HARNESS',
        );
      }
      // #53 residue: dispatch (job state machine + /ctl emit + /app push).
      const job = await app.realtime.jobs.createJob({
        machineId: machine.id,
        ownerId: req.user!.id,
        type: 'harness',
        payload: input as unknown as Record<string, unknown>,
      });
      return reply.code(201).send({ job: jobView(job) });
    }

    const deployInput = deployJobPayloadSchema.parse({
      profileId: input.profileId,
      ...(input.directory !== undefined ? { directory: input.directory } : {}),
    });
    const profile = await getVisibleDeployProfile(
      { uow: app.uow },
      principalOf(req),
      deployInput.profileId,
    );
    // #53 residue: the soft capability gate reads LIVE presence: an online
    // daemon without the 'deploy' capability would silently abandon-cycle
    // (dispatch → ack-timeout → requeue). An OFFLINE machine is allowed to
    // queue — capability is only knowable once the daemon says hello.
    if (app.realtime.presence.isOnline(machine.id) && !machine.capabilities.includes('deploy')) {
      throw new AppError(
        'Daemon does not advertise the deploy capability (upgrade hnx on the machine)',
        409,
        'DAEMON_NO_DEPLOY',
      );
    }
    if (!isDeployableTarget(profile.target)) {
      if (profile.target === 'claude-code') {
        // #6 — marketplace deploy: the daemon drives CC's own plugin CLI with
        // its machine PAT (the emitter accepts machine-ctl tokens).
        // #53 residue: the marketplace-deploy capability gate reads LIVE
        // presence and must fire BEFORE the owner-marketplace 409 below
        // (jobs.test.ts pins: an online daemon without the capability answers
        // DAEMON_NO_MARKETPLACE_DEPLOY, not a profile error).
        if (
          app.realtime.presence.isOnline(machine.id) &&
          !machine.capabilities.includes('marketplace-deploy')
        ) {
          throw new AppError(
            'Daemon does not advertise the marketplace-deploy capability (upgrade hnx on the machine)',
            409,
            'DAEMON_NO_MARKETPLACE_DEPLOY',
          );
        }
        const owner = await requireProfileInOwnerMarketplace({ uow: app.uow }, profile, machine);
        // #53 residue: dispatch — the payload arm is emitter-shaped (baseUrl
        // from config, marketplace name from the owner's username).
        const job = await app.realtime.jobs.createJob({
          machineId: machine.id,
          ownerId: req.user!.id,
          type: 'deploy',
          payload: {
            profileId: profile.id,
            marketplace: {
              baseUrl: app.publicBaseUrl,
              marketplaceName: marketplaceNameFor(owner.username),
              pluginName: profile.name,
            },
          },
        });
        return reply.code(201).send({ job: jobView(job) });
      }
      assertDeployableTarget(profile.target);
    }

    // #53 residue: dispatch — the ordinary adapter pipeline (3.3).
    const job = await app.realtime.jobs.createJob({
      machineId: machine.id,
      ownerId: req.user!.id,
      type: 'deploy',
      payload: {
        profileId: profile.id,
        ...(deployInput.directory ? { directory: deployInput.directory } : {}),
      },
    });
    return reply.code(201).send({ job: jobView(job) });
  });

  // ---- GET /api/machines/:id/jobs — newest first ----
  app.get<{ Params: { id: string } }>('/api/machines/:id/jobs', guard, async (req) => {
    const jobs = await listMachineJobs({ uow: app.uow }, principalOf(req), req.params.id);
    return { jobs: jobs.map(jobView) };
  });

  // ---- POST /api/jobs/:jobId/cancel — queued only ----
  // #53 residue: cancellation runs on the realtime JobService (owner check +
  // queued-only transition + /app push live with the state machine).
  app.post<{ Params: { jobId: string } }>('/api/jobs/:jobId/cancel', guard, async (req) => {
    const job = await app.realtime.jobs.cancel(req.params.jobId, req.user!);
    return { job: jobView(job) };
  });

  // ---- GET /api/machines/:id/agents — deployed agent instances ----
  app.get<{ Params: { id: string } }>('/api/machines/:id/agents', guard, async (req) => {
    const agents = await listMachineAgents({ uow: app.uow }, principalOf(req), req.params.id);
    return { agents };
  });

  // ---- GET /api/agent-instances/:id — the chat session page's header (9 W6) ----
  // Chat itself is owner-ONLY by design, so the lookup is too: a non-owner
  // (admin included) gets the 404 rather than a machine reveal.
  app.get<{ Params: { id: string } }>('/api/agent-instances/:id', guard, async (req) => {
    const { agent, machine } = await getAgentInstance(
      { uow: app.uow },
      principalOf(req),
      req.params.id,
    );
    return {
      agent,
      machine: {
        id: machine.id,
        name: machine.name,
        online: app.realtime.presence.isOnline(machine.id),
        remoteChatEnabled: machine.remoteChatEnabled,
        baseWorkspace: machine.baseWorkspace,
        capabilities: machine.capabilities,
      },
    };
  });

  // ---- GET /api/agent-instances/:id/sessions — the agent's OWN sessions (9 W7) ----
  // Redefined from the dropped AcSession rows: the platform persists nothing
  // session-shaped; the rail lists what the target's native store holds,
  // fetched live through the daemon (`sessions:list` over /ctl). Listing is
  // owner-or-admin like every machine-scoped read; CHATTING is owner-only
  // (enforced in the chat service, not here).
  // #53 residue: the whole handler below the owner gates is a live /ctl
  // round-trip (presence, capability, emit, waiter, outcome mapping) plus
  // live-channel stitching — realtime-only concerns.
  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>(
    '/api/agent-instances/:id/sessions',
    guard,
    async (req) => {
      const agent = await app.uow.agentInstances.findById(req.params.id);
      if (!agent) throw new AppError('Agent instance not found', 404, 'AGENT_INSTANCE_NOT_FOUND');
      const machine = await getMachine({ uow: app.uow }, principalOf(req), agent.machineId);
      if (!app.realtime.presence.isOnline(machine.id)) {
        throw new AppError('Machine daemon is offline', 409, 'MACHINE_OFFLINE');
      }
      if (!machine.capabilities.includes('sessions')) {
        throw new AppError(
          'Daemon does not advertise the sessions capability (upgrade hnx on the machine)',
          409,
          'DAEMON_NO_SESSIONS',
        );
      }

      const requestId = randomUUID();
      // 9 W11 D — `?refresh=1` (the rail's manual refresh button) tells the
      // daemon to bypass its listing TTL cache. The flag is optional on the
      // wire, so pre-W11-D daemons simply strip it.
      const request = sessionsListRequestSchema.parse({
        requestId,
        target: agent.target,
        ...(req.query.refresh === '1' ? { refresh: true } : {}),
      });
      const { done } = app.realtime.sessions.awaitList(machine.id, requestId);
      app.io.of('/ctl').to(`machine:${machine.id}`).emit('sessions:list', request);
      const outcome = await done;
      // Error arm BEFORE the generic failure branches — a fast daemon error must
      // not read as a timeout (the W6 workspace lesson).
      if (!outcome.ok) {
        if (outcome.error !== undefined) {
          throw new AppError(outcome.error, 502, 'DAEMON_SESSIONS_FAILED');
        }
        if (outcome.reason === 'disconnected') {
          throw new AppError('Machine daemon is offline', 409, 'MACHINE_OFFLINE');
        }
        throw new AppError('Daemon did not answer the listing in time', 504, 'SESSIONS_TIMEOUT');
      }
      // Post-W8 visibility: mark rows whose native session currently holds a
      // live channel (and carry the channel id so a row click can REJOIN it —
      // resuming would spawn a second channel for the same agent session).
      // A live channel may also have NO native row yet (claude-code materializes
      // its transcript file only on the first message — "my new session never
      // showed up"): synthesize an open row from the channel itself.
      const openChannels = app.realtime.chat.channelsByNativeId(req.params.id);
      const rows = (outcome.sessions ?? []).map((s) =>
        openChannels.has(s.sessionId)
          ? { ...s, open: true, openChannelId: openChannels.get(s.sessionId) }
          : { ...s, open: false },
      );
      const channelCwds = app.realtime.chat.openChannelCwds(req.params.id);
      for (const [nativeId, cwd] of channelCwds) {
        if (openChannels.has(nativeId) && !rows.some((r) => r.sessionId === nativeId)) {
          rows.push({
            sessionId: nativeId,
            cwd,
            title: null,
            open: true,
            openChannelId: openChannels.get(nativeId),
          });
        }
      }
      return {
        agent,
        supported: outcome.supported ?? true,
        sessions: rows,
      };
    },
  );

  // ---- DELETE /api/agent-instances/:id/sessions/:sessionId (#55) ----
  // Delete one NATIVE session from the target's own store, via the daemon
  // (`sessions:delete` over /ctl — the same round-trip as the listing).
  // Owner-or-admin gate like the listing; a session holding a LIVE channel
  // is refused (close the chat first — deleting under a live adapter would
  // leave a zombie channel). #53 residue: the /ctl round-trip below the
  // gates is realtime-only concern.
  app.delete<{ Params: { id: string; sessionId: string } }>(
    '/api/agent-instances/:id/sessions/:sessionId',
    guard,
    async (req) => {
      const agent = await app.uow.agentInstances.findById(req.params.id);
      if (!agent) throw new AppError('Agent instance not found', 404, 'AGENT_INSTANCE_NOT_FOUND');
      const machine = await getMachine({ uow: app.uow }, principalOf(req), agent.machineId);
      if (!app.realtime.presence.isOnline(machine.id)) {
        throw new AppError('Machine daemon is offline', 409, 'MACHINE_OFFLINE');
      }
      if (!machine.capabilities.includes('sessions-delete')) {
        throw new AppError(
          'Daemon does not support session deletion (upgrade hnx on the machine)',
          409,
          'DAEMON_NO_SESSIONS_DELETE',
        );
      }
      if (app.realtime.chat.channelsByNativeId(req.params.id).has(req.params.sessionId)) {
        throw new AppError(
          'Session is open in a live channel — close the chat first',
          409,
          'NATIVE_SESSION_LIVE',
        );
      }
      const request = sessionsDeleteRequestSchema.parse({
        requestId: randomUUID(),
        target: agent.target,
        sessionId: req.params.sessionId,
      });
      const { done } = app.realtime.sessions.awaitDelete(machine.id, request.requestId);
      app.io.of('/ctl').to(`machine:${machine.id}`).emit('sessions:delete', request);
      const outcome = await done;
      // Error arm BEFORE the generic failure branches (the W6 lesson).
      if (!outcome.ok) {
        if (outcome.error !== undefined) {
          throw new AppError(outcome.error, 502, 'DAEMON_SESSION_DELETE_FAILED');
        }
        if (outcome.reason === 'disconnected') {
          throw new AppError('Machine daemon is offline', 409, 'MACHINE_OFFLINE');
        }
        throw new AppError(
          'Daemon did not answer the delete in time',
          504,
          'SESSIONS_DELETE_TIMEOUT',
        );
      }
      return { ok: true };
    },
  );

  // ---- GET /api/machines/:id/adapters — live adapter processes (9 W11 C) ----
  // PROCESS truth from the daemon's live sessions map (never the ledger —
  // that is crash accounting), for the machine panel. Owner-or-admin like
  // every machine-scoped read; on-demand (the rail does not call this).
  // #53 residue: like the sessions rail — a live /ctl round-trip.
  app.get<{ Params: { id: string } }>('/api/machines/:id/adapters', guard, async (req) => {
    const machine = await getMachine({ uow: app.uow }, principalOf(req), req.params.id);
    if (!app.realtime.presence.isOnline(machine.id)) {
      throw new AppError('Machine daemon is offline', 409, 'MACHINE_OFFLINE');
    }
    if (!machine.capabilities.includes('chat')) {
      throw new AppError(
        'Daemon does not advertise the chat capability (upgrade hnx on the machine)',
        409,
        'DAEMON_NO_CHAT',
      );
    }
    const request = adaptersReportRequestSchema.parse({ requestId: randomUUID() });
    const { done } = app.realtime.adapters.awaitReport(machine.id, request.requestId);
    app.io.of('/ctl').to(`machine:${machine.id}`).emit('adapters:report', request);
    const outcome = await done;
    if (!outcome.ok) {
      // Error arm BEFORE the generic failure branches (the W6 lesson).
      if (outcome.error !== undefined) {
        throw new AppError(outcome.error, 502, 'DAEMON_ADAPTERS_FAILED');
      }
      if (outcome.reason === 'disconnected') {
        throw new AppError('Machine daemon is offline', 409, 'MACHINE_OFFLINE');
      }
      // A pre-W11 daemon has no handler — the report just never answers.
      throw new AppError('Daemon did not answer the report in time', 504, 'ADAPTERS_TIMEOUT');
    }
    return { machineId: machine.id, adapters: outcome.adapters ?? [] };
  });

  // ---- POST /api/machines/:id/adapters/:sessionId/close — operator kill ----
  // The panel's 终止: closes the CHANNEL (daemon teardown + ledger audit
  // cleanup ride the ordinary close path). 404-hides an id that is not live.
  // #53 residue: force-close talks to the live channel registry.
  app.post<{ Params: { id: string; sessionId: string } }>(
    '/api/machines/:id/adapters/:sessionId/close',
    guard,
    async (req) => {
      await getMachine({ uow: app.uow }, principalOf(req), req.params.id);
      const closed = await app.realtime.chat.forceCloseSession(req.params.sessionId, 'operator');
      if (!closed) {
        throw new AppError('Adapter channel not found', 404, 'ADAPTER_NOT_FOUND');
      }
      return { closed: true };
    },
  );
}
