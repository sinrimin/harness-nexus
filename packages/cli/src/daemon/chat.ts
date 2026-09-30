import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Socket } from 'socket.io-client';
import {
  acpPermissionOptionSchema,
  acpToolCallViewSchema,
  chatAdapterPrewarmEventSchema,
  chatConfigSetEventSchema,
  chatElicitationRespondEventSchema,
  chatPermissionRespondEventSchema,
  chatPromptEventSchema,
  chatReconcileEventSchema,
  adaptersReportRequestSchema,
  chatSessionCloseEventSchema,
  chatSessionResyncEventSchema,
  chatSessionStartEventSchema,
  chatTurnCancelEventSchema,
  availableCommandViewSchema,
  planEntrySchema,
  PREWARM_ADAPTER_TARGETS,
  sessionConfigOptionSchema,
  sessionModeStateSchema,
  type AcpPermissionOption,
  type AcpToolCallView,
  type AgentTarget,
  type AvailableCommandView,
  type ChatStreamEvent,
  type ElicitationField,
  type HistoryItem,
  type PlanEntry,
  type PromptBlock,
  type SessionConfigOption,
  type SessionModeState,
} from '@harness-nexus/shared';
import {
  AcpAgentConnection,
  type AgentConnection,
  type JsonRpcId,
} from './acp/agent-connection.js';
import { resolveAcpCommand } from './acp/adapters.js';
import { PiRpcConnection, resolvePiCommand } from './acp/pi-connection.js';
import {
  auditAdapterLedger,
  deleteAdapterLedgerEntry,
  writeAdapterLedgerEntry,
} from './adapter-ledger.js';
import { PrewarmPool } from './prewarm.js';
import { UsageLedger, hasTokenCounts, normalizeUsage, responseUsageMode } from './usage.js';
import { rewriteHistoryItems, rewriteSessionConfigOptions } from './model-options.js';
import {
  createDshLiveMapper,
  decodeTranscript,
  dshHistoryItems,
  findTranscript,
  nativeZstd,
  TranscriptTail,
  type DshLiveMapper,
  type TailFs,
} from './dsh-sessions.js';
import {
  TapListener,
  tapPluginAvailable,
  tapPluginPath,
  writeTapPatch,
} from './dsh-tap-listener.js';

/**
 * Daemon-side chat session manager (Phase 8 C5, extended 9 W7).
 * wiki design-phase-8-c5.md + wiki design-phase-9-w7-native-sessions.md.
 *
 * The daemon is the protocol-adaptation edge: one ACP adapter subprocess per
 * `chat:session.start`, ACP frames mapped onto the platform's semantic stream
 * in both directions, permission requests round-tripped verbatim, subprocesses
 * killed on close/disconnect. One prompt in flight per session — a racing
 * prompt is dropped and `active` re-emitted so the server's busy gate resyncs.
 *
 * 9 W7 — sessions are the agent's own: a start event may carry `resume`
 * (the agent's session id + its cwd) and is established via the ADVERTISED
 * capability (`session/load` preferred — claude/codex replay their history as
 * session/updates, which we capture and ship as `chat:history`; dsh only has
 * `session/resume`, so its transcript file is parsed instead). Every channel
 * keeps a bounded history ring (forwarded prompts + mapped events) so a
 * `chat:session.resync` (page refresh rejoin) can rebuild the browser's fold.
 *
 * dsh STREAMING (9 W7.1): its ACP adapter only commits whole blocks at turn
 * end (rig-verified — zero notifications during generation), so deepseek
 * channels stream from an auxiliary source with a purely-additive priority
 * chain: (1) the IN-PROCESS EVENT TAP — the daemon insert-mounts a zero-dep
 * cordis plugin at spawn (`dsh --patch`, assets in `daemon/dsh-tap/`) which
 * forwards the session event bus over a localhost JSON-line socket
 * (`dsh-tap-listener.ts`; zero latency, verbatim events); (2) on no
 * handshake within 3s (old dsh, plugin failure, `HN_DISABLE_DSH_TAP=1` A/B
 * switch) the W7 TRANSCRIPT-FILE TAIL (`TranscriptTail` — batches land as
 * zstd frames ~100–300ms behind); (3) neither → committed-only. Whichever
 * source is live feeds ONE `createDshLiveMapper` per session (deltas AND
 * complete blocks for unstreamed steps), so the wire's committed text chunks
 * are suppressed wholesale while it is live (letting them through would
 * double-render). A tap that dies mid-session leaves that session
 * committed-only — a fresh mapper cannot know what was already streamed.
 */

interface DaemonSession {
  /** Platform channel id. */
  sessionId: string;
  /** The agent's own session id from `session/new` / the resume arm. */
  acpSessionId: string;
  target: string;
  /** 9 W11 C — the spawn command's executable, for the adapter report. */
  command: string;
  /** 9 W11 C — spawn time (also the report's uptime base). */
  startedAt: number;
  conn: AgentConnection;
  busy: boolean;
  /** In-flight permission requests by our wire requestId. */
  permissions: Map<string, { jsonrpcId: JsonRpcId; timer: NodeJS.Timeout }>;
  /** 9 W14.1 — in-flight `elicitation/create` requests, same shape. */
  elicitations: Map<string, { jsonrpcId: JsonRpcId; timer: NodeJS.Timeout }>;
  /**
   * 9 W9 A — the merged session-config snapshot (modes + select options).
   * Source of truth for the composer's selectors; every change emits a FULL
   * `session_config` event (which also enters the history ring, so a resync
   * restores the selectors for free).
   */
  config: {
    modes?: SessionModeState;
    options: SessionConfigOption[];
  };
  /**
   * 9 W13 — the configured model set from `chat:session.start`
   * (`unique([model, ...models])`), feeding the model-option rewrite.
   * Undefined = no stored config: adapter options pass through untouched.
   */
  modelOptions?: readonly string[];
  /** 9 W7 — the history ring (user items + mapped events), newest last. */
  history: HistoryItem[];
  /**
   * dsh only — whether the WIRE's committed text chunks ever rendered for
   * this session (true ⇒ the committed path owns bytes already shown, so a
   * later tail attach must NOT replay the file from the beginning).
   */
  wireTextEmitted: boolean;
  /**
   * dsh only — a NEW session's transcript may materialize only after the
   * channel opened, in which case the FIRST tail attach may replay from byte
   * 0 (the file can only hold the in-flight turn — nothing was rendered). A
   * resumed session's file pre-exists with rendered history: never replay.
   */
  tailReplayEligible: boolean;
  /** dsh only — the live transcript tail (the FALLBACK streaming source). */
  tail: TranscriptTail | null;
  /**
   * 9 W7.1 — the in-process event tap (the PREFERRED dsh streaming source):
   * localhost listener fed by the `harness-nexus-tap` plugin that
   * `dsh --patch` insert-mounts at spawn. Mutually exclusive with `tail`.
   */
  tap: TapListener | null;
  /** The tap's live mapper (verbatim bus events → stream events). */
  tapMapper: DshLiveMapper | null;
  /** Wall-clock of the tap's last `turn/end` (the tap-path settle signal). */
  tapTurnEndAt: number;
  /**
   * A live tap DIED mid-session: stay committed-only forever — a fresh tail
   * mapper cannot know which steps the tap already streamed, so attaching it
   * (or replaying the file) would double-render (the tail-corruption path
   * has the same trade-off).
   */
  tapDead: boolean;
}

const HISTORY_MAX = 2000;

/** How long after arming the tap plugin may take to say hello (design: 3s). */
const TAP_HANDSHAKE_MS = 3000;

/**
 * codex-acp's unknown-model notice (see `mapAcpUpdate`'s agent_message_chunk
 * arm). Anchored on the stable prefix; the model id varies.
 */
const CODEX_MODEL_METADATA_NOTICE = /^Model metadata for `[^`]*` not found\./;

/** Node fs surface for TranscriptTail. */
const nodeTailFs: TailFs = {
  size(path) {
    try {
      return statSync(path).size;
    } catch {
      return null;
    }
  },
  readEnd(path, start) {
    const fd = openSync(path, 'r');
    try {
      const len = fstatSync(fd).size - start;
      if (len <= 0) return Buffer.alloc(0);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, start);
      return buf;
    } finally {
      closeSync(fd);
    }
  },
};

export interface ChatHandlersOptions {
  /** Env source for `HN_ACP_COMMAND_<TARGET>` overrides (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
  /** Extra env for the adapter subprocess. */
  spawnEnv?: NodeJS.ProcessEnv;
  /** Overridable for tests (transcript lookup on dsh resume). */
  homeDir?: string;
  /**
   * 9 W11 A — adapter-ledger audit cadence in ms (default 60s). The audit is
   * the only runtime remover of ledger files; 0 disables it (tests that
   * assert file lifetimes drive `auditAdapterLedger` directly).
   */
  auditIntervalMs?: number;
}

/** What `attachChatHandlers` hands back for other daemon handlers (issue #2). */
/** One live chat channel, as the TUI (#39) renders it. */
export interface SessionView {
  sessionId: string;
  acpSessionId: string;
  target: string;
  command: string;
  startedAt: number;
  busy: boolean;
  model: string | null;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** #44 — daemon-run spend accumulated from usage_update cost deltas. */
  costUsd: number;
  events: number;
}

/** A pooled (pre-warmed) adapter, as the TUI renders it. */
export interface PrewarmView {
  key: string;
  state: 'pending' | 'ready';
  ageMs: number;
}

/**
 * The session's current model: the W9 config snapshot's `model`-category
 * select, falling back to the W13 configured set's head (a session started
 * with a model set but before the adapter pushed its options). Null = the
 * target gives us nothing to key usage on.
 */
export function modelOf(
  config: { modes?: SessionModeState; options: SessionConfigOption[] },
  modelOptions?: readonly string[],
): string | null {
  const selected = config.options.find((o) => o.category === 'model');
  if (
    selected !== undefined &&
    selected.currentValue !== undefined &&
    selected.currentValue !== ''
  ) {
    return selected.currentValue;
  }
  return modelOptions !== undefined && modelOptions.length > 0 ? (modelOptions[0] ?? null) : null;
}

export interface ChatHandlersHandle {
  /**
   * A live channel's adapter connection for the target (the newest
   * registration wins), or null when no channel is live. The sessions
   * listing rides it — `session/list` is a plain concurrent JSON-RPC
   * request, so a live channel answers the rail without any spawn. A dead
   * connection rejects fast and the caller falls back to spawning.
   */
  liveConnectionFor: (target: string) => AgentConnection | null;
  /** Issue #3 — is a prewarmed adapter READY (initialized, alive) for the target? */
  prewarmReady: (target: string) => boolean;
  /** #39 — live channels for the TUI's agents pane (oldest first). */
  sessionsSnapshot: () => SessionView[];
  /** #39 — the pre-warm pool's live entries for the TUI's agents pane. */
  prewarmStatus: () => PrewarmView[];
  /** #39 — per-(target, model) and per-session token totals (this daemon run). */
  usage: UsageLedger;
}

export function attachChatHandlers(
  socket: Socket,
  opts: ChatHandlersOptions = {},
): ChatHandlersHandle {
  const env = opts.env ?? process.env;
  const home = opts.homeDir ?? homedir();
  const sessions = new Map<string, DaemonSession>();
  /**
   * Ids whose `chat:session.close` arrived BEFORE the session registered. A
   * close can race the establishment: the channel dies server-side (a fast row
   * hop, a page exit) while the adapter is still spawning, so the close finds
   * no session to tear down and used to be dropped — the establishment then
   * finished and registered an orphan process nobody could ever close. The
   * start handler consumes the id at its checkpoints and aborts instead.
   */
  const closedBeforeReady = new Set<string>();
  const CLOSED_BEFORE_READY_MAX = 64;

  /**
   * 9 W11 E — starts currently mid-establishment (spawn → registration).
   * `chat:reconcile` reports these (when their id is still listed server-side)
   * as held, and flags UNLISTED ones into `closedBeforeReady` so the
   * establishment aborts — a row the server no longer knows must not finish
   * into an unjoinable orphan.
   */
  const inFlightStarts = new Set<string>();

  /** #39 — token totals for the TUI (this daemon run, nothing persisted). */
  const usageLedger = new UsageLedger();

  const emitEvent = (session: DaemonSession, event: ChatStreamEvent): void => {
    // #39/#44 — the usage ledger. `usage` events carry per-turn tokens (dsh,
    // pi) and the session-cumulative cost (claude; delta-accounted inside).
    // `turn_result` counts a turn for EVERY target and applies response
    // usage where the dialect is known (claude cumulative, opencode
    // per-turn). Occupancy-only updates carry nothing countable. History
    // replays ride emitHistory, never here, so a resync cannot double-count.
    const model = modelOf(session.config, session.modelOptions) ?? '(unknown)';
    if (event.kind === 'usage') {
      usageLedger.record(session.sessionId, session.target, model, event, new Date().toISOString());
    } else if (event.kind === 'turn_result') {
      usageLedger.recordTurn(
        session.sessionId,
        session.target,
        model,
        event.usage !== undefined ? event.usage : null,
        new Date().toISOString(),
      );
    }
    pushHistory(session, { type: 'event', event });
    socket.emit('chat:event', { sessionId: session.sessionId, event });
  };

  /** Issue #2 — see `ChatHandlersHandle.liveConnectionFor`. */
  const liveConnectionFor = (target: string): AgentConnection | null => {
    let found: AgentConnection | null = null;
    for (const s of sessions.values()) {
      if (s.target === target) found = s.conn;
    }
    return found;
  };

  const pushHistory = (session: DaemonSession, item: HistoryItem): void => {
    session.history.push(item);
    if (session.history.length > HISTORY_MAX) {
      session.history.splice(0, session.history.length - HISTORY_MAX);
    }
  };

  const emitHistory = (session: DaemonSession, items: HistoryItem[]): void => {
    if (items.length === 0) return;
    for (const item of items) pushHistory(session, item);
    socket.emit('chat:history', {
      sessionId: session.sessionId,
      items: session.history.slice(-HISTORY_MAX),
    });
  };

  /**
   * 9 W9 A — emit the session's FULL merged config snapshot as a
   * `session_config` stream event (into the ring and the live room). The
   * browser's selectors settle exclusively through these events — the
   * daemon-side optimistic merge after `chat:config.set` reuses this path.
   */
  const emitConfig = (session: DaemonSession): void => {
    emitEvent(session, {
      kind: 'session_config',
      ...(session.config.modes !== undefined ? { modes: { ...session.config.modes } } : {}),
      ...(session.config.options.length > 0 ? { configOptions: session.config.options } : {}),
    });
  };

  const teardown = (session: DaemonSession, reason: string): void => {
    if (sessions.get(session.sessionId) !== session) return;
    sessions.delete(session.sessionId);
    session.tail?.stop();
    session.tap?.close();
    for (const [, p] of session.permissions) clearTimeout(p.timer);
    session.permissions.clear();
    for (const [, e] of session.elicitations) clearTimeout(e.timer);
    session.elicitations.clear();
    session.conn.kill();
    // 9 W11 A — the kill path does NOT unlink the ledger file: if the daemon
    // hard-dies inside the SIGTERM→SIGKILL grace, an unlinked file would
    // lose accounting (the group survives with no record). The audit below
    // removes it once the group is gone.
    socket.emit('chat:session.closed', { sessionId: session.sessionId, reason });
  };

  // 9 W11 A — periodic audit: the only runtime remover of ledger files
  // (entries whose process group is gone), and the backstop for a session
  // whose group died without the exit event reaching teardown.
  const auditMs = opts.auditIntervalMs ?? 60_000;
  if (auditMs > 0) {
    const auditTimer = setInterval(() => {
      auditAdapterLedger(home);
      for (const session of [...sessions.values()]) {
        if (!session.conn.isGroupAlive()) teardown(session, 'agent-exited');
      }
    }, auditMs);
    auditTimer.unref();
  }

  /**
   * 9 W11 E — disconnect grace window. `HN_TEARDOWN_GRACE_MS` (default 8000;
   * 0 restores the pre-W11 immediate teardown). Socket.IO reconnects from a
   * transport blip within ~1s, so holding channels (and in-flight turns) for
   * the window survives the blip; the server delays its offline reap by the
   * same window and reconciles on reconnect.
   */
  const graceMs = (() => {
    const raw = Number.parseInt(env.HN_TEARDOWN_GRACE_MS ?? '', 10);
    return Number.isFinite(raw) ? Math.max(raw, 0) : 8000;
  })();
  let graceTimer: NodeJS.Timeout | null = null;

  // In-flight tail attachments by native session id (one per session).
  const tailAttaches = new Map<string, Promise<void>>();

  /**
   * An armed (not yet handshaken) tap — the per-session event dispatch binds
   * at activation time (the acpSessionId only exists after establishment);
   * events before that are dropped (no assistant events can precede the
   * first prompt).
   */
  interface TapArm {
    listener: TapListener;
    patchPath: string;
    hello: Promise<boolean>;
    bind(sink: (sessionId: string, event: Record<string, unknown>) => void, loss: () => void): void;
  }

  /**
   * 9 W7.1 — arm the in-process dsh event tap BEFORE the spawn (the child
   * needs the listener port/token in its env): render the spawn overlay into
   * `~/.hnx/dsh-tap.patch.yml` and open the localhost listener the plugin
   * dials. Null = not applicable (non-deepseek, `HN_DISABLE_DSH_TAP=1` A/B
   * switch, assets missing, patch write or listen failure) — the transcript
   * tail then streams exactly as before. The handshake races the spawn (the
   * plugin loads during dsh's composition, i.e. typically before initialize
   * resolves); no hello within the window → the caller closes the listener
   * and falls through to the tail.
   */
  const armTap = (target: string): Promise<TapArm | null> => {
    if (target !== 'deepseek' || env.HN_DISABLE_DSH_TAP === '1') return Promise.resolve(null);
    if (!tapPluginAvailable()) return Promise.resolve(null);
    const patchPath = writeTapPatch(home, tapPluginPath());
    if (patchPath === null) return Promise.resolve(null);
    let sink: ((sessionId: string, event: Record<string, unknown>) => void) | null = null;
    let loss: (() => void) | null = null;
    return TapListener.create({
      onEvent: (sessionId, event) => sink?.(sessionId, event),
      onLoss: () => loss?.(),
    })
      .then((listener): TapArm => ({
        listener,
        patchPath,
        hello: listener.waitHello(Date.now() + TAP_HANDSHAKE_MS),
        bind: (fnSink, fnLoss) => {
          sink = fnSink;
          loss = fnLoss;
        },
      }))
      .catch(() => null);
  };

  /**
   * dsh streaming — attach the transcript tail if it isn't live yet. Called
   * at session ready AND at each prompt start: a NEW session's transcript is
   * materialized lazily (the file appears only when the first prompt's user
   * event flushes), so the ready-time attempt may legitimately find nothing.
   * A late-attached tail misses the turn's first deltas — the mapper's
   * committed fallback then emits the complete blocks, nothing is lost.
   */
  const ensureTail = (session: DaemonSession): void => {
    // 9 W7.1 — the tap and the tail are mutually exclusive streaming
    // sources: a live tap owns the session, and a DEAD one leaves it
    // committed-only (a fresh tail mapper would double-render streamed steps).
    if (session.target !== 'deepseek' || session.tail !== null) return;
    if (session.tap !== null || session.tapDead) return;
    if (tailAttaches.has(session.acpSessionId)) return;
    const attach = (async () => {
      let tailRef: TranscriptTail | null = null;
      const tail = await attachTranscriptTail(
        home,
        session.acpSessionId,
        (event) => {
          if (sessions.get(session.sessionId) === session) emitEvent(session, event);
        },
        (reason) => {
          // Mid-file corruption: stop and lift the wire suppression so the
          // adapter's committed chunks carry the rest of the turn (a partially
          // streamed message may render once more — rare, never silent loss).
          console.warn(`[chat] dsh ${reason} — falling back to committed updates`);
          if (session.tail === tailRef) session.tail = null;
        },
      );
      tailRef = tail;
      if (tail !== null && session.tail === null && sessions.get(session.sessionId) === session) {
        session.tail = tail;
        // Byte-0 replay only for a NEW session whose file appeared mid-turn:
        // it can hold nothing but the un-rendered in-flight turn (a resumed
        // session's file pre-exists with rendered history; wire-rendered text
        // likewise rules replay out — either way skip to EOF).
        const replay = session.tailReplayEligible && !session.wireTextEmitted;
        session.tailReplayEligible = false;
        tail.start(replay);
      } else {
        tail?.stop();
      }
    })().catch(() => {}); // attachment is best-effort; committed-only is the fallback
    void attach.then(() => tailAttaches.delete(session.acpSessionId));
    tailAttaches.set(session.acpSessionId, attach);
  };

  // ---- Issue #3: adapter pre-warm pool ----

  /** Idle retention for a prewarmed adapter; 0 disables pre-warm entirely. */
  const prewarmTtlMs = (() => {
    const raw = Number.parseInt(env.HN_PREWARM_TTL_MS ?? '', 10);
    return Number.isFinite(raw) && raw >= 0 ? raw : 120_000;
  })();

  /**
   * A prewarmed adapter: the FULL `start` result (the session caps and agent
   * identity came from initialize — already paid) plus the dsh tap that raced
   * its spawn. Consumed by `chat:session.start`, which skips spawn+initialize
   * and goes straight to session establishment.
   */
  type PrewarmedAdapter = {
    started: Awaited<ReturnType<typeof AcpAgentConnection.start>>;
    tapArmed: Awaited<ReturnType<typeof armTap>>;
    tapLive: boolean;
  };

  /**
   * Boot ONE adapter per target to a completed initialize — ledgered under a
   * `prewarm-<target>` pseudo id (the consuming channel deletes that file and
   * re-ledgers under its own id; TTL/teardown kills leave the file for the
   * audit, per the W11 A rule). All failures are silent: the pool is a cache,
   * a miss just means the channel spawns fresh exactly as before.
   */
  const prewarmPool = new PrewarmPool<PrewarmedAdapter>({
    ttlMs: prewarmTtlMs,
    spawn: async (key) => {
      const cmd = resolveAcpCommand(key as AgentTarget, env, { homeDir: home });
      if (cmd === null) return null;
      const tapArmed = await armTap(key);
      // Same env layering as the channel spawn (target env + test spawnEnv),
      // minus the cwd — a prewarm has no session yet, so it boots in `home`.
      const baseEnv = { ...(cmd.env ?? {}), ...(opts.spawnEnv ?? {}) };
      const ledgerPrewarm = (pgid: number): void => {
        writeAdapterLedgerEntry(home, {
          pgid,
          target: key,
          command: cmd.command,
          wireSessionId: `prewarm-${key}`,
          startedAt: Date.now(),
        });
      };
      try {
        let started: Awaited<ReturnType<typeof AcpAgentConnection.start>>;
        let tapLive = false;
        if (tapArmed === null) {
          started = await AcpAgentConnection.start(cmd.command, cmd.args, {
            cwd: home,
            ...(Object.keys(baseEnv).length > 0 ? { env: baseEnv } : {}),
            onSpawned: ledgerPrewarm,
          });
        } else {
          [started, tapLive] = await Promise.all([
            AcpAgentConnection.start(cmd.command, [...cmd.args, '--patch', tapArmed.patchPath], {
              cwd: home,
              env: {
                ...baseEnv,
                HNX_TAP_PORT: String(tapArmed.listener.port),
                HNX_TAP_TOKEN: tapArmed.listener.token,
              },
              onSpawned: ledgerPrewarm,
            }),
            tapArmed.hello,
          ]);
          if (!tapLive) {
            // A session-less listener that never handshook is dead weight; the
            // consuming channel falls back to the transcript tail, same as a
            // tap-less spawn.
            tapArmed.listener.close();
            return { started, tapArmed: null, tapLive: false };
          }
        }
        return { started, tapArmed, tapLive };
      } catch {
        tapArmed?.listener.close();
        return null; // spawn/init failure — cleaned up inside start
      }
    },
    isAlive: (v) => v.started.conn.isGroupAlive(),
    kill: (v) => {
      v.tapArmed?.listener.close();
      v.started.conn.kill();
    },
  });

  // ---- server → daemon: keep one adapter warm (Issue #3) ----
  socket.on('chat:adapter.prewarm', (payload: unknown, ack?: (res: unknown) => void) => {
    const parsed = chatAdapterPrewarmEventSchema.safeParse(payload);
    if (
      !parsed.success ||
      prewarmTtlMs <= 0 ||
      !(PREWARM_ADAPTER_TARGETS as readonly string[]).includes(parsed.data.target)
    ) {
      ack?.({ accepted: false });
      return;
    }
    prewarmPool.prewarm(parsed.data.target);
    ack?.({ accepted: true });
  });

  // ---- server → daemon: spawn the channel ----
  socket.on('chat:session.start', (payload: unknown, ack?: (res: unknown) => void) => {
    const parsed = chatSessionStartEventSchema.safeParse(payload);
    if (!parsed.success) {
      ack?.({ error: 'proto:invalid' });
      return;
    }
    ack?.({ accepted: true });
    const { sessionId, target, cwd, resume, modelOptions, prewarm } = parsed.data;
    void (async () => {
      inFlightStarts.add(sessionId);
      // 9 W16 — pi rides the in-daemon ACP façade (PiRpcConnection), not an
      // ACP adapter subprocess; everything downstream is shared verbatim.
      const isPi = target === 'pi';
      const cmd = isPi ? resolvePiCommand(env) : resolveAcpCommand(target, env);
      if (cmd === null) {
        socket.emit('chat:session.ready', {
          sessionId,
          error: `no ACP adapter for target '${target}'`,
        });
        return;
      }
      // Issue #3 — adopt a READY prewarmed adapter (skip spawn + initialize;
      // the tap already raced ITS spawn). A miss — no entry, still booting,
      // dead, or pi — spawns fresh exactly as before this feature.
      const prewarmed =
        !isPi && prewarmTtlMs > 0 && (PREWARM_ADAPTER_TARGETS as readonly string[]).includes(target)
          ? prewarmPool.consume(target)
          : null;
      if (prewarmed !== null) {
        // The pseudo ledger entry's group IS this conn — replace it below with
        // the channel's own entry (re-ledgered after registration).
        deleteAdapterLedgerEntry(home, `prewarm-${target}`);
      }
      // A failed establishment (resume model/cwd mismatch, "already active",
      // the startup race giving up, initialize timeout) must NOT leave the
      // spawned adapter running: the channel dies server-side, so nothing
      // would ever kill it. Track the connection from spawn to outcome.
      let liveConn: AgentConnection | null = null;
      // 9 W7.1 — arm the tap before the spawn (the child needs the port/token
      // env); the spawn and the plugin's hello then race in parallel.
      // (A consumed prewarm already carries its tap arm.)
      const tapArmed = prewarmed !== null ? prewarmed.tapArmed : await armTap(target);
      // Consumes the id: true once the channel was closed while we were busy.
      // Called at every checkpoint — a close that raced the establishment must
      // not leave the spawned adapter behind with no channel to own it.
      const abortIfClosed = (): boolean => {
        if (!closedBeforeReady.delete(sessionId)) return false;
        tapArmed?.listener.close();
        liveConn?.kill();
        return true;
      };
      if (abortIfClosed()) return;
      try {
        // 9 W11 A — ledger the process group the moment it exists (inside
        // start, right after the detached spawn and before initialize): a
        // hard death during establishment still leaves a boot-sweepable
        // record. The entry is re-written after registration with the native
        // session id; removal is the audit's job, never a kill path.
        const ledgerStartedAt = Date.now();
        let ledgerPgid: number | null = null;
        let started:
          | Awaited<ReturnType<typeof AcpAgentConnection.start>>
          | Awaited<ReturnType<typeof PiRpcConnection.start>>;
        let tapLive = false;
        if (prewarmed !== null) {
          started = prewarmed.started;
          tapLive = prewarmed.tapLive;
          ledgerPgid = prewarmed.started.conn.pgid;
          liveConn = prewarmed.started.conn;
        } else {
          const onSpawned = (pgid: number): void => {
            ledgerPgid = pgid;
            writeAdapterLedgerEntry(home, {
              pgid,
              target,
              command: cmd.command,
              wireSessionId: sessionId,
              startedAt: ledgerStartedAt,
            });
          };
          // 9 W14.1 — target-scoped adapter env (claude-code's todo-tool
          // opt-in) layers UNDER the daemon spawn env and the tap vars.
          const baseEnv = { ...(cmd.env ?? {}), ...(opts.spawnEnv ?? {}) };
          const spawnOpts = {
            cwd,
            onSpawned,
            ...(tapArmed === null
              ? Object.keys(baseEnv).length > 0
                ? { env: baseEnv }
                : {}
              : {
                  env: {
                    ...baseEnv,
                    HNX_TAP_PORT: String(tapArmed.listener.port),
                    HNX_TAP_TOKEN: tapArmed.listener.token,
                  },
                }),
          };
          const args = tapArmed === null ? cmd.args : [...cmd.args, '--patch', tapArmed.patchPath];
          if (isPi) {
            // The tap is dsh-only, so args are bare here by construction.
            started = await PiRpcConnection.start(cmd.command, args, {
              ...spawnOpts,
              sessionsDir: join(home, '.pi', 'agent', 'sessions'),
            });
          } else if (tapArmed === null) {
            started = await AcpAgentConnection.start(cmd.command, args, spawnOpts);
          } else {
            [started, tapLive] = await Promise.all([
              AcpAgentConnection.start(cmd.command, args, spawnOpts),
              tapArmed.hello,
            ]);
          }
        }
        const { conn, agentInfo, sessionCaps, promptCaps } = started;
        liveConn = conn;
        // `mcpServers` is sent explicitly (spec: an array): ACP wrappers
        // (zed 0.23.x AND the @agentclientprotocol one we ship for claude-code)
        // zod-validate session establishment and reject an absent field with
        // `Invalid params` — adapters are
        // pulled latest by `npx -y`, so the client must be maximally
        // spec-shaped. Startup race (seen on real dsh 0.1.2-rc.1): an
        // establishment fired the instant initialize resolves can beat the
        // agent's model-adapter REGISTRATION ("-32605 no adapter registered
        // for provider …"). Retry that specific failure a few times.
        let acpSessionId: string;
        let history: HistoryItem[] = [];
        // 9 W9 A — the establishment response's session-config snapshot
        // (modes + configOptions). Read from whichever arm established the
        // session; null when the adapter advertised nothing (or only junk).
        let establishedConfig: ReturnType<typeof takeSessionConfig> = null;
        if (resume === undefined) {
          const created = (await establish(conn, 'session/new', { cwd, mcpServers: [] })) as {
            sessionId?: string;
          };
          acpSessionId = created?.sessionId ?? sessionId;
          establishedConfig = takeSessionConfig(created);
        } else {
          // 9 W7 — pick the method from the ADVERTISED capability: `load`
          // replays history (captured below), `resume` does not (dsh → we
          // parse its transcript file instead).
          if (sessionCaps.load) {
            const captured: HistoryItem[] = [];
            const stopCapture = wireCapture(conn, captured);
            try {
              const loaded = (await establish(conn, 'session/load', {
                sessionId: resume.sessionId,
                cwd,
                mcpServers: [],
              })) as { sessionId?: string };
              acpSessionId = loaded?.sessionId ?? resume.sessionId;
              history = rewriteHistoryItems(finishCaptured(captured), { target, modelOptions });
              establishedConfig = takeSessionConfig(loaded);
            } finally {
              stopCapture();
            }
          } else if (sessionCaps.resume) {
            const resumed = (await establish(conn, 'session/resume', {
              sessionId: resume.sessionId,
              cwd,
              mcpServers: [],
            })) as Record<string, unknown>;
            acpSessionId = resume.sessionId;
            establishedConfig = takeSessionConfig(resumed);
            history =
              target === 'deepseek' ? await dshTranscriptHistory(home, resume.sessionId) : [];
          } else {
            throw new Error(`ACP adapter for '${target}' supports no session resume`);
          }
        }
        // Registration is the point of no return: after it, `teardown` owns the
        // connection. Re-check the close flag here — there is no await between
        // this test and `sessions.set`, so no interleaving can slip past.
        if (abortIfClosed()) return;
        // 9 W13 — narrow the model-category options to the configured set
        // BEFORE they reach any wire surface (snapshot, ring, resync).
        if (establishedConfig !== null) {
          establishedConfig = {
            ...establishedConfig,
            options: rewriteSessionConfigOptions(establishedConfig.options, {
              target,
              modelOptions,
            }),
          };
        }
        const session: DaemonSession = {
          sessionId,
          acpSessionId,
          target,
          command: cmd.command,
          startedAt: ledgerStartedAt,
          conn,
          busy: false,
          permissions: new Map(),
          elicitations: new Map(),
          config: establishedConfig ?? { options: [] },
          ...(modelOptions !== undefined ? { modelOptions } : {}),
          history: [],
          wireTextEmitted: false,
          tailReplayEligible: resume === undefined,
          tail: null,
          tap: null,
          tapMapper: null,
          tapTurnEndAt: 0,
          tapDead: false,
        };
        sessions.set(sessionId, session);
        liveConn = null; // registered — teardown owns the connection from here
        // 9 W11 A — enrich the ledger entry with the native session id (the
        // adapter report in slice C and post-mortem forensics key off it).
        // A consumed prewarm's pgid rides along — its `prewarm-<target>` file
        // was already deleted at adoption, so this is now the only entry.
        if (ledgerPgid !== null) {
          writeAdapterLedgerEntry(home, {
            pgid: ledgerPgid,
            target,
            command: cmd.command,
            wireSessionId: sessionId,
            nativeSessionId: acpSessionId,
            startedAt: ledgerStartedAt,
          });
        }
        // Issue #3 — the switch was on at open time: re-arm one fresh
        // prewarmed adapter so the NEXT open on this target is warm too
        // (fire-and-forget; the pool dedupes and the TTL bounds it).
        if (prewarm === true && !isPi && prewarmTtlMs > 0) prewarmPool.prewarm(target);
        wireSession(session, emitEvent);
        conn.onExit(() => {
          // Crash/quit outside our control — end the channel honestly.
          if (sessions.get(sessionId) === session) teardown(session, 'agent-exited');
        });
        // 9 W7.1 — the tap won the handshake race: it IS the streaming
        // source and the transcript tail never attaches. A lost race closes
        // the listener (a late plugin hello finds a dead port and goes
        // dormant) and ensureTail streams exactly as in W7.
        if (tapArmed !== null) {
          if (tapLive) {
            session.tap = tapArmed.listener;
            session.tapMapper = createDshLiveMapper();
            tapArmed.bind(
              (sid, busEvent) => {
                if (sessions.get(sessionId) !== session || sid !== session.acpSessionId) return;
                if (busEvent['type'] === 'turn/end') session.tapTurnEndAt = Date.now();
                for (const event of session.tapMapper?.(busEvent) ?? []) {
                  emitEvent(session, event);
                }
              },
              () => {
                if (sessions.get(sessionId) !== session) return;
                session.tap = null;
                session.tapMapper = null;
                session.tapDead = true;
                console.warn(
                  '[chat] dsh event tap lost — committed-only streaming for this session',
                );
              },
            );
          } else {
            tapArmed.listener.close();
          }
        }
        // dsh streaming: fire-and-forget the tail attach (a resume's file
        // exists already; a new session's appears at first prompt — ensureTail
        // re-runs then). Suppression is keyed off the live tail, never a
        // pending attach, so it cannot be active without the tail.
        ensureTail(session);
        emitHistory(session, history);
        // 9 W9 A — the authoritative config snapshot rides AFTER the replayed
        // history (a load's replay patches settle first; last write wins) and
        // enters the ring, so a resync restores the selectors.
        if (establishedConfig !== null) emitConfig(session);
        socket.emit('chat:session.ready', {
          sessionId,
          nativeSessionId: acpSessionId,
          ...(agentInfo.name !== undefined ? { agentName: agentInfo.name } : {}),
          ...(agentInfo.version !== undefined ? { agentVersion: agentInfo.version } : {}),
          promptCapabilities: promptCaps,
        });
      } catch (e) {
        tapArmed?.listener.close();
        liveConn?.kill();
        socket.emit('chat:session.ready', {
          sessionId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })().finally(() => inFlightStarts.delete(sessionId));
  });

  // ---- server → daemon: prompt / cancel / permission / disconnect / resync ----
  socket.on('chat:message.send', (payload: unknown, ack?: (res: unknown) => void) => {
    const parsed = chatPromptEventSchema.safeParse(payload);
    if (!parsed.success) {
      ack?.({ error: 'proto:invalid' });
      return;
    }
    const session = sessions.get(parsed.data.sessionId);
    if (session === undefined) {
      ack?.({ error: 'unknown-session' });
      return;
    }
    if (session.busy) {
      // Lost the race against the server's busy gate — resync it.
      emitEvent(session, { kind: 'session_status', state: 'active' });
      ack?.({ error: 'session-busy' });
      return;
    }
    ack?.({ accepted: true });
    // The history ring must know the user turn too — a resync rebuilds the
    // fold from items alone (no optimistic browser echo on that path).
    pushHistory(session, { type: 'user', blocks: parsed.data.prompt });
    ensureTail(session); // lazy materialization: a new dsh file appears now
    void runPrompt(session, parsed.data.prompt, emitEvent);
  });

  socket.on('chat:turn.cancel', (payload: unknown, ack?: (res: unknown) => void) => {
    const parsed = chatTurnCancelEventSchema.safeParse(payload);
    if (!parsed.success) {
      ack?.({ error: 'proto:invalid' });
      return;
    }
    const session = sessions.get(parsed.data.sessionId);
    if (session === undefined) {
      ack?.({ error: 'unknown-session' });
      return;
    }
    ack?.({ accepted: true });
    // Settle every pending permission / elicitation card NOW: the adapter may
    // drop its outstanding requests when the turn aborts, and without this
    // the cards linger until the 75s backstop — with the turn dead they read
    // as "cannot stop the session" (#7 rig report).
    for (const [requestId, pending] of session.permissions) {
      clearTimeout(pending.timer);
      session.permissions.delete(requestId);
      session.conn.respondPermission(pending.jsonrpcId, { outcome: 'cancelled' });
      emitEvent(session, { kind: 'permission_resolved', requestId, outcome: 'cancelled' });
    }
    for (const [requestId, pending] of session.elicitations) {
      clearTimeout(pending.timer);
      session.elicitations.delete(requestId);
      session.conn.respondElicitation(pending.jsonrpcId, { action: 'cancel' });
      emitEvent(session, { kind: 'elicitation_resolved', requestId, outcome: 'cancelled' });
    }
    // The pending session/prompt resolves as 'cancelled' → turn_result fires.
    void session.conn.request('session/cancel', {}, 5000).catch(() => {});
  });

  // 9 W9 A — switch the live session's permission mode / one config option.
  // NOT busy-gated: dsh pins the selection per PROMPT (a mid-turn set applies
  // to the next turn) and the UI disables the selectors during a turn anyway.
  socket.on('chat:config.set', (payload: unknown, ack?: (res: unknown) => void) => {
    const parsed = chatConfigSetEventSchema.safeParse(payload);
    if (!parsed.success) {
      ack?.({ error: 'proto:invalid' });
      return;
    }
    const session = sessions.get(parsed.data.sessionId);
    if (session === undefined) {
      ack?.({ error: 'unknown-session' });
      return;
    }
    const set = parsed.data;
    const request =
      set.kind === 'mode' ? ('session/set_mode' as const) : ('session/set_config_option' as const);
    const params =
      set.kind === 'mode'
        ? { sessionId: session.acpSessionId, modeId: set.modeId }
        : { sessionId: session.acpSessionId, configId: set.configId, value: set.value };
    void session.conn.request(request, params, 15000).then(
      () => {
        // Optimistic daemon-side merge: adapters confirm/correct through
        // config pushes, but codex does not reliably push after a set —
        // without this the selector would sit on the stale value.
        if (set.kind === 'mode') {
          session.config.modes = {
            currentModeId: set.modeId,
            availableModes: session.config.modes?.availableModes ?? [],
          };
        } else {
          session.config.options = session.config.options.map((o) =>
            o.id === set.configId ? { ...o, currentValue: set.value } : o,
          );
        }
        emitConfig(session);
        ack?.({ accepted: true });
      },
      (e: unknown) => {
        ack?.({ error: e instanceof Error ? e.message : String(e) });
      },
    );
  });

  socket.on('chat:permission.respond', (payload: unknown, ack?: (res: unknown) => void) => {
    const parsed = chatPermissionRespondEventSchema.safeParse(payload);
    if (!parsed.success) {
      ack?.({ error: 'proto:invalid' });
      return;
    }
    const session = sessions.get(parsed.data.sessionId);
    if (session === undefined) {
      ack?.({ error: 'unknown-session' });
      return;
    }
    const pending = session.permissions.get(parsed.data.requestId);
    if (pending === undefined) {
      ack?.({ error: 'unknown-permission' });
      return;
    }
    ack?.({ accepted: true });
    clearTimeout(pending.timer);
    session.permissions.delete(parsed.data.requestId);
    // optionId is forwarded VERBATIM (a rewritten id counts as a rejection).
    session.conn.respondPermission(
      pending.jsonrpcId,
      parsed.data.optionId !== undefined
        ? { outcome: 'selected', optionId: parsed.data.optionId }
        : { outcome: 'cancelled' },
    );
    // Record the resolution in the history ring (record-only — the server
    // broadcasts the live event): without it, a resync (session switch back,
    // rejoin, ready re-push) replays the original `permission_request` and
    // the answered card REAPPEARS as unsettled (#7 rig report).
    pushHistory(session, {
      type: 'event',
      event: {
        kind: 'permission_resolved',
        requestId: parsed.data.requestId,
        outcome: parsed.data.optionId !== undefined ? 'selected' : 'cancelled',
        ...(parsed.data.optionId !== undefined ? { optionId: parsed.data.optionId } : {}),
      },
    });
  });

  socket.on('chat:elicitation.respond', (payload: unknown, ack?: (res: unknown) => void) => {
    const parsed = chatElicitationRespondEventSchema.safeParse(payload);
    if (!parsed.success) {
      ack?.({ error: 'proto:invalid' });
      return;
    }
    const session = sessions.get(parsed.data.sessionId);
    if (session === undefined) {
      ack?.({ error: 'unknown-session' });
      return;
    }
    const pending = session.elicitations.get(parsed.data.requestId);
    if (pending === undefined) {
      ack?.({ error: 'unknown-elicitation' });
      return;
    }
    ack?.({ accepted: true });
    clearTimeout(pending.timer);
    session.elicitations.delete(parsed.data.requestId);
    // Values ride VERBATIM as the ACP `content` — the wrapper folds an
    // accept back into the tool input keyed by these exact property names.
    const { action, values } = parsed.data;
    session.conn.respondElicitation(
      pending.jsonrpcId,
      action === 'accept'
        ? { action: 'accept', content: values ?? {} }
        : action === 'decline'
          ? { action: 'decline' }
          : { action: 'cancel' },
    );
    // Ring record for the resync path, same rationale as permissions above.
    pushHistory(session, {
      type: 'event',
      event: {
        kind: 'elicitation_resolved',
        requestId: parsed.data.requestId,
        outcome: action === 'accept' ? 'accepted' : action === 'decline' ? 'declined' : 'cancelled',
      },
    });
  });

  socket.on('chat:session.close', (payload: unknown, ack?: (res: unknown) => void) => {
    const parsed = chatSessionCloseEventSchema.safeParse(payload);
    if (!parsed.success) {
      ack?.({ error: 'proto:invalid' });
      return;
    }
    const session = sessions.get(parsed.data.sessionId);
    if (session !== undefined) {
      // Best-effort session/close, then SIGTERM (kill is on a 3s grace). The
      // AGENT's session survives this (9 W7) — only the subprocess ends.
      void session.conn.request('session/close', {}, 3000).catch(() => {});
      teardown(session, parsed.data.reason ?? 'user');
    } else {
      // Possibly mid-establishment — let the start handler abort. The reply is
      // `{closed:true}` either way: the channel IS gone from the caller's view.
      if (closedBeforeReady.size >= CLOSED_BEFORE_READY_MAX) closedBeforeReady.clear();
      closedBeforeReady.add(parsed.data.sessionId);
    }
    ack?.({ closed: true });
  });

  // 9 W7 — a viewer (re)joined a live channel (page refresh): re-emit the
  // history ring so the rebuilt fold shows what already happened.
  socket.on('chat:session.resync', (payload: unknown, ack?: (res: unknown) => void) => {
    const parsed = chatSessionResyncEventSchema.safeParse(payload);
    if (!parsed.success) {
      ack?.({ error: 'proto:invalid' });
      return;
    }
    const session = sessions.get(parsed.data.sessionId);
    if (session !== undefined && session.history.length > 0) {
      socket.emit('chat:history', {
        sessionId: session.sessionId,
        items: session.history.slice(-HISTORY_MAX),
      });
    }
    ack?.({ accepted: true });
  });

  // 9 W11 C — the adapter report: present-tense process truth from the live
  // sessions map (the LEDGER is crash accounting, not a status surface; a
  // report built from it could list processes that already died). Instant by
  // construction — no spawn, no round-trip beyond the socket.
  socket.on('adapters:report', (payload: unknown, ack?: (res: unknown) => void) => {
    const parsed = adaptersReportRequestSchema.safeParse(payload);
    if (!parsed.success) {
      ack?.({ error: 'proto:invalid' });
      return;
    }
    ack?.({ accepted: true });
    socket.emit('adapters:report:result', {
      requestId: parsed.data.requestId,
      adapters: [...sessions.values()].map((s) => ({
        wireSessionId: s.sessionId,
        target: s.target,
        pgid: s.conn.pgid ?? 0,
        nativeSessionId: s.acpSessionId,
        startedAt: s.startedAt,
        command: s.command,
      })),
    });
  });

  // 9 W11 E — the server's live rows for this machine, sent on EVERY /ctl
  // (re)connect. Drop what it disowned; report what we still hold.
  socket.on('chat:reconcile', (payload: unknown, ack?: (res: unknown) => void) => {
    const parsed = chatReconcileEventSchema.safeParse(payload);
    if (!parsed.success) {
      ack?.({ error: 'proto:invalid' });
      return;
    }
    const listed = new Set(parsed.data.sessionIds);
    // A session whose row is gone server-side (reaped past the server's
    // grace, or the server restarted) is unjoinable and invisible — no tab,
    // no closer — tear it down now instead of leaking the adapter.
    for (const session of [...sessions.values()]) {
      if (!listed.has(session.sessionId)) teardown(session, 'reconciled');
    }
    // The same orphan risk exists MID-ESTABLISHMENT: flag unlisted starts so
    // they abort at their checkpoints (the close-consume path).
    for (const id of inFlightStarts) {
      if (listed.has(id)) continue;
      if (closedBeforeReady.size >= CLOSED_BEFORE_READY_MAX) closedBeforeReady.clear();
      closedBeforeReady.add(id);
    }
    // Held = registered sessions + establishments in flight for rows the
    // server still knows (reporting an unlisted in-flight start as held
    // would keep a ghost row alive).
    const held = [...sessions.keys(), ...[...inFlightStarts].filter((id) => listed.has(id))];
    ack?.({ held: held.slice(0, 64) });
  });

  // A reconnect within the grace window revives every channel: cancel the
  // pending teardown BEFORE the server's reconcile lands (its list decides
  // what survives; the grace only buys time for the reconnect itself).
  socket.on('connect', () => {
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  });

  socket.on('disconnect', (reason: string) => {
    // 9 W11 E — a deliberate stop ('io client disconnect': SIGTERM → stop())
    // or the kill-switch (HN_TEARDOWN_GRACE_MS=0) tears down immediately,
    // exactly as before. A transport blip instead HOLDS every channel for
    // the grace window: Socket.IO reconnects within ~1s, the server mirrors
    // the grace on its reap, and a mid-grace turn keeps running against the
    // local adapter (packets buffer; the viewer resyncs on rejoin).
    if (graceMs <= 0 || reason === 'io client disconnect') {
      if (graceTimer !== null) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
      for (const session of [...sessions.values()]) teardown(session, 'daemon-disconnected');
      prewarmPool.teardownAll(); // Issue #3 — deliberate stop owns idle adapters too
      return;
    }
    if (graceTimer !== null) return; // already armed by an earlier blip cycle
    graceTimer = setTimeout(() => {
      graceTimer = null;
      for (const session of [...sessions.values()]) teardown(session, 'daemon-disconnected');
      prewarmPool.teardownAll();
    }, graceMs);
    graceTimer.unref();
  });

  return {
    liveConnectionFor,
    /** Issue #3 — is a prewarmed adapter READY (initialized, alive) for the target? */
    prewarmReady: (target: string): boolean => prewarmPool.readyKeys().includes(target),
    /** #39 — live channels, oldest first (the TUI's agents pane). */
    sessionsSnapshot: (): SessionView[] =>
      [...sessions.values()]
        .map((s) => {
          const usage = usageLedger.sessionUsage(s.sessionId);
          return {
            sessionId: s.sessionId,
            acpSessionId: s.acpSessionId,
            target: s.target,
            command: s.command,
            startedAt: s.startedAt,
            busy: s.busy,
            model: modelOf(s.config, s.modelOptions),
            turns: usage?.turns ?? 0,
            inputTokens: usage?.inputTokens ?? 0,
            outputTokens: usage?.outputTokens ?? 0,
            cacheReadTokens: usage?.cacheReadTokens ?? 0,
            cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
            costUsd: usage?.costUsd ?? 0,
            events: s.history.length,
          };
        })
        .sort((a, b) => a.startedAt - b.startedAt),
    /** #39 — the pre-warm pool's live entries. */
    prewarmStatus: (): PrewarmView[] => prewarmPool.status(),
    usage: usageLedger,
  };
}

/**
 * Session establishment (`session/new` / `session/load` / `session/resume`)
 * with a retry for the agent-startup registration race: a rejection
 * mentioning "no adapter registered" is retried with a short backoff — the
 * adapter finishes registering moments later.
 */
async function establish(
  conn: AgentConnection,
  method: string,
  params: unknown,
  attempt = 1,
): Promise<unknown> {
  try {
    return await conn.request(method, params, 20000);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (attempt < 4 && /no adapter registered/i.test(msg)) {
      await new Promise((r) => setTimeout(r, 600 * attempt));
      return establish(conn, method, params, attempt + 1);
    }
    throw e;
  }
}

/**
 * Capture `session/update` notifications into `items` instead of emitting —
 * used while `session/load` replays an agent's history (claude/codex replay
 * BEFORE the load response resolves). `user_message_chunk` becomes a USER
 * item (on the live path it is dropped as a browser echo); everything else
 * maps through the ordinary update mapping. Returns the deactivation.
 */
function wireCapture(conn: AgentConnection, items: HistoryItem[]): () => void {
  const handler = (method: string, params: Record<string, unknown>): void => {
    if (method !== 'session/update') return;
    const update = (params.update ?? {}) as Record<string, unknown>;
    if (update.sessionUpdate === 'user_message_chunk') {
      const text = textOf(update.contentBlock) || textOf(update.content);
      if (text !== '') items.push({ type: 'user', blocks: [{ type: 'text', text }] });
      return;
    }
    const mapped = mapAcpUpdate(params);
    if (mapped !== null) items.push({ type: 'event', event: mapped });
  };
  conn.setNotificationHandler(handler);
  return () => conn.setNotificationHandler(() => {});
}

/** Close the captured batch: guarantee a trailing turn_result so the fold settles. */
function finishCaptured(items: HistoryItem[]): HistoryItem[] {
  const last = items[items.length - 1];
  if (last !== undefined && last.type === 'event' && last.event.kind !== 'turn_result') {
    items.push({ type: 'event', event: { kind: 'turn_result', stopReason: 'end_turn' } });
  }
  return items;
}

/**
 * dsh resume history — the adapter restores the log WITHOUT replaying, so the
 * transcript file is the source. Best-effort by design: a missing/unreadable
 * transcript (or no zstd on this Node) resumes WITHOUT history rather than
 * failing the channel.
 */
async function dshTranscriptHistory(home: string, sessionId: string): Promise<HistoryItem[]> {
  try {
    const root = join(home, '.dsh', 'sessions');
    const zstd = nativeZstd();
    if (zstd === null) return [];
    for (const slug of readdirSync(root)) {
      const candidate = join(root, slug, sessionId, 'session.jsonl.zstd');
      try {
        return dshHistoryItems(decodeTranscript(readFileSync(candidate), zstd));
      } catch {
        // not under this slug (or undecodable) — try the next
      }
    }
    return [];
  } catch {
    return [];
  }
}

/** Hook ACP frames for one live session onto the semantic stream. */
function wireSession(
  session: DaemonSession,
  emitEvent: (session: DaemonSession, event: ChatStreamEvent) => void,
): void {
  const { conn } = session;

  conn.setNotificationHandler((method, params) => {
    if (method !== 'session/update') return;
    const update = (params.update ?? {}) as Record<string, unknown>;
    // 9 W9 A — session-config pushes merge into the daemon's snapshot and
    // re-emit it in full (needs the session state, so they are intercepted
    // BEFORE the stateless mapping below).
    if (update.sessionUpdate === 'current_mode_update') {
      const modeId =
        typeof update.currentModeId === 'string' && update.currentModeId !== ''
          ? update.currentModeId
          : null;
      if (modeId !== null) {
        session.config.modes = {
          currentModeId: modeId,
          availableModes: session.config.modes?.availableModes ?? [],
        };
        emitEvent(session, { kind: 'session_config', modes: { ...session.config.modes } });
      }
      return;
    }
    if (update.sessionUpdate === 'config_option_update') {
      const options = takeConfigOptions(update.configOptions);
      if (options !== null) {
        // 9 W13 — the adapter re-emits its FULL list after every set; the
        // rewrite must ride here too or the built-in noise comes back
        // mid-session. Idempotent by construction.
        session.config.options = rewriteSessionConfigOptions(options, session);
        emitEvent(session, { kind: 'session_config', configOptions: session.config.options });
      }
      return;
    }
    // dsh commits block-level text at turn end — while a streaming source is
    // live (the transcript tail OR the 9 W7.1 event tap), its deltas already
    // streamed this content AND its mapper emits the complete blocks for
    // steps whose deltas it never saw, so the wire's committed chunk is
    // redundant in every case; letting it through would double-render the
    // message. Tools/usage still flow (idempotent by callId / field-merged).
    if (
      (session.tail !== null || session.tap !== null) &&
      (update.sessionUpdate === 'agent_message_chunk' ||
        update.sessionUpdate === 'agent_thought_chunk')
    ) {
      return;
    }
    const mapped = mapAcpUpdate(params);
    if (mapped !== null) {
      if (
        (mapped.kind === 'message_delta' || mapped.kind === 'thought_delta') &&
        session.tail === null &&
        session.tap === null
      ) {
        // Committed text rendered through the wire — a FUTURE tail attach
        // must skip the file's existing bytes (replaying would duplicate).
        session.wireTextEmitted = true;
      }
      emitEvent(session, mapped);
    }
  });

  conn.setPermissionHandler((jsonrpcId, params) => {
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      // Belt-and-braces: the server runs its own watchdog; this backstop
      // guarantees the agent never waits forever even if the server is gone.
      session.permissions.delete(requestId);
      conn.respondPermission(jsonrpcId, { outcome: 'cancelled' });
      emitEvent(session, {
        kind: 'permission_resolved',
        requestId,
        outcome: 'timeout',
      });
    }, 75000);
    session.permissions.set(requestId, { jsonrpcId, timer });
    emitEvent(session, {
      kind: 'permission_request',
      requestId,
      toolCall: toolCallView(params.toolCall),
      options: permissionOptions(params.options),
    });
  });

  // 9 W14.1 — ACP elicitation (form mode): claude's AskUserQuestion and
  // MCP-server elicitations arrive as `elicitation/create` requests. The
  // schema reduces to bounded render hints; an unrepresentable schema still
  // surfaces (empty fields → decline/cancel card only).
  conn.setElicitationHandler((jsonrpcId, params) => {
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      // Belt-and-braces backstop, same policy as permissions: the server
      // runs its own watchdog; this guarantees the agent never waits forever
      // even if the server is gone.
      session.elicitations.delete(requestId);
      conn.respondElicitation(jsonrpcId, { action: 'cancel' });
      emitEvent(session, { kind: 'elicitation_resolved', requestId, outcome: 'timeout' });
    }, 75000);
    session.elicitations.set(requestId, { jsonrpcId, timer });
    const view = takeElicitationView(params);
    emitEvent(session, {
      kind: 'elicitation_request',
      requestId,
      message: view.message,
      fields: view.fields,
      ...(view.toolCallId !== undefined ? { toolCallId: view.toolCallId } : {}),
    });
  });
}

async function runPrompt(
  session: DaemonSession,
  prompt: PromptBlock[],
  emitEvent: (session: DaemonSession, event: ChatStreamEvent) => void,
): Promise<void> {
  const promptStartedAt = Date.now();
  session.busy = true;
  emitEvent(session, { kind: 'session_status', state: 'active' });
  try {
    // No client-side timeout: a turn can legitimately run for minutes; the
    // recovery story is cancel or channel close, not a timer.
    const result = (await session.conn.request(
      'session/prompt',
      { sessionId: session.acpSessionId, prompt },
      30 * 60 * 1000,
    )) as { stopReason?: string; usage?: unknown };
    const stopReason = (['end_turn', 'cancelled', 'max_tokens', 'refusal'] as const).includes(
      result?.stopReason as never,
    )
      ? (result!.stopReason as 'end_turn' | 'cancelled' | 'max_tokens' | 'refusal')
      : 'end_turn';
    // #44 — the response may carry per-turn usage (the end-turn-token-usage
    // RFD's v1 carrier). Only targets with a KNOWN dialect are surfaced; the
    // rest keep reporting through `usage` events (dsh/pi) or nothing (codex).
    const turnUsage =
      responseUsageMode(session.target) !== null ? normalizeUsage(result?.usage) : null;
    // dsh: the wire settles when the agent idles, but the streaming source's
    // final bytes can land a beat LATER — the transcript's write-behind
    // batch (tail) or the bus `turn/end` (tap — typically already there,
    // the adapter derives its updates from committed session events).
    // Emitting turn_result before them would render the message tail as a
    // post-turn bubble (the fold opens a new step after turn_result). So
    // drain, then wait briefly for the turn/end signal of whichever source
    // is live.
    if (session.tail !== null) {
      session.tail.flush();
      const deadline = Date.now() + 600;
      while (
        session.tail !== null &&
        !session.tail.turnEndSeenSince(promptStartedAt) &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 50));
        session.tail?.flush();
      }
    } else if (session.tap !== null) {
      const deadline = Date.now() + 600;
      while (
        session.tap !== null &&
        session.tapTurnEndAt < promptStartedAt &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    emitEvent(session, {
      kind: 'turn_result',
      stopReason,
      ...(turnUsage !== null && hasTokenCounts(turnUsage) ? { usage: turnUsage } : {}),
    });
  } catch (e) {
    // A rejected prompt is a TURN error (adapters answer protocol failures —
    // "Authentication required", upstream API errors — through JSON-RPC
    // errors while staying alive), not a dead subprocess. Real process death
    // is conn.onExit's job. Surface the error, end the turn, keep the channel.
    emitEvent(session, {
      kind: 'raw',
      method: 'hnx/prompt-error',
      params: { message: e instanceof Error ? e.message : String(e) },
    });
    session.tail?.flush();
    emitEvent(session, { kind: 'turn_result', stopReason: 'end_turn' });
  } finally {
    session.busy = false;
    emitEvent(session, { kind: 'session_status', state: 'idle' });
  }
}

/**
 * Attach a dsh transcript tail (short retry — the file materializes with the
 * session header at creation; write lag is the only window). Null = no tail
 * (committed-only streaming — today's behavior).
 */
async function attachTranscriptTail(
  home: string,
  acpSessionId: string,
  onEvent: (event: ChatStreamEvent) => void,
  onFatal: (reason: string) => void,
): Promise<TranscriptTail | null> {
  const zstd = nativeZstd();
  if (zstd === null) return null;
  const root = join(home, '.dsh', 'sessions');
  for (let attempt = 0; attempt < 6; attempt++) {
    const file = findTranscript(root, acpSessionId, (p) => readdirSync(p));
    if (file !== null) {
      return new TranscriptTail(file, nodeTailFs, zstd, onEvent, { onFatal });
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
}

// ---- pure ACP → semantic mapping (exported for unit tests) ----

type UnknownRecord = Record<string, unknown>;

/**
 * 9 W13 — flatten one level (recursively, defensively) of ACP GROUPED select
 * options into the platform's flat leaf shape, attaching the enclosing
 * group's id: dsh-acp 0.1.2-rc.1 emits its model row as
 * `options: [{group, name, options: [leaf…]}, …]`, which the flat
 * `sessionConfigOptionSchema` would reject wholesale — silently dropping the
 * whole selector (rig-found: dsh showed NO model switch at all). Leaves keep
 * their own `group` when already set.
 */
function flattenGroupedOptions(options: unknown, inheritedGroup?: string): unknown[] {
  if (!Array.isArray(options)) return [];
  const out: unknown[] = [];
  for (const entry of options) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as UnknownRecord;
    if (Array.isArray(e['options'])) {
      out.push(
        ...flattenGroupedOptions(
          e['options'],
          typeof e['group'] === 'string' ? e['group'] : inheritedGroup,
        ),
      );
    } else if (inheritedGroup !== undefined && e['group'] === undefined) {
      out.push({ ...e, group: inheritedGroup });
    } else {
      out.push(e);
    }
  }
  return out;
}

/**
 * 9 W9 A — validate an adapter's `configOptions` array down to the
 * platform's bounded view: only `type:'select'` rows survive (the three
 * shipped adapters expose mode/model/effort as selects; boolean options from
 * future adapters are dropped rather than half-surfaced). Null = nothing
 * usable in the payload.
 */
export function takeConfigOptions(raw: unknown): SessionConfigOption[] | null {
  if (!Array.isArray(raw)) return null;
  const out: SessionConfigOption[] = [];
  for (const row of raw) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as UnknownRecord;
    if (r['type'] !== undefined && r['type'] !== 'select') continue;
    const parsed = sessionConfigOptionSchema.safeParse(
      Array.isArray(r['options']) ? { ...r, options: flattenGroupedOptions(r['options']) } : r,
    );
    if (parsed.success) out.push(parsed.data);
  }
  return out.length > 0 ? out : null;
}

/**
 * 9 W9 A — the session-config slice of an establishment response
 * (`session/new` / `load` / `resume`): `modes` + `configOptions`, each
 * independently validated. Null = the adapter advertised nothing usable.
 */
export function takeSessionConfig(
  result: unknown,
): { modes?: SessionModeState; options: SessionConfigOption[] } | null {
  const r = (result ?? {}) as UnknownRecord;
  const modes = sessionModeStateSchema.safeParse(r['modes']);
  const options = takeConfigOptions(r['configOptions']);
  if (!modes.success && options === null) return null;
  return {
    ...(modes.success ? { modes: modes.data } : {}),
    options: options ?? [],
  };
}

/**
 * 9 W14 — validate/clamp an adapter `plan` update's entries down to the
 * platform's bounded view: ≤128 rows (excess dropped — a snapshot that long
 * is noise), `content` clamped to 512 chars (dropping a long row would
 * misrepresent the plan), malformed rows skipped. An EMPTY array is legal
 * (= plan cleared) and passes through.
 */
export function takePlanEntries(raw: unknown): PlanEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: PlanEntry[] = [];
  for (const row of raw) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as UnknownRecord;
    const content = typeof r['content'] === 'string' ? r['content'].slice(0, 512) : '';
    const parsed = planEntrySchema.safeParse({
      ...(content !== '' ? { content } : {}),
      ...(r['status'] !== undefined ? { status: r['status'] } : {}),
      ...(r['priority'] !== undefined ? { priority: r['priority'] } : {}),
    });
    if (parsed.success) out.push(parsed.data);
    if (out.length >= 128) break;
  }
  return out;
}

/**
 * 9 W15 — validate/clamp an `available_commands_update` catalog down to the
 * platform's bounded view: ≤64 rows, `name` VERBATIM (the `mcp:` prefix is
 * the agent's own namespacing), description clamped 512, the unstructured
 * `input.hint` clamped 256, malformed rows skipped. An EMPTY catalog is
 * legal (= no commands) and passes through.
 */
export function takeAvailableCommands(raw: unknown): AvailableCommandView[] {
  if (!Array.isArray(raw)) return [];
  const out: AvailableCommandView[] = [];
  for (const row of raw) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as UnknownRecord;
    const name = typeof r['name'] === 'string' ? r['name'].slice(0, 128) : '';
    const description = typeof r['description'] === 'string' ? r['description'].slice(0, 512) : '';
    const input = (r['input'] ?? null) as UnknownRecord | null;
    const hint =
      input !== null && typeof input['hint'] === 'string' ? input['hint'].slice(0, 256) : undefined;
    const parsed = availableCommandViewSchema.safeParse({
      ...(name !== '' ? { name } : {}),
      description,
      ...(hint !== undefined ? { hint } : {}),
    });
    if (parsed.success) out.push(parsed.data);
    if (out.length >= 64) break;
  }
  return out;
}

/** Map one ACP `session/update` params object; null = drop (user echo). */
export function mapAcpUpdate(params: UnknownRecord): ChatStreamEvent | null {
  const update = (params.update ?? {}) as UnknownRecord;
  switch (update.sessionUpdate) {
    // 9 W9 A — config pushes on the CAPTURE path (session/load replay: no
    // session state to merge into, so the adapter's patch maps verbatim).
    case 'current_mode_update': {
      const modeId =
        typeof update.currentModeId === 'string' && update.currentModeId !== ''
          ? update.currentModeId
          : null;
      return modeId === null ? null : { kind: 'session_config', modes: { currentModeId: modeId } };
    }
    case 'config_option_update': {
      const options = takeConfigOptions(update.configOptions);
      return options === null ? null : { kind: 'session_config', configOptions: options };
    }
    case 'plan': {
      // 9 W14 — full-replace todo/task snapshot. claude-agent-acp surfaces
      // TodoWrite AND TaskCreate/TaskUpdate/TaskList exclusively this way
      // (the tool calls are suppressed), codex-acp maps its update_plan tool
      // to it; opencode/dsh never emit one. Stateless: the web holds the
      // last-wins state, so the load-replay capture path needs no merge.
      // Only the stable shape (`entries`) maps; the pre-1.0 draft shape
      // (`plan.steps`) keeps the raw fallback — no shipped adapter emits it.
      if (!Array.isArray(update.entries)) {
        return { kind: 'raw', method: 'session/update', params: update };
      }
      return { kind: 'plan', entries: takePlanEntries(update.entries) };
    }
    case 'available_commands_update': {
      // 9 W15 — the agent's slash-command catalog (full replace). Pushed
      // after new/load/resume by claude-agent-acp (custom + `mcp:*`),
      // codex-acp (review family) and opencode (Command.Info — platform-
      // deployed custom commands surface here); dsh/hermes never push one.
      // Stateless like `plan` — the web's fold holds the catalog.
      return { kind: 'commands', commands: takeAvailableCommands(update.availableCommands) };
    }
    case 'agent_message_chunk': {
      const delta = chunkText(update);
      // codex-acp announces an unknown gateway model id by streaming a
      // diagnostic AS AN ASSISTANT CHUNK, so it lands mid-transcript as if the
      // model had said it. It is not model output; drop it. (The underlying
      // condition — codex's built-in registry not knowing the custom model id —
      // is what makes it fall back to a default context window; a root-level
      // `model_context_window` in config.toml overrides that window, verified
      // against codex-acp 0.16, but does not silence this notice.)
      return CODEX_MODEL_METADATA_NOTICE.test(delta) ? null : { kind: 'message_delta', delta };
    }
    case 'agent_thought_chunk':
      return { kind: 'thought_delta', delta: chunkText(update) };
    case 'tool_call':
    case 'tool_call_update': {
      // Claude adapters ride the registry key on the envelope's `_meta`.
      const meta = (params._meta ?? null) as UnknownRecord | null;
      const cc =
        meta !== null && meta.claudeCode !== null && typeof meta.claudeCode === 'object'
          ? (meta.claudeCode as UnknownRecord)
          : null;
      const metaToolName =
        cc !== null && typeof cc.toolName === 'string' && cc.toolName !== ''
          ? cc.toolName
          : undefined;
      // Two dialects: Zed adapters nest under `toolCallUpdate`; dsh's native
      // adapter spreads the fields FLAT on the update object.
      return {
        kind: 'tool_call',
        call: toolCallView(update.toolCallUpdate ?? update, metaToolName),
      };
    }
    case 'usage_update': {
      // #39 — cache fields ride the same dialect-tolerant pick as in/out
      // (see usage.ts); dsh's occupancy (`used` of `size`) stays top-level.
      // #44 — the session-usage RFD's optional CUMULATIVE cost; the ledger
      // converts to increments. Non-USD currencies are not converted here.
      const cost = asRecord(update.cost);
      const costUsd =
        cost !== null &&
        typeof cost.amount === 'number' &&
        Number.isFinite(cost.amount) &&
        cost.amount >= 0 &&
        (cost.currency === undefined || cost.currency === 'USD')
          ? cost.amount
          : undefined;
      return {
        kind: 'usage',
        ...normalizeUsage(update.usage),
        ...(costUsd !== undefined ? { costUsd } : {}),
        ...(typeof update.used === 'number' ? { contextUsed: update.used } : {}),
        ...(typeof update.size === 'number' ? { contextSize: update.size } : {}),
      };
    }
    case 'user_message_chunk':
      // The browser echoes the user's message optimistically on the live
      // path; history batches (capture mode) turn these into USER items.
      return null;
    default:
      return { kind: 'raw', method: 'session/update', params: update };
  }
}

/** Extract display text from an ACP ContentBlock chunk. */
export function textOf(contentBlock: unknown): string {
  const block = (contentBlock ?? {}) as UnknownRecord;
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? block.text : '';
    case 'resource_link':
      return `[@${String(block.name ?? '')}](${String(block.uri ?? '')})`;
    case 'image':
      return '[image]';
    case 'audio':
      return '[audio]';
    case 'resource':
      return '[resource]';
    default:
      return '';
  }
}

/**
 * Text of one message/thought chunk across the two adapter dialects: Zed
 * adapters carry `contentBlock`; dsh's native ACP adapter carries `content`
 * (a ContentBlock-shaped object without the wrapper name).
 */
function chunkText(update: UnknownRecord): string {
  const fromBlock = textOf(update.contentBlock);
  if (fromBlock !== '') return fromBlock;
  return textOf(update.content);
}

/**
 * Defensive view of an ACP ToolCallUpdate: shared-schema-validated, falling
 * back to the bare id when an adapter sends something malformed (the server
 * re-validates everything crossing the wire).
 *
 * 9 W6 enrichment: carries `toolName` (the card registry key — from the
 * update itself or the Claude `_meta.claudeCode.toolName` on the envelope),
 * `rawInput` (dropped when oversized — Write-style file bodies), structured
 * `content` (diff/text/terminal items), and the `rawOutput` text — the rich
 * tool cards' rendering inputs.
 */
export function toolCallView(toolCallUpdate: unknown, metaToolName?: string): AcpToolCallView {
  const t = (toolCallUpdate ?? {}) as UnknownRecord;
  const parsed = acpToolCallViewSchema.safeParse(buildView(t, metaToolName));
  if (parsed.success) return parsed.data;
  return { toolCallId: String(t.toolCallId ?? 'unknown') };
}

const TOOL_KINDS = new Set([
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
]);

/** Spec form is the short kind; some adapters send `readTool`-style variants. */
function normalizeKind(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  const k = raw.toLowerCase().replace(/tool$/, '');
  return TOOL_KINDS.has(k) ? k : undefined;
}

const TOOL_STATUSES = new Set(['pending', 'in_progress', 'completed', 'failed']);

function boundedString(raw: unknown, max: number): string | undefined {
  if (typeof raw !== 'string' || raw === '') return undefined;
  return raw.length <= max ? raw : raw.slice(0, max);
}

const RAW_INPUT_MAX = 32 * 1024;

/** Field-by-field extraction with every bound enforced before the parse. */
function buildView(t: UnknownRecord, metaToolName: string | undefined): UnknownRecord {
  const toolName =
    typeof t.toolName === 'string' && t.toolName !== ''
      ? t.toolName
      : typeof metaToolName === 'string' && metaToolName !== ''
        ? metaToolName
        : undefined;

  let rawInput: Record<string, unknown> | undefined;
  if (t.rawInput !== null && typeof t.rawInput === 'object' && !Array.isArray(t.rawInput)) {
    const entries = Object.entries(t.rawInput as Record<string, unknown>).filter(
      ([key]) => key.length <= 128,
    );
    try {
      if (JSON.stringify(Object.fromEntries(entries))!.length <= RAW_INPUT_MAX) {
        rawInput = Object.fromEntries(entries);
      }
    } catch {
      rawInput = undefined; // unserializable values — drop rather than fail
    }
  }

  let content: unknown[] | undefined;
  if (Array.isArray(t.content)) {
    content = t.content
      .filter((c): c is UnknownRecord => c !== null && typeof c === 'object')
      .slice(0, 16)
      .map((c) => ({
        type: c.type,
        ...(c.content !== null && typeof c.content === 'object' && !Array.isArray(c.content)
          ? {
              content: {
                type: String((c.content as UnknownRecord).type ?? ''),
                ...('text' in (c.content as UnknownRecord)
                  ? { text: boundedString((c.content as UnknownRecord).text, 100000) }
                  : {}),
              },
            }
          : {}),
        ...(typeof c.path === 'string' ? { path: boundedString(c.path, 1024) } : {}),
        ...(typeof c.oldText === 'string' ? { oldText: boundedString(c.oldText, 100000) } : {}),
        ...(typeof c.newText === 'string' ? { newText: boundedString(c.newText, 100000) } : {}),
        ...(typeof c.terminalId === 'string'
          ? { terminalId: boundedString(c.terminalId, 128) }
          : {}),
      }));
  }

  const locations = Array.isArray(t.locations)
    ? t.locations
        .filter((l): l is UnknownRecord => l !== null && typeof l === 'object')
        .slice(0, 16)
        .map((l) => ({
          path: String(l.path ?? ''),
          ...(typeof l.line === 'number' ? { line: l.line } : {}),
          ...(typeof l.lineEnd === 'number' ? { lineEnd: l.lineEnd } : {}),
        }))
        .filter((l) => l.path !== '')
    : undefined;

  return {
    toolCallId: String(t.toolCallId ?? ''),
    ...(typeof t.title === 'string' && t.title !== ''
      ? { title: boundedString(t.title, 512) }
      : {}),
    ...(toolName !== undefined ? { toolName: boundedString(toolName, 128) } : {}),
    ...(normalizeKind(t.kind) !== undefined ? { kind: normalizeKind(t.kind) } : {}),
    ...(typeof t.status === 'string' && TOOL_STATUSES.has(t.status) ? { status: t.status } : {}),
    ...(locations !== undefined && locations.length > 0 ? { locations } : {}),
    ...(rawInput !== undefined ? { rawInput } : {}),
    ...(content !== undefined ? { content } : {}),
    ...(typeof t.rawOutput === 'string' && t.rawOutput !== ''
      ? { output: boundedString(t.rawOutput, 100000) }
      : {}),
  };
}

/** Permission options, shared-schema-validated; malformed entries dropped. */
function permissionOptions(options: unknown): AcpPermissionOption[] {
  if (!Array.isArray(options)) return [];
  const out: AcpPermissionOption[] = [];
  for (const o of options) {
    const parsed = acpPermissionOptionSchema.safeParse(o);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * 9 W14.1 — reduce an ACP `elicitation/create` payload to a bounded,
 * renderable view. Structurally unusable properties are DROPPED (an empty
 * field list is valid — the card then offers decline/cancel only); every
 * string is clamped so a hostile/broken schema cannot bloat the wire.
 */
export function takeElicitationView(params: Record<string, unknown>): {
  message: string;
  fields: ElicitationField[];
  toolCallId?: string;
} {
  const message = clampElicitationText(params.message, 2048);
  const toolCallId =
    typeof params.toolCallId === 'string' && params.toolCallId.length > 0
      ? clampElicitationText(params.toolCallId, 256)
      : undefined;
  const fields: ElicitationField[] = [];
  const schema = asRecord(params.requestedSchema);
  const properties = schema !== null ? asRecord(schema.properties) : null;
  if (properties !== null) {
    const required = new Set(
      Array.isArray(schema!.required)
        ? schema!.required.filter((r): r is string => typeof r === 'string')
        : [],
    );
    for (const [name, prop] of Object.entries(properties).slice(0, 16)) {
      if (name.length === 0 || name.length > 128) continue;
      const record = asRecord(prop);
      if (record === null) continue;
      const field = elicitationField(name, record, required.has(name));
      if (field !== null) fields.push(field);
    }
  }
  return { message, fields, ...(toolCallId !== undefined ? { toolCallId } : {}) };
}

function elicitationField(
  name: string,
  prop: Record<string, unknown>,
  isRequired: boolean,
): ElicitationField | null {
  const type = typeof prop.type === 'string' ? prop.type : '';
  // `oneOf`/`enum` consts are the ACP option vocabulary (claude's
  // AskUserQuestion emits `oneOf: [{const, title, description}]`).
  const options = constOptions(prop.oneOf) ?? constOptions(prop.enum);
  const itemOptions =
    type === 'array'
      ? (constOptions(asRecord(prop.items)?.oneOf ?? null) ??
        constOptions(asRecord(prop.items)?.enum ?? null))
      : null;

  let kind: ElicitationField['type'] | null = null;
  if (options !== null && type !== 'array') kind = 'enum';
  else if (type === 'array' && itemOptions !== null) kind = 'multi';
  else if (type === 'number' || type === 'integer') kind = type;
  else if (type === 'boolean') kind = 'boolean';
  else if (type === 'string') kind = 'text';
  if (kind === null) return null; // nested objects / array-of-free-text: unusable

  const title = clampElicitationText(prop.title, 256);
  const description = clampElicitationText(prop.description, 1024);
  const placeholder = clampElicitationText(prop.placeholder, 256);
  const chosenOptions = kind === 'enum' ? options : kind === 'multi' ? itemOptions : null;
  return {
    name,
    type: kind,
    ...(title !== '' ? { title } : {}),
    ...(description !== '' ? { description } : {}),
    ...(placeholder !== '' ? { placeholder } : {}),
    ...(chosenOptions !== null ? { options: chosenOptions } : {}),
    ...(isRequired ? { required: true } : {}),
  };
}

/** `oneOf`/`enum` consts → bounded options; null when the entry is not one. */
function constOptions(raw: unknown): ElicitationField['options'] | null {
  if (!Array.isArray(raw)) return null;
  const out: NonNullable<ElicitationField['options']> = [];
  for (const entry of raw.slice(0, 32)) {
    if (typeof entry === 'string') {
      out.push({ value: clampElicitationText(entry, 1024) });
    } else {
      const record = asRecord(entry);
      if (record !== null && typeof record.const === 'string' && record.const.length > 0) {
        const label = clampElicitationText(record.title, 256);
        const description = clampElicitationText(record.description, 1024);
        out.push({
          value: clampElicitationText(record.const, 1024),
          ...(label !== '' ? { label } : {}),
          ...(description !== '' ? { description } : {}),
        });
      }
    }
  }
  return out.length > 0 ? out : null;
}

function clampElicitationText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
