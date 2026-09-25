import { resolve as resolvePath } from 'node:path';
import type { UnitOfWork } from '@harness-nexus/core';
import {
  DEFAULT_CHAT_PREWARM_SETTINGS,
  PREWARM_ADAPTER_TARGETS,
  isRuntimeTarget,
} from '@harness-nexus/shared';
import type {
  ChatChannelView,
  ChatStreamEvent,
  PromptBlock,
  PromptCapabilities,
} from '@harness-nexus/shared';
import { generateId } from '../infra/crypto.js';

/**
 * Chat routing + gating (Phase 8 C5, reworked 9 W7). wiki design-phase-8-c5.md
 * + wiki design-phase-9-w7-native-sessions.md.
 *
 * The platform never learns agent protocols and — since W7 — never persists
 * anything session-shaped: the session list, transcript, and resume mechanics
 * are the agent's OWN, read through the daemon on demand. This service is the
 * LIVE channel only: ownership + remote-chat gates, fanning the daemon's
 * semantic stream out to the `chan:<sessionId>` room, history relay, and the
 * guarantee that every permission request gets an answer (user decision or
 * timeout-cancel — never a dangling agent-side waiter). Closing a channel
 * kills a subprocess, never a session — the agent's store keeps it and
 * `sessions:list` keeps offering it.
 *
 * Transport-agnostic like JobService: realtime wires the emit/join callbacks
 * to /ctl rooms and /app channel rooms.
 */

export interface ChatIO {
  /** Send an event into the machine's /ctl room. */
  toCtl(machineId: string, event: string, payload: unknown): void;
  /** Send an event to every viewer of one channel (`chan:<sessionId>` on /app). */
  toChannel(sessionId: string, event: string, payload: unknown): void;
  /** Send an event to every /app socket of one user (`user:<id>` room). */
  toUser(userId: string, event: string, payload: unknown): void;
  /** Join a browser socket to a channel room (called when the agent is ready). */
  joinChannel(socketId: string, sessionId: string): void;
  /** Is that /app socket still connected? (Opener may vanish before ready.) */
  isAppSocketLive(socketId: string): boolean;
  /** Ids of the user's currently connected /app sockets (the `user:<id>` room). */
  userSockets(userId: string): Promise<string[]>;
}

export interface ChatServiceDeps {
  uow: UnitOfWork;
  /** Is the machine's daemon connected right now? */
  isOnline: (machineId: string) => boolean;
  io: ChatIO;
}

export type ChatOpenResult =
  | { ok: true; sessionId: string; joined: boolean; phase: 'starting' | 'ready' }
  | {
      ok: false;
      code:
        | 'AGENT_INSTANCE_NOT_FOUND'
        | 'SESSION_NOT_FOUND'
        | 'REMOTE_CHAT_DISABLED'
        | 'MACHINE_OFFLINE'
        | 'DAEMON_NO_CHAT'
        | 'SESSION_LIMIT_REACHED'
        | 'WORKSPACE_NOT_SET'
        | 'WORKSPACE_INVALID';
    };

export type ChatSimpleResult = { ok: true } | { ok: false; code: string };

/** #10 — `onMessageSend` distinguishes a direct send from a queued one. */
export type ChatSendResult = { ok: true; queued: boolean } | { ok: false; code: string };

/** A native-session resume arm as it travels browser → server → daemon (9 W7). */
export interface ChatResumeArm {
  sessionId: string;
  cwd: string;
}

interface LiveSession {
  sessionId: string;
  machineId: string;
  agentInstanceId: string;
  ownerId: string;
  /** Agent target — carried into the W11 channel snapshot (tab badge). */
  target: string;
  phase: 'starting' | 'ready';
  /** Working directory the channel was opened at (synthesized listing rows). */
  cwd: string;
  /** Last reported turn state — the server-side SESSION_BUSY gate. */
  busy: boolean;
  /**
   * #10 — the live Sender's send queue (SERVER-owned, depth 1). A message
   * sent while `busy` parks here instead of bouncing; the idle transition
   * in `onStream` flushes it as the next turn. `null` = slot free. Rides
   * the session record, so a channel close drops it for free.
   */
  queuedPrompt: PromptBlock[] | null;
  /** Viewers all left while a turn ran — close when the turn ends. */
  closeWhenIdle: boolean;
  /** When the channel was opened — the eviction order (oldest first). */
  openedAt: number;
  /**
   * 9 W11 D6 — when the channel last had a turn (open time until the first
   * turn ends). The idle-age surface: the tab label past 30 minutes and the
   * optional CHAT_IDLE_TTL_MS sweep both key off it.
   */
  lastActiveAt: number;
  /**
   * 9 W11 — the native session a RESUME open targets, recorded before the
   * daemon answers (nativeSessionId is only known at ready). Doubles as the
   * resume-dedupe key: one channel per (agent, native session).
   */
  resumingNativeId?: string;
  /** Reported agent identity — re-pushed to re-joining viewers. */
  agentName?: string | undefined;
  agentVersion?: string | undefined;
  /** The agent's OWN session id behind this channel (9 W7 row highlight). */
  nativeSessionId?: string | undefined;
  /** 9 W9 B — prompt-content capabilities (gates the attach UI). */
  promptCapabilities?: PromptCapabilities | undefined;
  /** Socket of the browser that opened the channel; joined on ready. */
  openerSocketId: string | null;
  readyTimer: NodeJS.Timeout | null;
  permissionTimers: Map<string, NodeJS.Timeout>;
  /** 9 W14.1 — elicitation watchdogs, same policy as permissions. */
  elicitationTimers: Map<string, NodeJS.Timeout>;
}

export class ChatService {
  private live = new Map<string, LiveSession>();

  private idleSweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly deps: ChatServiceDeps,
    private readonly opts: {
      maxSessionsPerMachine: number;
      maxActiveSessionsPerMachine: number;
      permissionTimeoutMs: number;
      readyTimeoutMs: number;
      /** 9 W11 D6 — 0 disables the idle TTL sweep (the default). */
      idleTtlMs: number;
    },
  ) {
    if (this.opts.idleTtlMs > 0) {
      // Cadence scales with the TTL (check at least every half-TTL) but is
      // bounded: 60s floor-to-ceiling for real TTLs, 1s minimum so a small
      // test TTL does not wait a minute for its first tick.
      const cadence = Math.max(1_000, Math.min(60_000, Math.ceil(this.opts.idleTtlMs / 2)));
      this.idleSweepTimer = setInterval(() => this.sweepIdle(), cadence);
      this.idleSweepTimer.unref();
    }
  }

  /** Graceful shutdown: notify viewers, tell the daemons to kill subprocesses. */
  async stop(): Promise<void> {
    if (this.idleSweepTimer !== null) {
      clearInterval(this.idleSweepTimer);
      this.idleSweepTimer = null;
    }
    for (const session of [...this.live.values()]) {
      await this.closeInternal(session, 'server-shutdown', { notifyDaemon: true });
    }
  }

  /**
   * `chat:session.open`. Without `sessionId`: create a channel (gating order is
   * normative — see the design doc). With an open `sessionId`: idempotent
   * re-join (page refresh) — returns the same id, spawns nothing, and asks the
   * daemon to re-push the channel's history (9 W7).
   *
   * `directory` (9 W6) picks a NEW session's project working directory: it must
   * be the machine's baseWorkspace or a subdirectory of it. `resume` (9 W7)
   * continues the agent's OWN session instead — its `cwd` came from the
   * daemon's listing (ground truth) and passes through verbatim, so no
   * containment check applies (dsh enforces its own match).
   */
  async open(
    ownerId: string,
    agentInstanceId: string,
    rejoinSessionId: string | undefined,
    openerSocketId: string,
    directory: string | undefined,
    resume: ChatResumeArm | undefined,
  ): Promise<ChatOpenResult> {
    if (rejoinSessionId !== undefined) {
      const existing = this.live.get(rejoinSessionId);
      if (!existing || existing.ownerId !== ownerId) {
        return { ok: false, code: 'SESSION_NOT_FOUND' };
      }
      return this.reattach(existing, openerSocketId);
    }

    // 9 W11 (user-found) — one channel per native session: a resume open
    // while another channel for the same (agent, native session) exists —
    // INCLUDING one still establishing — re-attaches it instead of spawning
    // a second adapter on the same agent session. The rail's 已打开 stamps
    // lag establishment (a starting channel has no native id to overlay),
    // so a row re-click mid-spawn used to duplicate the channel.
    if (resume !== undefined) {
      const existing = [...this.live.values()].find(
        (s) =>
          s.ownerId === ownerId &&
          s.agentInstanceId === agentInstanceId &&
          (s.resumingNativeId === resume.sessionId || s.nativeSessionId === resume.sessionId),
      );
      if (existing !== undefined) return this.reattach(existing, openerSocketId);
    }

    const agent = await this.deps.uow.agentInstances.findById(agentInstanceId);
    if (!agent || agent.ownerId !== ownerId) return { ok: false, code: 'AGENT_INSTANCE_NOT_FOUND' };
    const machine = await this.deps.uow.machines.findById(agent.machineId);
    if (!machine) return { ok: false, code: 'AGENT_INSTANCE_NOT_FOUND' };
    let cwd = agent.directory;
    if (resume !== undefined) {
      cwd = resume.cwd;
    } else if (directory !== undefined) {
      if (machine.baseWorkspace === null) return { ok: false, code: 'WORKSPACE_NOT_SET' };
      const root = resolvePath(machine.baseWorkspace);
      const wanted = resolvePath(directory);
      if (wanted !== root && !wanted.startsWith(root + '/')) {
        return { ok: false, code: 'WORKSPACE_INVALID' };
      }
      cwd = wanted;
    }
    if (!machine.remoteChatEnabled) return { ok: false, code: 'REMOTE_CHAT_DISABLED' };
    if (!this.deps.isOnline(machine.id)) return { ok: false, code: 'MACHINE_OFFLINE' };
    if (!machine.capabilities.includes('chat')) return { ok: false, code: 'DAEMON_NO_CHAT' };
    const openForMachine = [...this.live.values()].filter((s) => s.machineId === machine.id);
    if (openForMachine.length >= this.opts.maxSessionsPerMachine) {
      // Budget redesign (post-W8): a full TOTAL budget evicts instead of
      // rejecting — the OLDEST channel that is not mid-turn gives way (its
      // viewers see `chat:session.closed {reason:'evicted'}`). Only when every
      // channel is busy does the open actually bounce; with the active budget
      // (maxActiveSessionsPerMachine) strictly smaller than the total one,
      // that corner needs at least as many concurrent turns as the active
      // cap, i.e. real generation load on every slot.
      const victim = openForMachine
        .filter((s) => !s.busy)
        .sort((a, b) => a.openedAt - b.openedAt)[0];
      if (victim === undefined) return { ok: false, code: 'SESSION_LIMIT_REACHED' };
      await this.closeInternal(victim, 'evicted', { notifyDaemon: true });
    }

    const sessionId = generateId();
    // Join the opener NOW: spawn-failed / spawn-timeout notifications must
    // reach the browser even though the agent never came up.
    this.deps.io.joinChannel(openerSocketId, sessionId);
    const session: LiveSession = {
      sessionId,
      machineId: machine.id,
      agentInstanceId: agent.id,
      ownerId,
      target: agent.target,
      phase: 'starting',
      cwd,
      busy: false,
      queuedPrompt: null,
      closeWhenIdle: false,
      openedAt: Date.now(),
      lastActiveAt: Date.now(),
      ...(resume !== undefined ? { resumingNativeId: resume.sessionId } : {}),
      openerSocketId,
      readyTimer: null,
      permissionTimers: new Map(),
      elicitationTimers: new Map(),
    };
    session.readyTimer = setTimeout(() => {
      void this.closeInternal(session, 'spawn-timeout', { notifyDaemon: true, failed: true });
    }, this.opts.readyTimeoutMs);
    this.live.set(sessionId, session);

    // 9 W13 — the machine's configured model set for this target feeds the
    // daemon-side model-option rewrite (codex bare ids, opencode
    // `harness-nexus/<id>` values). The stored `spec.models` is extras-only;
    // the default is prepended here, same as the W3 writers. Best-effort: a
    // row we can't read must never block the open (the daemon then leaves
    // adapter options untouched).
    let modelOptions: string[] | undefined;
    if (isRuntimeTarget(agent.target)) {
      try {
        const rc = await this.deps.uow.runtimeConfigs.findByMachineAndTarget(
          machine.id,
          agent.target,
        );
        if (rc !== null) {
          modelOptions = [...new Set([rc.spec.model, ...(rc.spec.models ?? [])])];
        }
      } catch {
        modelOptions = undefined;
      }
    }

    // Issue #3 — stamp the target's pre-warm switch (MACHINE-scoped) so the
    // daemon re-arms one fresh prewarmed adapter after this channel took (or
    // missed) one. The machine row was already read above; absent map = defaults.
    const prewarm =
      (PREWARM_ADAPTER_TARGETS as readonly string[]).includes(agent.target) &&
      (machine.chatPrewarm ?? DEFAULT_CHAT_PREWARM_SETTINGS)[
        agent.target as (typeof PREWARM_ADAPTER_TARGETS)[number]
      ] === true;

    this.deps.io.toCtl(machine.id, 'chat:session.start', {
      sessionId,
      agentInstanceId: agent.id,
      target: agent.target,
      cwd,
      ...(resume !== undefined ? { resume } : {}),
      ...(modelOptions !== undefined ? { modelOptions } : {}),
      ...(prewarm ? { prewarm: true } : {}),
    });
    this.pushSnapshot(ownerId);
    return { ok: true, sessionId, joined: false, phase: 'starting' };
  }

  /**
   * Issue #3 — `chat:adapter.prewarm`. Best-effort: gates mirror `open()`
   * (owner + remote-chat + online + chat capability), then the switch check,
   * then a fire-and-forget `/ctl` nudge — the daemon owns the actual pool
   * (dedupe, idle TTL, ledger). Never a channel: no budget slot, no snapshot.
   */
  async prewarmAdapter(ownerId: string, agentInstanceId: string): Promise<ChatSimpleResult> {
    const agent = await this.deps.uow.agentInstances.findById(agentInstanceId);
    if (!agent || agent.ownerId !== ownerId) return { ok: false, code: 'AGENT_INSTANCE_NOT_FOUND' };
    if (!(PREWARM_ADAPTER_TARGETS as readonly string[]).includes(agent.target)) {
      return { ok: false, code: 'PREWARM_UNSUPPORTED_TARGET' };
    }
    const machine = await this.deps.uow.machines.findById(agent.machineId);
    if (!machine) return { ok: false, code: 'AGENT_INSTANCE_NOT_FOUND' };
    if (!machine.remoteChatEnabled) return { ok: false, code: 'REMOTE_CHAT_DISABLED' };
    if (!this.deps.isOnline(machine.id)) return { ok: false, code: 'MACHINE_OFFLINE' };
    if (!machine.capabilities.includes('chat')) return { ok: false, code: 'DAEMON_NO_CHAT' };
    const on =
      (machine.chatPrewarm ?? DEFAULT_CHAT_PREWARM_SETTINGS)[
        agent.target as (typeof PREWARM_ADAPTER_TARGETS)[number]
      ] === true;
    if (!on) return { ok: false, code: 'PREWARM_DISABLED' };
    this.deps.io.toCtl(machine.id, 'chat:adapter.prewarm', { target: agent.target });
    return { ok: true };
  }

  /**
   * Attach the caller to a channel that already exists (explicit rejoin, or
   * the resume-dedupe path). The PLUGIN joins the socket when
   * `joined: true`; a starting channel needs no ready re-push (it never
   * emitted one — the real push lands when the agent comes up).
   */
  private reattach(existing: LiveSession, openerSocketId: string): ChatOpenResult {
    if (existing.phase === 'starting') {
      // 9 W11: with user-scoped liveness a channel SURVIVES its opener's
      // page refresh mid-spawn (another window may be watching the tab) —
      // reattach silently: join + ack 'starting'.
      return { ok: true, sessionId: existing.sessionId, joined: true, phase: 'starting' };
    }
    // Join the opener BEFORE pushing. The /app handler's join runs after
    // open() resolves, so pushes emitted here would reach a room a FRESH
    // socket (page refresh / second window) has not entered yet — its
    // ready re-push was simply lost. (Same-SPA tab switches need the
    // browser-side switch buffer as well: the pushes can predate the
    // keyed listeners regardless of room membership.)
    this.deps.io.joinChannel(openerSocketId, existing.sessionId);
    // A re-join may be a page refresh whose listeners were attached after
    // the original ready push — re-push so every viewer settles.
    this.deps.io.toChannel(existing.sessionId, 'chat:session.ready', {
      sessionId: existing.sessionId,
      ...(existing.agentName !== undefined ? { agentName: existing.agentName } : {}),
      ...(existing.agentVersion !== undefined ? { agentVersion: existing.agentVersion } : {}),
      ...(existing.nativeSessionId !== undefined
        ? { nativeSessionId: existing.nativeSessionId }
        : {}),
      ...(existing.promptCapabilities !== undefined
        ? { promptCapabilities: existing.promptCapabilities }
        : {}),
    });
    // 9 W7 — the refreshed page lost its local fold; the daemon re-emits the
    // channel's history into the room.
    this.deps.io.toCtl(existing.machineId, 'chat:session.resync', {
      sessionId: existing.sessionId,
    });
    // #10 — re-push the send-queue slot so a re-joining viewer restores the
    // queued chip. The daemon ring never carries the parked entry — it only
    // becomes a transcript user row when it actually runs.
    if (existing.queuedPrompt !== null) {
      this.emitQueueState(existing, existing.queuedPrompt, false);
    }
    return { ok: true, sessionId: existing.sessionId, joined: true, phase: existing.phase };
  }

  /**
   * 9 W11 B — the user's live-channel snapshot (the tab bar's source of
   * truth). Pushed on every table change and once per `/app` connect, so the
   * browser never polls for channel state. Owner-scoped by construction:
   * chat channels are owner-only, an admin sees only their own.
   */
  snapshotFor(ownerId: string): { channels: ChatChannelView[] } {
    return {
      channels: [...this.live.values()]
        .filter((s) => s.ownerId === ownerId)
        .sort((a, b) => a.openedAt - b.openedAt)
        .map((s) => ({
          sessionId: s.sessionId,
          agentInstanceId: s.agentInstanceId,
          machineId: s.machineId,
          target: s.target,
          phase: s.phase,
          busy: s.busy,
          deferred: s.closeWhenIdle,
          ...(s.nativeSessionId !== undefined ? { nativeSessionId: s.nativeSessionId } : {}),
          openedAt: s.openedAt,
          lastActiveAt: s.lastActiveAt,
        })),
    };
  }

  /** Initial truth for a freshly connected /app socket. */
  sendSnapshot(userId: string): void {
    this.deps.io.toUser(userId, 'chat:channels', this.snapshotFor(userId));
  }

  private pushSnapshot(ownerId: string): void {
    this.sendSnapshot(ownerId);
  }

  /**
   * 9 W11 B — the tab bar's 一键清理: close every live channel of the caller.
   * Idle channels close immediately (daemon kills the adapter); a channel
   * MID-TURN flips to deferred and closes itself when the turn ends, so an
   * abandoned generation still finishes and persists natively.
   *
   * 9 W11 D6 — `idleOnly` (只清理闲置): busy channels are left COMPLETELY
   * alone (no defer-flip), so a generating turn never even schedules its
   * channel's death.
   */
  async closeAll(ownerId: string, idleOnly = false): Promise<{ closed: number; deferred: number }> {
    let closed = 0;
    let deferred = 0;
    for (const session of [...this.live.values()]) {
      if (session.ownerId !== ownerId) continue;
      if (session.busy) {
        if (!idleOnly) {
          session.closeWhenIdle = true;
          deferred += 1;
        }
        continue;
      }
      await this.closeInternal(session, 'user', { notifyDaemon: true });
      closed += 1;
    }
    if (closed > 0 || deferred > 0) this.pushSnapshot(ownerId);
    return { closed, deferred };
  }

  /**
   * 9 W11 D6 — the optional idle TTL sweep (`CHAT_IDLE_TTL_MS`, default 0 =
   * off). Enabling it is an explicit operator trade-off: a channel the user
   * has not prompted for TTL milliseconds closes (`idle-timeout`), tab
   * included. Busy and deferred channels are never touched; the tab bar's
   * idle-age label (same clock) is the visible warning.
   */
  private sweepIdle(): void {
    if (this.opts.idleTtlMs <= 0) return;
    for (const session of [...this.live.values()]) {
      if (session.phase !== 'ready' || session.busy || session.closeWhenIdle) continue;
      if (Date.now() - session.lastActiveAt < this.opts.idleTtlMs) continue;
      void this.closeInternal(session, 'idle-timeout', { notifyDaemon: true });
    }
  }

  /** Daemon's `chat:session.ready` — spawn+initialize+session/new done (or failed). */
  async onReady(
    machineId: string,
    evt: {
      sessionId: string;
      agentName?: string | undefined;
      agentVersion?: string | undefined;
      nativeSessionId?: string | undefined;
      promptCapabilities?: PromptCapabilities | undefined;
      error?: string | undefined;
    },
  ): Promise<void> {
    const session = this.live.get(evt.sessionId);
    if (!session || session.machineId !== machineId || session.phase !== 'starting') return;

    if (evt.error !== undefined) {
      await this.closeInternal(session, 'spawn-failed', {
        notifyDaemon: false,
        failed: true,
        error: evt.error,
      });
      return;
    }
    if (session.readyTimer !== null) clearTimeout(session.readyTimer);
    session.readyTimer = null;
    session.phase = 'ready';
    session.agentName = evt.agentName;
    session.agentVersion = evt.agentVersion;
    session.nativeSessionId = evt.nativeSessionId;
    session.promptCapabilities = evt.promptCapabilities;
    this.pushSnapshot(session.ownerId);

    // The opener joined at open(); if the USER has no connected window left
    // by the time the agent comes up, nobody is watching — close instead of
    // running an agent subprocess unattended. (9 W11: user-scoped — the
    // opener's page may have refreshed while another window of the same user
    // still shows the tab bar; that window keeps the channel alive.)
    if ((await this.deps.io.userSockets(session.ownerId)).length === 0) {
      await this.closeInternal(session, 'connection-lost', { notifyDaemon: true });
      return;
    }
    this.deps.io.toChannel(session.sessionId, 'chat:session.ready', {
      sessionId: session.sessionId,
      ...(evt.agentName !== undefined ? { agentName: evt.agentName } : {}),
      ...(evt.agentVersion !== undefined ? { agentVersion: evt.agentVersion } : {}),
      ...(evt.nativeSessionId !== undefined ? { nativeSessionId: evt.nativeSessionId } : {}),
      ...(evt.promptCapabilities !== undefined
        ? { promptCapabilities: evt.promptCapabilities }
        : {}),
    });
    // Re-push the history AFTER ready as well: a browser that attached its
    // listeners between the daemon's direct history push and this moment
    // still catches this one (history ingestion rebuilds from scratch, so a
    // viewer that saw both is fine).
    this.deps.io.toCtl(session.machineId, 'chat:session.resync', {
      sessionId: session.sessionId,
    });
  }

  /** Daemon's `chat:event` — validate, arm permission watchdogs, relay to the room. */
  async onStream(
    machineId: string,
    sessionId: string,
    event: ChatStreamEvent,
  ): Promise<{ ok: boolean }> {
    const session = this.live.get(sessionId);
    if (!session || session.machineId !== machineId) return { ok: false };

    if (event.kind === 'permission_request') {
      const { requestId } = event;
      session.permissionTimers.set(
        requestId,
        setTimeout(() => {
          session.permissionTimers.delete(requestId);
          // Timeout ⇒ answer the agent with cancelled and settle every viewer's card.
          this.deps.io.toCtl(session.machineId, 'chat:permission.respond', {
            sessionId,
            requestId,
          });
          this.deps.io.toChannel(sessionId, 'chat:event', {
            sessionId,
            event: { kind: 'permission_resolved', requestId, outcome: 'timeout' },
          });
        }, this.opts.permissionTimeoutMs),
      );
    } else if (event.kind === 'elicitation_request') {
      // 9 W14.1 — same policy and latency budget as permissions: an
      // unanswered question must not wedge the agent forever.
      const { requestId } = event;
      session.elicitationTimers.set(
        requestId,
        setTimeout(() => {
          session.elicitationTimers.delete(requestId);
          this.deps.io.toCtl(session.machineId, 'chat:elicitation.respond', {
            sessionId,
            requestId,
            action: 'cancel',
          });
          this.deps.io.toChannel(sessionId, 'chat:event', {
            sessionId,
            event: { kind: 'elicitation_resolved', requestId, outcome: 'timeout' },
          });
        }, this.opts.permissionTimeoutMs),
      );
    } else if (event.kind === 'session_status') {
      const wasBusy = session.busy;
      session.busy = event.state === 'active';
      // 9 W11 D6 — the turn END is the idle clock's tick: the tab's idle-age
      // label and the optional TTL sweep measure from here.
      if (wasBusy && !session.busy) session.lastActiveAt = Date.now();
      if (wasBusy !== session.busy) this.pushSnapshot(session.ownerId);
      // Viewers left while this turn ran — once it ends, the channel closes
      // (relay the idle event first; the room may still have a rejoiner).
      if (wasBusy && !session.busy && session.closeWhenIdle) {
        session.queuedPrompt = null; // #10 — closing drops the parked entry (no emit: the room is going away).
        this.deps.io.toChannel(sessionId, 'chat:event', { sessionId, event });
        await this.closeInternal(session, 'connection-lost', { notifyDaemon: true });
        return { ok: true };
      }
    }
    this.deps.io.toChannel(sessionId, 'chat:event', { sessionId, event });
    // #10 — the busy→idle transition is the flush hook: the parked message
    // now runs as the NEXT turn. Emitted after the idle relay so the viewer
    // first sees the turn complete, then the queue drain, then the new turn.
    if (
      event.kind === 'session_status' &&
      event.state === 'idle' &&
      session.queuedPrompt !== null &&
      session.phase === 'ready'
    ) {
      const queued = session.queuedPrompt;
      session.queuedPrompt = null;
      this.emitQueueState(session, null, true);
      this.emitUserMessage(session, queued);
      this.deps.io.toCtl(session.machineId, 'chat:message.send', {
        sessionId,
        prompt: queued,
      });
    }
    return { ok: true };
  }

  /** Daemon's `chat:history` (9 W7) — relay the transcript batch to the room. */
  onHistory(machineId: string, payload: { sessionId: string; items: unknown[] }): { ok: boolean } {
    const session = this.live.get(payload.sessionId);
    if (!session || session.machineId !== machineId) return { ok: false };
    this.deps.io.toChannel(payload.sessionId, 'chat:history', payload);
    // #11 — the fold's history ingestion REBUILDS from scratch and ends by
    // force-closing anything still running, so a viewer (re)joining mid-turn
    // lands with turnActive=false — Send button where Stop belongs. The
    // server knows better (LiveSession.busy): follow the batch with a
    // synthetic active status. Same socket, emitted after the history event,
    // so the rebuild-then-set order is guaranteed.
    if (session.busy) {
      this.deps.io.toChannel(payload.sessionId, 'chat:event', {
        sessionId: payload.sessionId,
        event: { kind: 'session_status', state: 'active' },
      });
    }
    return { ok: true };
  }

  /** Browser's `chat:message.send` — owner check, queue-on-busy, normalization. */
  onMessageSend(
    ownerId: string,
    sessionId: string,
    content: string | PromptBlock[],
  ): ChatSendResult {
    const session = this.live.get(sessionId);
    if (!session || session.ownerId !== ownerId) return { ok: false, code: 'SESSION_NOT_FOUND' };
    if (session.phase !== 'ready') return { ok: false, code: 'SESSION_NOT_READY' };
    const prompt: PromptBlock[] =
      typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    // #10 — a busy session no longer bounces: the message parks in the
    // server-owned slot (depth 1) and flushes when the running turn goes
    // idle. A queued send serializes behind that turn, so it cannot add
    // concurrency — the per-machine ACTIVE budget deliberately does not
    // apply to it (it still guards idle-session sends below).
    if (session.busy) {
      if (session.queuedPrompt !== null) return { ok: false, code: 'QUEUE_FULL' };
      session.queuedPrompt = prompt;
      this.emitQueueState(session, prompt, false);
      return { ok: true, queued: true };
    }
    // Active budget (post-W8 redesign): mid-turn sessions cost a second,
    // smaller per-machine budget — starting a turn while the machine already
    // has `maxActiveSessionsPerMachine` turns generating bounces here (this
    // session is idle, per the check above, so it is not double-counted).
    const activeOnMachine = [...this.live.values()].filter(
      (s) => s.machineId === session.machineId && s.busy,
    ).length;
    if (activeOnMachine >= this.opts.maxActiveSessionsPerMachine) {
      return { ok: false, code: 'MACHINE_BUSY' };
    }
    this.emitUserMessage(session, prompt);
    this.deps.io.toCtl(session.machineId, 'chat:message.send', { sessionId, prompt });
    return { ok: true, queued: false };
  }

  /**
   * Browser's `chat:queue.cancel` (#10) — drop the parked entry (atomic at
   * the server; the "edit" flow is cancel + prefill the composer draft from
   * the chip the browser already holds). Idempotent: an empty slot is ok.
   */
  onQueueCancel(ownerId: string, sessionId: string): ChatSimpleResult {
    const session = this.live.get(sessionId);
    if (!session || session.ownerId !== ownerId) return { ok: false, code: 'SESSION_NOT_FOUND' };
    if (session.queuedPrompt !== null) {
      session.queuedPrompt = null;
      this.emitQueueState(session, null, false);
    }
    return { ok: true };
  }

  /** #10 — push the slot's state to the channel room (the chip's truth). */
  private emitQueueState(
    session: LiveSession,
    prompt: PromptBlock[] | null,
    flushed: boolean,
  ): void {
    this.deps.io.toChannel(session.sessionId, 'chat:event', {
      sessionId: session.sessionId,
      event: { kind: 'queue_state', prompt, flushed },
    });
  }

  /**
   * #11 — broadcast the accepted prompt to the room so EVERY viewer paints
   * the user row. The daemon never echoes prompts on the live stream (ACP
   * session/update is agent-side), so before this the row existed only on
   * the sending tab's local optimism. Emitted on both send paths: direct
   * sends and queue flushes (after the queue_state clear, before the daemon
   * turn starts).
   */
  private emitUserMessage(session: LiveSession, blocks: PromptBlock[]): void {
    this.deps.io.toChannel(session.sessionId, 'chat:event', {
      sessionId: session.sessionId,
      event: { kind: 'user_message', blocks },
    });
  }

  /** Browser's `chat:turn.cancel` — idempotent; the daemon resolves the turn as cancelled. */
  onTurnCancel(ownerId: string, sessionId: string): ChatSimpleResult {
    const session = this.live.get(sessionId);
    if (!session || session.ownerId !== ownerId) return { ok: false, code: 'SESSION_NOT_FOUND' };
    // #10 — stopping the turn DROPS the parked entry (it does not auto-send).
    if (session.queuedPrompt !== null) {
      session.queuedPrompt = null;
      this.emitQueueState(session, null, false);
    }
    this.deps.io.toCtl(session.machineId, 'chat:turn.cancel', { sessionId });
    return { ok: true };
  }

  /**
   * Browser's `chat:config.set` (9 W9 A) — switch the live session's
   * permission mode / one config option. Deliberately NOT busy-gated: the
   * daemon forwards `session/set_mode` / `session/set_config_option` and the
   * adapters pin per-turn selections, so a mid-turn set applies to the NEXT
   * turn; the UI disables the selectors during a turn anyway.
   */
  onConfigSet(
    ownerId: string,
    sessionId: string,
    set: { kind: 'mode'; modeId: string } | { kind: 'option'; configId: string; value: string },
  ): ChatSimpleResult {
    const session = this.live.get(sessionId);
    if (!session || session.ownerId !== ownerId) return { ok: false, code: 'SESSION_NOT_FOUND' };
    if (session.phase !== 'ready') return { ok: false, code: 'SESSION_NOT_READY' };
    this.deps.io.toCtl(session.machineId, 'chat:config.set', { sessionId, ...set });
    return { ok: true };
  }

  /** Browser's `chat:permission.respond` — forward verbatim (optionId is sacred). */
  onPermissionRespond(
    ownerId: string,
    sessionId: string,
    requestId: string,
    optionId: string | undefined,
  ): ChatSimpleResult {
    const session = this.live.get(sessionId);
    if (!session || session.ownerId !== ownerId) return { ok: false, code: 'SESSION_NOT_FOUND' };
    const timer = session.permissionTimers.get(requestId);
    if (timer === undefined) return { ok: false, code: 'PERMISSION_NOT_FOUND' };
    clearTimeout(timer);
    session.permissionTimers.delete(requestId);
    this.deps.io.toCtl(session.machineId, 'chat:permission.respond', {
      sessionId,
      requestId,
      ...(optionId !== undefined ? { optionId } : {}),
    });
    this.deps.io.toChannel(sessionId, 'chat:event', {
      sessionId,
      event: {
        kind: 'permission_resolved',
        requestId,
        outcome: optionId !== undefined ? 'selected' : 'cancelled',
        ...(optionId !== undefined ? { optionId } : {}),
      },
    });
    return { ok: true };
  }

  /**
   * Browser's `chat:elicitation.respond` (9 W14.1) — forward verbatim (the
   * values are the ACP `content`, keyed by the schema's property names).
   */
  onElicitationRespond(
    ownerId: string,
    sessionId: string,
    requestId: string,
    action: 'accept' | 'decline' | 'cancel',
    values: Record<string, string | number | boolean | string[]> | undefined,
  ): ChatSimpleResult {
    const session = this.live.get(sessionId);
    if (!session || session.ownerId !== ownerId) return { ok: false, code: 'SESSION_NOT_FOUND' };
    const timer = session.elicitationTimers.get(requestId);
    if (timer === undefined) return { ok: false, code: 'ELICITATION_NOT_FOUND' };
    clearTimeout(timer);
    session.elicitationTimers.delete(requestId);
    this.deps.io.toCtl(session.machineId, 'chat:elicitation.respond', {
      sessionId,
      requestId,
      action,
      ...(values !== undefined ? { values } : {}),
    });
    this.deps.io.toChannel(sessionId, 'chat:event', {
      sessionId,
      event: {
        kind: 'elicitation_resolved',
        requestId,
        outcome: action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'cancelled',
      },
    });
    return { ok: true };
  }

  /**
   * Browser's `chat:session.close` — "disconnect the channel" since 9 W7: it
   * kills the subprocess, never the agent's session (the rail keeps it).
   */
  async close(
    ownerId: string,
    sessionId: string,
    reason: string | undefined,
  ): Promise<ChatSimpleResult> {
    const session = this.live.get(sessionId);
    if (!session || session.ownerId !== ownerId) return { ok: false, code: 'SESSION_NOT_FOUND' };
    await this.closeInternal(session, reason ?? 'user', { notifyDaemon: true });
    return { ok: true };
  }

  /** Daemon's `chat:session.closed` — the subprocess ended on its own. */
  async onDaemonClosed(machineId: string, sessionId: string, reason: string): Promise<void> {
    const session = this.live.get(sessionId);
    if (!session || session.machineId !== machineId) return;
    await this.closeInternal(session, reason.slice(0, 256) || 'agent-exited', {
      notifyDaemon: false,
    });
  }

  /**
   * 9 W11 C — operator kill (the machine panel's per-adapter 终止 button):
   * closes the channel regardless of owner (the ROUTE gates owner-or-admin;
   * chat itself stays owner-only). The daemon teardown rides the ordinary
   * close event; the ledger entry drops at its audit (kill paths never
   * unlink — the W11 A rule).
   */
  async forceCloseSession(sessionId: string, reason = 'operator'): Promise<boolean> {
    const session = this.live.get(sessionId);
    if (session === undefined) return false;
    await this.closeInternal(session, reason, { notifyDaemon: true });
    return true;
  }

  /** Daemon went offline — every open channel of the machine ends (the agent sessions survive). */
  async onMachineOffline(machineId: string): Promise<void> {
    for (const session of [...this.live.values()]) {
      if (session.machineId === machineId) {
        await this.closeInternal(session, 'connection-lost', { notifyDaemon: false });
      }
    }
  }

  /**
   * 9 W11 E — the server's live channel ids for a machine (the reconcile
   * handshake's list, sent to the daemon on every /ctl (re)connect).
   */
  liveSessionIds(machineId: string): string[] {
    const ids: string[] = [];
    for (const session of this.live.values()) {
      if (session.machineId === machineId) ids.push(session.sessionId);
    }
    return ids;
  }

  /**
   * 9 W11 E — reconcile completion: rows the daemon does NOT hold are ghosts
   * (its session died during a blip without the close event landing, or the
   * daemon restarted/hard-died). Close them; held rows survive the blip.
   */
  async retainOnly(machineId: string, held: Set<string>): Promise<void> {
    for (const session of [...this.live.values()]) {
      if (session.machineId === machineId && !held.has(session.sessionId)) {
        // notifyDaemon closes the loop for a daemon that still runs one of
        // these (an ack race) — a no-op ack for one that does not.
        await this.closeInternal(session, 'connection-lost', { notifyDaemon: true });
      }
    }
  }

  /**
   * Live channels of an agent instance keyed by NATIVE session id — the
   * listing surface for "which sessions still hold a channel" (`open` /
   * `openChannelId` rows; a row click rejoins instead of resuming).
   */
  channelsByNativeId(agentInstanceId: string): Map<string, string> {
    const byNative = new Map<string, string>();
    for (const s of this.live.values()) {
      if (
        s.agentInstanceId === agentInstanceId &&
        s.phase === 'ready' &&
        s.nativeSessionId !== undefined &&
        !byNative.has(s.nativeSessionId)
      ) {
        byNative.set(s.nativeSessionId, s.sessionId);
      }
    }
    return byNative;
  }

  /** The same channels keyed to their cwd — synthesized listing rows. */
  openChannelCwds(agentInstanceId: string): Map<string, string> {
    const cwds = new Map<string, string>();
    for (const s of this.live.values()) {
      if (
        s.agentInstanceId === agentInstanceId &&
        s.phase === 'ready' &&
        s.nativeSessionId !== undefined &&
        !cwds.has(s.nativeSessionId)
      ) {
        cwds.set(s.nativeSessionId, s.cwd);
      }
    }
    return cwds;
  }

  /**
   * A /app socket disconnected. Channel liveness is USER-scoped (9 W11,
   * revising C5's room-scoped rule): the tab bar shows every live channel of
   * the user in EVERY window, so a window that merely displays the tabs is a
   * legitimate keeper — one window's refresh must not kill the channels
   * another window still shows. Idle channels close only when the user's LAST
   * /app socket dies; a channel MID-TURN is never killed outright: it flips
   * `closeWhenIdle` and closes when the turn ends, so an abandoned generation
   * still finishes and persists into the agent's native store. (Before the
   * tab bar, "last viewer" meant "last socket in the channel's room" — a
   * second window watching the tabs did not count, and its tabs could be
   * yanked away by another window's refresh.)
   */
  async onViewerGone(userId: string): Promise<void> {
    if ((await this.deps.io.userSockets(userId)).length > 0) return;
    for (const session of [...this.live.values()]) {
      if (session.ownerId !== userId) continue;
      if (session.busy) {
        session.closeWhenIdle = true;
        continue;
      }
      await this.closeInternal(session, 'connection-lost', { notifyDaemon: true });
    }
  }

  /** Machine deleted / enrollment revoked — channels end (nothing persisted remains). */
  async onMachineDeleted(machineId: string): Promise<void> {
    await this.onMachineOffline(machineId);
  }

  private async closeInternal(
    session: LiveSession,
    reason: string,
    opts: { notifyDaemon: boolean; failed?: boolean; error?: string },
  ): Promise<void> {
    if (this.live.get(session.sessionId) !== session) return; // already closed
    this.live.delete(session.sessionId);
    if (session.readyTimer !== null) clearTimeout(session.readyTimer);
    for (const timer of session.permissionTimers.values()) clearTimeout(timer);
    session.permissionTimers.clear();
    for (const timer of session.elicitationTimers.values()) clearTimeout(timer);
    session.elicitationTimers.clear();

    if (opts.failed === true) {
      this.deps.io.toChannel(session.sessionId, 'chat:session.failed', {
        sessionId: session.sessionId,
        error: opts.error ?? reason,
      });
    }
    this.deps.io.toChannel(session.sessionId, 'chat:session.closed', {
      sessionId: session.sessionId,
      reason,
    });
    if (opts.notifyDaemon) {
      this.deps.io.toCtl(session.machineId, 'chat:session.close', {
        sessionId: session.sessionId,
        ...(reason !== '' ? { reason } : {}),
      });
    }
    this.pushSnapshot(session.ownerId);
  }
}
