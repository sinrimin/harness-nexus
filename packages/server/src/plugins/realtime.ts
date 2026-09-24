import type { FastifyInstance } from 'fastify';
import socketIOPlugin from 'fastify-socket.io';
import type { Server, Socket } from 'socket.io';
import type { Machine, Role } from '@harness-nexus/core';
import {
  REALTIME_PROTO_VERSION,
  appHandshakeAuthSchema,
  ctlHandshakeAuthSchema,
  machineHelloSchema,
  inventoryReportEventSchema,
  inventoryPayloadEventSchema,
  runtimeConfigViewEventSchema,
  type InventoryUpdatedEvent,
  type MachineStatusEvent,
} from '@harness-nexus/shared';
import { jobProgressEventSchema, jobResultEventSchema, type JobView } from '@harness-nexus/shared';
import {
  chatChannelsCloseAllRequestSchema,
  chatChannelsSyncRequestSchema,
  chatHistoryEventSchema,
  chatAdapterPrewarmRequestSchema,
  chatMessageSendRequestSchema,
  chatQueueCancelRequestSchema,
  chatPermissionRespondRequestSchema,
  chatElicitationRespondRequestSchema,
  chatConfigSetRequestSchema,
  chatSessionCloseRequestSchema,
  chatSessionClosedEventSchema,
  chatSessionOpenRequestSchema,
  chatSessionReadyEventSchema,
  chatStreamEventEnvelopeSchema,
  chatTurnCancelEventSchema,
  adaptersReportResultEventSchema,
  sessionsListResultEventSchema,
  workspaceListEventSchema,
} from '@harness-nexus/shared';
import { hashToken, PAT_PREFIX, generateId } from '../infra/crypto.js';
import { MachinePresence } from '../realtime/presence.js';
import { InventoryCoordinator } from '../realtime/inventory.js';
import { ConfigViewerCoordinator } from '../realtime/config-viewer.js';
import { WorkspaceCoordinator } from '../realtime/workspace.js';
import { SessionsCoordinator } from '../realtime/sessions.js';
import { AdaptersReportCoordinator } from '../realtime/adapters.js';
import { DetectedInstanceSync } from '../realtime/runtime-instances.js';
import { ChatService } from '../realtime/chat.js';
import { ReconnectGuard } from '../realtime/reconnect.js';
import { JobService } from '../jobs/service.js';

/**
 * Realtime channel (Phase 8) — Socket.IO attached to the Fastify HTTP server.
 *
 * One bidirectional namespace per client role (wiki design-phase-8-client.md):
 *   /ctl — daemon, authenticated by a machine PAT (scopes ['machine-ctl'])
 *          whose PAT record must map to the claimed machineId.
 *   /app — browser, authenticated by JWT or api PAT; joins `user:<id>`
 *          (+ `admins` for admins) and receives `machine:status` pushes.
 *
 * Machine tokens are rejected by the REST auth hook, so their blast radius is
 * exactly this channel.
 */

export interface RealtimeService {
  presence: MachinePresence;
  /** Scan/collect waiters for the inventory request/response flow (C3). */
  inventory: InventoryCoordinator;
  /** Job state machine (C4) — dispatch/recover driven by presence below. */
  jobs: JobService;
  /** Chat routing/gating/audit (C5) — /app ↔ /ctl with permission watchdogs. */
  chat: ChatService;
  /** Redacted config-view waiters (Phase 9 W4). */
  configView: ConfigViewerCoordinator;
  /** Workspace directory-listing waiters (Phase 9 W6 chat picker). */
  workspace: WorkspaceCoordinator;
  /** Native session-listing waiters (Phase 9 W7 chat rail). */
  sessions: SessionsCoordinator;
  /** Adapter-report waiters (Phase 9 W11 C machine panel). */
  adapters: AdaptersReportCoordinator;
  /** Push a machine's presence change to its owner (+ admins) on /app. */
  broadcastStatus(machine: Machine, online: boolean): void;
  /** Force-drop a machine's daemon sockets (revoke) and push offline if it was online. */
  disconnectMachine(machine: Machine): void;
}

export async function registerRealtime(
  app: FastifyInstance,
  opts: {
    maxHttpBufferSize: number;
    inventoryTimeoutMs: number;
    runtimeConfigViewTimeoutMs: number;
    workspaceListTimeoutMs: number;
    jobAckTimeoutMs: number;
    jobSweepIntervalMs: number;
    jobMaxAttempts: number;
    chatMaxSessionsPerMachine: number;
    chatMaxActiveSessionsPerMachine: number;
    chatPermissionTimeoutMs: number;
    chatReadyTimeoutMs: number;
    chatReconnectGraceMs: number;
    chatIdleTtlMs: number;
    sessionsListTimeoutMs: number;
    adaptersReportTimeoutMs: number;
  },
): Promise<void> {
  await app.register(socketIOPlugin, {
    cors: { origin: true },
    maxHttpBufferSize: opts.maxHttpBufferSize,
  });

  const ctl = app.io.of('/ctl');
  const appNs = app.io.of('/app');

  const presence = new MachinePresence();
  const inventory = new InventoryCoordinator(opts.inventoryTimeoutMs);
  const configView = new ConfigViewerCoordinator(opts.runtimeConfigViewTimeoutMs);
  const workspace = new WorkspaceCoordinator(opts.workspaceListTimeoutMs);
  const sessions = new SessionsCoordinator(opts.sessionsListTimeoutMs);
  const adapters = new AdaptersReportCoordinator(opts.adaptersReportTimeoutMs);
  const runtimeInstances = new DetectedInstanceSync(app.uow);
  const chat = new ChatService(
    {
      uow: app.uow,
      isOnline: (machineId) => presence.isOnline(machineId),
      io: {
        toCtl: (machineId, event, payload) => {
          ctl.to(`machine:${machineId}`).emit(event, payload);
        },
        toChannel: (sessionId, event, payload) => {
          appNs.to(`chan:${sessionId}`).emit(event, payload);
        },
        toUser: (userId, event, payload) => {
          appNs.to(`user:${userId}`).emit(event, payload);
        },
        joinChannel: (socketId, sessionId) => {
          const socket = appNs.sockets.get(socketId);
          if (socket) void socket.join(`chan:${sessionId}`);
        },
        isAppSocketLive: (socketId) => appNs.sockets.has(socketId),
        userSockets: async (userId) =>
          (await appNs.in(`user:${userId}`).fetchSockets()).map((s) => s.id),
      },
    },
    {
      maxSessionsPerMachine: opts.chatMaxSessionsPerMachine,
      maxActiveSessionsPerMachine: opts.chatMaxActiveSessionsPerMachine,
      permissionTimeoutMs: opts.chatPermissionTimeoutMs,
      readyTimeoutMs: opts.chatReadyTimeoutMs,
      idleTtlMs: opts.chatIdleTtlMs,
    },
  );
  const jobs = new JobService(
    {
      uow: app.uow,
      isOnline: (machineId) => presence.isOnline(machineId),
      dispatch: (job: JobView) => {
        app.io.of('/ctl').to(`machine:${job.machineId}`).emit('job:dispatch', { job });
      },
      update: (job: JobView) => {
        appNs.to([`user:${job.ownerId}`, 'admins']).emit('job:update', { job });
      },
    },
    {
      ackTimeoutMs: opts.jobAckTimeoutMs,
      sweepIntervalMs: opts.jobSweepIntervalMs,
      maxAttempts: opts.jobMaxAttempts,
    },
  );

  const statusEvent = (machine: Machine, online: boolean): MachineStatusEvent => ({
    machineId: machine.id,
    online,
    lastSeenAt: machine.lastSeenAt,
    ...(machine.daemonVersion !== null ? { daemonVersion: machine.daemonVersion } : {}),
  });

  // 9 W11 E — chat rows survive a sub-second daemon blip: the offline reap
  // is delayed by a grace window and a reconnect reconciles instead.
  const reconnect = new ReconnectGuard(chat, opts.chatReconnectGraceMs);

  const realtime: RealtimeService = {
    presence,
    inventory,
    jobs,
    chat,
    configView,
    workspace,
    sessions,
    adapters,
    broadcastStatus(machine, online) {
      appNs
        .to([`user:${machine.ownerId}`, 'admins'])
        .emit('machine:status', statusEvent(machine, online));
    },
    disconnectMachine(machine) {
      const wasOnline = presence.forceOffline(machine.id);
      app.io.of('/ctl').in(`machine:${machine.id}`).disconnectSockets(true);
      void chat.onMachineDeleted(machine.id);
      runtimeInstances.forgetMachine(machine.id);
      if (wasOnline) realtime.broadcastStatus(machine, false);
    },
  };
  app.decorate('realtime', realtime);

  const touchLastSeen = async (machine: Machine): Promise<Machine> => {
    const updated = { ...machine, lastSeenAt: new Date().toISOString() };
    await app.uow.machines.save(updated);
    return updated;
  };

  // ---- /ctl (daemon) ----

  app.io.of('/ctl').use(async (socket, next) => {
    const parsed = ctlHandshakeAuthSchema.safeParse(socket.handshake.auth);
    if (!parsed.success) return next(new Error('invalid handshake'));
    const { token, machineId } = parsed.data;

    if (!token.startsWith(PAT_PREFIX)) return next(new Error('machine token required'));
    const record = await app.uow.tokens.findByTokenHash(hashToken(token));
    if (!record || !record.scopes.includes('machine-ctl')) {
      return next(new Error('invalid machine token'));
    }
    if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) {
      return next(new Error('machine token expired'));
    }
    const user = await app.uow.users.findById(record.userId);
    if (!user || user.status !== 'active') return next(new Error('inactive user'));

    // The token must belong to exactly the machine it claims to be.
    const machine = await app.uow.machines.findByEnrollmentPatId(record.id);
    if (!machine || machine.id !== machineId) return next(new Error('machine mismatch'));

    socket.data.machineId = machine.id;
    next();
  });

  app.io.of('/ctl').on('connection', (socket: Socket) => {
    const machineId = socket.data.machineId as string;
    void socket.join(`machine:${machineId}`);

    // Presence registers SYNCHRONOUSLY, before the async lookup below: a
    // socket that dies inside that await would otherwise never be counted
    // off (its disconnect handler ran before connected() registered it, so
    // disconnected() found nothing to decrement) and the machine showed
    // online forever. Found via the 9 W11 C gates test (phantom presence).
    const cameOnline = presence.connected(machineId, socket.id);
    // #23 D2 — the posture readout renders presence, so a transition must not
    // wait out the cache window with the lamp showing the previous state.
    app.posture.invalidate();

    void (async () => {
      const machine = await app.uow.machines.findById(machineId);
      if (!machine) {
        // Deleted between handshake and connection — drop immediately (the
        // disconnect handler flips presence back off; it is registered).
        socket.disconnect(true);
        return;
      }
      // 9 W11 E — reconcile on EVERY connection (deliberately not only in
      // the offline→online branch: a reconnect can register the new socket
      // before the old disconnect is processed, so the machine never "went
      // offline" and the reap timer below is never armed — reconcile is
      // what flushes ghost rows in that race). The daemon answers with the
      // channels it actually holds; rows it does not hold are ghosts of a
      // restart/hard-death and close. No/invalid ack (a pre-W11 daemon)
      // falls back to the delayed reap.
      reconnect.onCtlConnect(socket, machineId);
      const updated = await touchLastSeen(machine);
      if (cameOnline) {
        realtime.broadcastStatus(updated, true);
        // The daemon is back — drain anything queued while it was offline.
        void realtime.jobs.dispatchPending(machineId);
      }
    })();

    socket.on('machine:hello', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = machineHelloSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      void (async () => {
        const machine = await app.uow.machines.findById(machineId);
        if (!machine) {
          socket.disconnect(true);
          return;
        }
        const hello = parsed.data;
        await touchLastSeen({
          ...machine,
          daemonVersion: hello.daemonVersion,
          hostname: hello.hostname ?? machine.hostname,
          os: hello.os ?? machine.os,
          arch: hello.arch ?? machine.arch,
          capabilities: hello.capabilities,
        });
        ack?.({ proto: REALTIME_PROTO_VERSION, machineId });
      })();
    });

    // C3 — daemon scan result: validate, persist (latest per machine+target),
    // resolve any pending scan waiter, and push the freshness signal to /app.
    // W1 — the event's `runtimes` arm drives the detected AgentInstance sync.
    socket.on('inventory:report', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = inventoryReportEventSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      const snapshot = parsed.data.snapshot;
      void (async () => {
        const machine = await app.uow.machines.findById(machineId);
        if (!machine) {
          socket.disconnect(true);
          return;
        }
        const runtime = parsed.data.runtimes?.find((r) => r.target === snapshot.target) ?? null;
        const row = {
          id: generateId(),
          machineId,
          target: snapshot.target,
          daemonVersion: machine.daemonVersion,
          reportedAt: new Date().toISOString(),
          scannedAt: snapshot.scannedAt,
          agents: snapshot.agents,
          runtime,
        };
        await app.uow.inventories.save(row);
        inventory.onReport(machineId, row);
        const event: InventoryUpdatedEvent = {
          machineId,
          target: row.target,
          reportedAt: row.reportedAt,
        };
        app.io
          .of('/app')
          .to([`user:${machine.ownerId}`, 'admins'])
          .emit('inventory:updated', event);
        ack?.({ stored: true });
        // Detected-instance sync is idempotent and eventually consistent —
        // never block the report path (or its ack) on it.
        void runtimeInstances.onReport(machine, runtime, snapshot.agents[0]?.directory);
      })();
    });

    // C3 — collected artifact bodies for an import; resolve its waiter.
    socket.on('inventory:payload', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = inventoryPayloadEventSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      const known = inventory.onPayload(parsed.data.requestId, parsed.data.items);
      ack?.(known ? { accepted: true } : { error: 'unknown-request' });
    });

    // 9 W4 — daemon reply for `runtime:config.get`: resolve the waiter; a
    // late/unknown id (already timed out) is dropped.
    socket.on('runtime:config', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = runtimeConfigViewEventSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      const { requestId, ...view } = parsed.data;
      const known = configView.onView(requestId, view);
      ack?.(known ? { accepted: true } : { error: 'unknown-request' });
    });

    // 9 W6 — daemon reply for `workspace:list` (chat directory picker).
    socket.on('workspace:list', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = workspaceListEventSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      const { requestId, ...evt } = parsed.data;
      const known = workspace.onList(requestId, evt);
      ack?.(known ? { accepted: true } : { error: 'unknown-request' });
    });

    // 9 W7 — daemon reply for `sessions:list` (native session rail).
    socket.on('sessions:list:result', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = sessionsListResultEventSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      const { requestId, ...evt } = parsed.data;
      const known = sessions.onList(requestId, evt);
      ack?.(known ? { accepted: true } : { error: 'unknown-request' });
    });

    // 9 W11 C — daemon reply for `adapters:report` (the machine panel).
    socket.on('adapters:report:result', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = adaptersReportResultEventSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      const { requestId, ...evt } = parsed.data;
      const known = adapters.onReport(requestId, evt);
      ack?.(known ? { accepted: true } : { error: 'unknown-request' });
    });

    // C4 — daemon job reporting. Progress accepts queued/dispatched/running;
    // result settles the job (terminal states ignore stale replay).
    socket.on('job:progress', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = jobProgressEventSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      ack?.({ accepted: true });
      void realtime.jobs.onProgress(machineId, parsed.data);
    });

    socket.on('job:result', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = jobResultEventSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      ack?.({ accepted: true });
      void realtime.jobs.onResult(machineId, parsed.data);
    });

    // C5 — daemon chat reporting. Ready closes the starting phase (or the
    // channel on spawn failure); events fan out to the channel room.
    socket.on('chat:session.ready', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = chatSessionReadyEventSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      ack?.({ accepted: true });
      void realtime.chat.onReady(machineId, parsed.data);
    });

    socket.on('chat:event', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = chatStreamEventEnvelopeSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      void (async () => {
        const accepted = await realtime.chat.onStream(
          machineId,
          parsed.data.sessionId,
          parsed.data.event,
        );
        ack?.(accepted.ok ? { accepted: true } : { error: 'unknown-session' });
      })();
    });

    // 9 W7 — transcript batch for a (re)joined/resumed channel; relayed to the
    // room exactly like chat:event.
    socket.on('chat:history', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = chatHistoryEventSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      const accepted = realtime.chat.onHistory(machineId, parsed.data);
      ack?.(accepted.ok ? { accepted: true } : { error: 'unknown-session' });
    });

    socket.on('chat:session.closed', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = chatSessionClosedEventSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      ack?.({ closed: true });
      void realtime.chat.onDaemonClosed(machineId, parsed.data.sessionId, parsed.data.reason);
    });

    socket.on('disconnect', (reason: string) => {
      const wentOffline = presence.disconnected(socket.id);
      if (wentOffline === null) return;
      app.posture.invalidate();
      inventory.failMachine(wentOffline);
      configView.failMachine(wentOffline);
      workspace.failMachine(wentOffline);
      sessions.failMachine(wentOffline);
      adapters.failMachine(wentOffline);
      realtime.jobs.recoverMachine(wentOffline);
      // Channels die with the daemon connection; the AGENT sessions survive
      // on the machine (9 W7) — viewers are notified via chat:session.closed.
      // 9 W11 E: a BLIP (transport close/error, ping timeout) delays the reap
      // by the grace window — Socket.IO rides it out and a reconnect
      // reconciles. A DELIBERATE close (the daemon called disconnect: stop()
      // or restart) mirrors the daemon side and reaps immediately — that
      // daemon already tore its sessions down.
      if (reason === 'client namespace disconnect' || reason === 'io server disconnect') {
        void realtime.chat.onMachineOffline(wentOffline);
      } else {
        reconnect.onWentOffline(wentOffline);
      }
      void (async () => {
        const machine = await app.uow.machines.findById(wentOffline);
        if (machine) {
          const updated = await touchLastSeen(machine);
          realtime.broadcastStatus(updated, false);
        }
      })();
    });
  });

  // ---- /app (browser) ----

  app.io.of('/app').use(async (socket, next) => {
    const parsed = appHandshakeAuthSchema.safeParse(socket.handshake.auth);
    if (!parsed.success) return next(new Error('invalid handshake'));
    const token = parsed.data.token;

    let user: { id: string; role: Role } | null = null;
    if (!token.startsWith(PAT_PREFIX)) {
      try {
        const payload = await app.jwt.verifyAccessToken(token);
        const u = await app.uow.users.findById(payload.sub);
        if (u && u.status === 'active') user = { id: u.id, role: u.role };
      } catch {
        user = null;
      }
    } else {
      const record = await app.uow.tokens.findByTokenHash(hashToken(token));
      const usable =
        record &&
        (!record.expiresAt || Date.parse(record.expiresAt) > Date.now()) &&
        !record.scopes.includes('marketplace') &&
        !record.scopes.includes('machine-ctl');
      if (usable) {
        const u = await app.uow.users.findById(record!.userId);
        if (u && u.status === 'active') user = { id: u.id, role: u.role };
      }
    }
    if (!user) return next(new Error('unauthorized'));

    socket.data.userId = user.id;
    socket.data.role = user.role;
    next();
  });

  app.io.of('/app').on('connection', (socket: Socket) => {
    void socket.join(`user:${socket.data.userId as string}`);
    if (socket.data.role === 'admin') void socket.join('admins');
    // 9 W11 B — fresh /app sockets get the live-channel snapshot immediately
    // (the tab bar's initial paint; later changes arrive as pushes).
    realtime.chat.sendSnapshot(socket.data.userId as string);

    // C5 — interactive chat handlers. Every handler validates its payload and
    // re-verifies ownership against `socket.data.userId` (envelope identity
    // binding — a browser may only touch sessions it owns).
    socket.on('chat:session.open', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = chatSessionOpenRequestSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      const userId = socket.data.userId as string;
      void (async () => {
        const result = await realtime.chat.open(
          userId,
          parsed.data.agentInstanceId,
          parsed.data.sessionId,
          socket.id,
          parsed.data.directory,
          parsed.data.resume,
        );
        if (!result.ok) {
          ack?.({ error: result.code });
          return;
        }
        // Re-joining an already-ready channel: join immediately. A fresh
        // channel joins on `chat:session.ready` (the opener would otherwise
        // sit in a room for an agent that may fail to spawn).
        if (result.joined) void socket.join(`chan:${result.sessionId}`);
        // `phase` lets the browser settle its pane from the ack alone — the
        // ready push can predate the caller's event listeners.
        ack?.({ sessionId: result.sessionId, phase: result.phase });
      })();
    });

    // Issue #3 — best-effort adapter pre-warm (the session page fires it on
    // mount; ack false is a normal answer: switch off, offline, unsupported).
    socket.on('chat:adapter.prewarm', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = chatAdapterPrewarmRequestSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ accepted: false, error: 'proto:invalid' });
        return;
      }
      void (async () => {
        const result = await realtime.chat.prewarmAdapter(
          socket.data.userId as string,
          parsed.data.agentInstanceId,
        );
        ack?.(result.ok ? { accepted: true } : { accepted: false, error: result.code });
      })();
    });

    socket.on('chat:message.send', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = chatMessageSendRequestSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      const result = realtime.chat.onMessageSend(
        socket.data.userId as string,
        parsed.data.sessionId,
        parsed.data.content,
      );
      // #10 — `queued` tells the Sender its message parked in the slot (the
      // queue_state event follows as the durable truth).
      ack?.(result.ok ? { accepted: true, queued: result.queued } : { error: result.code });
    });

    // #10 — drop the parked send-queue entry (edit = cancel + re-draft).
    socket.on('chat:queue.cancel', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = chatQueueCancelRequestSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      const result = realtime.chat.onQueueCancel(socket.data.userId as string, parsed.data.sessionId);
      ack?.(result.ok ? { accepted: true } : { error: result.code });
    });

    socket.on('chat:turn.cancel', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = chatTurnCancelEventSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      const result = realtime.chat.onTurnCancel(
        socket.data.userId as string,
        parsed.data.sessionId,
      );
      ack?.(result.ok ? { accepted: true } : { error: result.code });
    });

    // 9 W9 A — switch the session's permission mode / a config option. The
    // shared schema discriminates the two arms; ownership + phase gate in the
    // service, the daemon owns the adapter RPC and the merged snapshots.
    socket.on('chat:config.set', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = chatConfigSetRequestSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      const { sessionId, ...set } = parsed.data;
      const result = realtime.chat.onConfigSet(socket.data.userId as string, sessionId, set);
      ack?.(result.ok ? { accepted: true } : { error: result.code });
    });

    socket.on('chat:permission.respond', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = chatPermissionRespondRequestSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      const result = realtime.chat.onPermissionRespond(
        socket.data.userId as string,
        parsed.data.sessionId,
        parsed.data.requestId,
        parsed.data.optionId,
      );
      ack?.(result.ok ? { accepted: true } : { error: result.code });
    });

    // 9 W14.1 — answer an elicitation (values verbatim; ownership in the service).
    socket.on('chat:elicitation.respond', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = chatElicitationRespondRequestSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      const { sessionId, requestId, action, values } = parsed.data;
      const result = realtime.chat.onElicitationRespond(
        socket.data.userId as string,
        sessionId,
        requestId,
        action,
        values,
      );
      ack?.(result.ok ? { accepted: true } : { error: result.code });
    });

    socket.on('chat:session.close', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = chatSessionCloseRequestSchema.safeParse(payload);
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      void (async () => {
        const result = await realtime.chat.close(
          socket.data.userId as string,
          parsed.data.sessionId,
          parsed.data.reason,
        );
        ack?.(result.ok ? { closed: true } : { error: result.code });
      })();
    });

    // 9 W11 B — the tab bar's 一键清理: close every live channel of the
    // caller. Busy channels defer (finish the turn, then close); idle ones
    // close now. Ack carries the counts for the toast.
    socket.on('chat:channels.closeAll', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = chatChannelsCloseAllRequestSchema.safeParse(payload ?? {});
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      void (async () => {
        const result = await realtime.chat.closeAll(
          socket.data.userId as string,
          parsed.data.idleOnly ?? false,
        );
        ack?.(result);
      })();
    });

    // 9 W11 B — a freshly MOUNTED tab bar asks for the current snapshot: the
    // connect-time push predates SPA navigations (the socket survives them),
    // so a page that mounted later would otherwise wait for the next table
    // change to learn the truth.
    socket.on('chat:channels.sync', (payload: unknown, ack?: (res: unknown) => void) => {
      const parsed = chatChannelsSyncRequestSchema.safeParse(payload ?? {});
      if (!parsed.success) {
        ack?.({ error: 'proto:invalid' });
        return;
      }
      ack?.(realtime.chat.snapshotFor(socket.data.userId as string));
    });

    // A viewer socket died (tab closed / full page refresh — SPA navigation
    // keeps the socket alive). Channels whose room is now EMPTY close so their
    // adapters die instead of piling up on the machine; a mid-turn channel
    // waits out the turn (ChatService.onViewerGone).
    socket.on('disconnect', () => {
      void realtime.chat.onViewerGone(socket.data.userId as string);
    });
  });
}

declare module 'fastify' {
  interface FastifyInstance {
    realtime: RealtimeService;
    /** Decorated by fastify-socket.io at runtime; its bundled types are minimal. */
    io: Server;
  }
}
