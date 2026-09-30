import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Machine } from '@harness-nexus/core';
import {
  AppError,
  adaptersReportRequestSchema,
  createMachineJobSchema,
  deployJobPayloadSchema,
  sessionsListRequestSchema,
} from '@harness-nexus/shared';
import { jobView } from '../jobs/service.js';
import { marketplaceNameFor } from '../marketplace/emitter.js';

/**
 * Deploy jobs + harness jobs + agent instances (Phase 8 C4 · Phase 9 W2).
 * wiki design-phase-8-c4.md · phase-9-harness-runtime.md §4.2.
 *
 * All machine-scoped endpoints inherit the machine OWNER guard with 404
 * existence-hiding (#36: admins are not tenant overseers — a machine is
 * personal like a credential). A deploy job is fire-and-forget replayable
 * work: it queues when the daemon is offline and drains on reconnect; the
 * daemon executes it through the unchanged 3.3 pipeline against a deploy
 * bundle fetched with its own machine PAT. A harness job (W2)
 * installs/upgrades/pins the harness runtime — OWNER-ONLY to create and gated
 * on the daemon's `harness` capability when online.
 */

/**
 * Targets that have a local-write install adapter in the CLI registry.
 * claude-code branches BEFORE this list (#6): its deploys ride the 3.5
 * marketplace emitter — the daemon drives CC's own `claude plugin` CLI, not
 * an adapter. deepseek (T1) writes skills + a home cordis-patch MCP row like
 * the others.
 */
export const DEPLOYABLE_TARGETS = ['hermes', 'codex', 'deepseek', 'pi'] as const;

export async function jobsRoutes(app: FastifyInstance): Promise<void> {
  const guard = { preHandler: [app.requireAuth] };

  const visibleMachine = async (id: string, requester: { id: string }): Promise<Machine> => {
    const machine = await app.uow.machines.findById(id);
    if (!machine || machine.ownerId !== requester.id) {
      throw new AppError('Machine not found', 404, 'MACHINE_NOT_FOUND');
    }
    return machine;
  };

  // ---- POST /api/machines/:id/jobs — create a deploy or harness job ----
  app.post<{ Params: { id: string } }>('/api/machines/:id/jobs', guard, async (req, reply) => {
    const machine = await visibleMachine(req.params.id, req.user!);
    const input = createMachineJobSchema.parse(req.body);

    if (input.type === 'harness') {
      if (input.action === 'apply-config') {
        // Provider config is managed as a SPEC (upsert + queue), not a bare
        // job body — point the caller at the dedicated surface.
        throw new AppError(
          'Use PUT /api/machines/:id/runtime-config/:target to apply provider config',
          409,
          'USE_RUNTIME_CONFIG_ENDPOINT',
        );
      }
      // Soft capability gate (deploy's rule): an ONLINE daemon without the
      // harness executor would settle every job as unsupported — refuse early.
      // An OFFLINE machine may queue; capability is knowable once hello'd.
      if (app.realtime.presence.isOnline(machine.id) && !machine.capabilities.includes('harness')) {
        throw new AppError(
          'Daemon does not advertise the harness capability (upgrade hnx on the machine)',
          409,
          'DAEMON_NO_HARNESS',
        );
      }
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
    const profile = await app.uow.profiles.findById(deployInput.profileId);
    const profileVisible =
      profile && (profile.scope === 'global' || profile.ownerId === req.user!.id);
    if (!profile || !profileVisible) {
      throw new AppError('Profile not found', 404, 'PROFILE_NOT_FOUND');
    }
    // Soft capability gate: an online daemon without the 'deploy' capability
    // would silently abandon-cycle (dispatch → ack-timeout → requeue). An
    // OFFLINE machine is allowed to queue — capability is only knowable once
    // the daemon says hello.
    if (app.realtime.presence.isOnline(machine.id) && !machine.capabilities.includes('deploy')) {
      throw new AppError(
        'Daemon does not advertise the deploy capability (upgrade hnx on the machine)',
        409,
        'DAEMON_NO_DEPLOY',
      );
    }
    if (!DEPLOYABLE_TARGETS.includes(profile.target as (typeof DEPLOYABLE_TARGETS)[number])) {
      if (profile.target === 'claude-code') {
        // #6 — marketplace deploy: the daemon drives CC's own plugin CLI with
        // its machine PAT (the emitter accepts machine-ctl tokens). The
        // catalog the daemon reads belongs to the MACHINE OWNER, so the
        // profile must be visible to them — global, or personal + theirs.
        // (An admin deploying their own personal profile onto a user's
        // machine would emit a catalog that never contains it.)
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
        if (profile.scope !== 'global' && profile.ownerId !== machine.ownerId) {
          throw new AppError(
            "claude-code deploys install from the machine owner's marketplace — the profile must be global or owned by the machine owner",
            409,
            'PROFILE_NOT_IN_OWNER_MARKETPLACE',
          );
        }
        const owner = await app.uow.users.findById(machine.ownerId);
        if (!owner) throw new AppError('Machine not found', 404, 'MACHINE_NOT_FOUND');
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
      throw new AppError(
        `Profiles for target '${profile.target}' are deployed via a path this instance does not serve`,
        409,
        'TARGET_NOT_DEPLOYABLE',
      );
    }

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
    const machine = await visibleMachine(req.params.id, req.user!);
    const jobs = await app.uow.jobs.listByMachine(machine.id);
    return { jobs: jobs.map(jobView) };
  });

  // ---- POST /api/jobs/:jobId/cancel — queued only ----
  app.post<{ Params: { jobId: string } }>('/api/jobs/:jobId/cancel', guard, async (req) => {
    const job = await app.realtime.jobs.cancel(req.params.jobId, req.user!);
    return { job: jobView(job) };
  });

  // ---- GET /api/machines/:id/agents — deployed agent instances ----
  app.get<{ Params: { id: string } }>('/api/machines/:id/agents', guard, async (req) => {
    const machine = await visibleMachine(req.params.id, req.user!);
    const agents = await app.uow.agentInstances.listByMachine(machine.id);
    return { agents };
  });

  // ---- GET /api/agent-instances/:id — the chat session page's header (9 W6) ----
  // Chat itself is owner-ONLY by design, so the lookup is too: a non-owner
  // (admin included) gets the 404 rather than a machine reveal.
  app.get<{ Params: { id: string } }>('/api/agent-instances/:id', guard, async (req) => {
    const agent = await app.uow.agentInstances.findById(req.params.id);
    if (!agent || agent.ownerId !== req.user!.id) {
      throw new AppError('Agent instance not found', 404, 'AGENT_INSTANCE_NOT_FOUND');
    }
    const machine = await app.uow.machines.findById(agent.machineId);
    if (!machine) throw new AppError('Agent instance not found', 404, 'AGENT_INSTANCE_NOT_FOUND');
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
  app.get<{ Params: { id: string }; Querystring: { refresh?: string } }>(
    '/api/agent-instances/:id/sessions',
    guard,
    async (req) => {
      const agent = await app.uow.agentInstances.findById(req.params.id);
      if (!agent) throw new AppError('Agent instance not found', 404, 'AGENT_INSTANCE_NOT_FOUND');
      const machine = await visibleMachine(agent.machineId, req.user!);
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

  // ---- GET /api/machines/:id/adapters — live adapter processes (9 W11 C) ----
  // PROCESS truth from the daemon's live sessions map (never the ledger —
  // that is crash accounting), for the machine panel. Owner-or-admin like
  // every machine-scoped read; on-demand (the rail does not call this).
  app.get<{ Params: { id: string } }>('/api/machines/:id/adapters', guard, async (req) => {
    const machine = await visibleMachine(req.params.id, req.user!);
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
  app.post<{ Params: { id: string; sessionId: string } }>(
    '/api/machines/:id/adapters/:sessionId/close',
    guard,
    async (req) => {
      await visibleMachine(req.params.id, req.user!);
      const closed = await app.realtime.chat.forceCloseSession(req.params.sessionId, 'operator');
      if (!closed) {
        throw new AppError('Adapter channel not found', 404, 'ADAPTER_NOT_FOUND');
      }
      return { closed: true };
    },
  );
}
