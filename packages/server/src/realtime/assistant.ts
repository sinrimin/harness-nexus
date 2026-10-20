// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type {
  AssistantConfig,
  AssistantMessageRow,
  AssistantPromptBlock,
  AssistantSession,
  LlmProvider,
} from '@harness-nexus/core';
import type { ChatStreamEvent, HistoryItem, PromptBlock } from '@harness-nexus/shared';
import { generateId } from '../infra/crypto.js';
import { rowsToHistoryItems } from '../assistant/history.js';
import { imageExpiryFrom } from '../services/settings.js';
import {
  startAssistantTurn,
  TurnSetupError,
  type AssistantRunnerDeps,
  type RunningTurn,
} from '../assistant/runner.js';
import type { AssistantMcpDeps } from '../assistant/context.js';

/**
 * The assistant's realtime coordinator (#52 §7) — the LiveSender-flavored
 * half of ChatService, without the machine: channels are per-viewer rooms
 * over persisted sessions, turns run IN-PROCESS through the runner, and the
 * busy gate is PER-USER (one assistant turn at a time per user — a cost
 * guard, not a concurrency limit; machine channels are untouched by it).
 *
 * Sessions survive everything (they are DB rows); `close` only ends the
 * live channel. A viewer who leaves mid-turn loses nothing — the turn
 * finishes and history replay covers it.
 */

export interface AssistantIO {
  toChannel(sessionId: string, event: string, payload: unknown): void;
  toUser(userId: string, event: string, payload: unknown): void;
  joinChannel(socketId: string, sessionId: string): void;
  /** #57 — the owner's live /app socket ids (the viewer-grace re-check). */
  userSockets(userId: string): Promise<string[]>;
}

interface LiveChannel {
  sessionId: string;
  ownerId: string;
  /** Current config (a rebind via config.set changes it; next-turn effect). */
  assistantId: string;
  /**
   * Current provider row (#58-4). Defaults to the config's provider — the
   * config is the DEFAULT binding only — and moves when the session's model
   * select picks a model on another visible provider.
   */
  providerId: string;
  /** Current model id on that provider. */
  modelId: string;
  /** #10 semantics — depth-1 send slot, parked while the user is busy. */
  queuedPrompt: AssistantPromptBlock[] | null;
  run: RunningTurn | null;
  openedAt: number;
  /**
   * #66 — the CURRENT turn's event ring. Assistant rows batch-persist at
   * turn END, so a viewer reconnecting mid-turn would otherwise miss the
   * in-flight generation (history stops at the last complete turn and live
   * deltas resume mid-message). resync/rejoin replay history (complete
   * turns) then this ring (the in-flight one); it is cleared when the turn
   * settles, at which point history covers it. `user_message` echoes are
   * deliberately EXCLUDED — the turn's user row is persisted at turn START,
   * so history already carries it and a replayed echo would duplicate.
   */
  ring: ChatStreamEvent[];
  /**
   * #54 — LAZY persistence: the not-yet-saved row of a fresh open. Nothing
   * hits the DB until the first message (startTurn saves it), so an
   * open-then-abandon conversation leaves no trace behind a refresh.
   */
  pending?: AssistantSession | undefined;
  /**
   * #57 — the viewer grace expired while a turn was running: never abort the
   * generation (its cost is committed and its rows persist at settle) — close
   * the channel when the turn ends instead.
   */
  closeWhenIdle?: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export type AssistantOpenResult =
  | { ok: true; sessionId: string; assistantName: string }
  | { ok: false; code: 'ASSISTANT_NOT_FOUND' | 'ASSISTANT_DELETED' | 'SESSION_NOT_FOUND' };

export type AssistantSendResult = { ok: true; queued?: boolean } | { ok: false; code: string };

interface PendingApproval {
  sessionId: string;
  resolve: (allowed: boolean) => void;
  timer: NodeJS.Timeout;
}

export class AssistantRealtimeService {
  private live = new Map<string, LiveChannel>();
  /** userId → the session whose turn is running (the per-user busy gate). */
  private running = new Map<string, string>();
  /** M3 — write-tool approvals awaiting the browser's answer (or the timeout). */
  private pendingApprovals = new Map<string, PendingApproval>();
  /** #57 — armed per-user viewer-grace reaps (cancelled by onViewerBack). */
  private viewerGrace = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly deps: AssistantRunnerDeps,
    private readonly io: AssistantIO,
    /** M2 — the registry seam, resolved LAZILY (mountMcpProxy decorates after registerRealtime). */
    private readonly mcp?: AssistantMcpDeps,
    private readonly opts: { permissionTimeoutMs: number; viewerGraceMs: number } = {
      permissionTimeoutMs: 120_000,
      viewerGraceMs: 0,
    },
  ) {}

  // ---- helpers ----

  /** #66 — events kept per live channel for the mid-turn reconnect replay. */
  private static readonly RING_MAX = 2000;

  private emit(sessionId: string, event: ChatStreamEvent): void {
    this.io.toChannel(sessionId, 'assistant:event', { sessionId, event });
    // #66 — feed the reconnect ring (see LiveChannel.ring). The user_message
    // echo is history's row already; replaying it would duplicate the row.
    if (event.kind === 'user_message') return;
    const ch = this.live.get(sessionId);
    if (ch === undefined) return;
    ch.ring.push(event);
    if (ch.ring.length > AssistantRealtimeService.RING_MAX) {
      ch.ring.splice(0, ch.ring.length - AssistantRealtimeService.RING_MAX);
    }
  }

  /** #66 — replay the in-flight turn's ring into the room (rejoin/resync). */
  private replayRing(sessionId: string): void {
    const ch = this.live.get(sessionId);
    if (ch === undefined || ch.ring.length === 0) return;
    for (const event of ch.ring) {
      this.io.toChannel(sessionId, 'assistant:event', { sessionId, event });
    }
  }

  private channelOf(userId: string, sessionId: string): LiveChannel | null {
    const ch = this.live.get(sessionId);
    return ch !== undefined && ch.ownerId === userId ? ch : null;
  }

  private async configOf(userId: string, assistantId: string): Promise<AssistantConfig | null> {
    const config = await this.deps.uow.assistants.findById(assistantId);
    return config !== null && config.ownerId === userId ? config : null;
  }

  /**
   * The composer's selectors: agent + model options (W9 opaque-value surface).
   * #58-4 — the model select spans EVERY provider visible to the owner
   * (personal own + global), grouped by provider name; values are the opaque
   * compound `providerId/modelId` (ids are base64url — no `/` inside). The
   * config's provider+model are only the channel's initial binding.
   */
  private async visibleProviders(userId: string): Promise<LlmProvider[]> {
    const [own, global] = await Promise.all([
      this.deps.uow.llmProviders.list({ scope: 'personal', ownerId: userId }),
      this.deps.uow.llmProviders.list({ scope: 'global' }),
    ]);
    return [...own, ...global];
  }

  private async sessionConfigEvent(ch: LiveChannel): Promise<ChatStreamEvent> {
    const [configs, providers] = await Promise.all([
      this.deps.uow.assistants.listByOwner(ch.ownerId),
      this.visibleProviders(ch.ownerId),
    ]);
    const models = providers.flatMap((p) =>
      p.models
        .filter((m) => m.type === 'chat')
        .map((m) => ({ value: `${p.id}/${m.id}`, name: m.displayName ?? m.id, group: p.name })),
    );
    return {
      kind: 'session_config',
      configOptions: [
        {
          id: 'agent',
          name: 'Assistant',
          currentValue: ch.assistantId,
          options: configs.map((c) => ({ value: c.id, name: c.name })),
        },
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          currentValue: `${ch.providerId}/${ch.modelId}`,
          options: models,
        },
      ],
    };
  }

  /** The rail's truth: the owner's sessions + live busy flags. */
  snapshotFor(userId: string): Promise<{ sessions: (AssistantSession & { busy: boolean })[] }> {
    // #54 — legacy empty opens (pre-lazy rows: no messages, no live channel)
    // stay hidden; fresh empties can no longer exist — opens are lazy.
    return this.deps.uow.assistants.listSessions(userId).then((sessions) => ({
      sessions: sessions
        .filter((s) => s.lastMessageAt !== null || this.live.has(s.id))
        .map((s) => ({
          ...s,
          busy: this.running.get(userId) === s.id,
        })),
    }));
  }

  /** Push the snapshot to the user's /app room (every table change). */
  async pushSessions(userId: string): Promise<void> {
    this.io.toUser(userId, 'assistant:sessions', await this.snapshotFor(userId));
  }

  /**
   * #55 — does this session hold a live channel (open in the web, running a
   * turn, or parked in the queue)? The REST delete refuses live rows: the
   * channel would keep writing into deleted storage.
   */
  isLive(sessionId: string): boolean {
    return this.live.has(sessionId);
  }

  // ---- open / close ----

  /**
   * `assistant:session.open`. With `sessionId`: join (or rejoin) that row's
   * live channel. Without: prepare a FRESH session — #54 lazy persistence:
   * the row is only written when the first message lands, so an open that
   * never sends leaves nothing behind a refresh. Joining always re-pushes
   * ready + history + config — a fresh page settles from the pushes alone.
   */
  async open(
    userId: string,
    assistantId: string,
    sessionId: string | undefined,
    socketId: string,
  ): Promise<AssistantOpenResult> {
    const config = await this.configOf(userId, assistantId);
    if (config === null) return { ok: false, code: 'ASSISTANT_NOT_FOUND' };
    if (config.deletedAt !== undefined) return { ok: false, code: 'ASSISTANT_DELETED' };

    let session: AssistantSession | null = null;
    if (sessionId !== undefined) {
      const row = await this.deps.uow.assistants.findSessionById(sessionId);
      if (row === null || row.ownerId !== userId) return { ok: false, code: 'SESSION_NOT_FOUND' };
      if (row.assistantId !== assistantId) return { ok: false, code: 'SESSION_NOT_FOUND' };
      session = row;
    } else {
      const now = new Date().toISOString();
      session = {
        id: generateId(),
        ownerId: userId,
        assistantId: config.id,
        title: '',
        createdAt: now,
        updatedAt: now,
        lastMessageAt: null,
      };
    }

    this.io.joinChannel(socketId, session.id);
    let ch = this.live.get(session.id);
    if (ch === undefined) {
      ch = {
        sessionId: session.id,
        ownerId: userId,
        assistantId: config.id,
        providerId: config.providerId,
        modelId: config.defaultModel,
        queuedPrompt: null,
        run: null,
        openedAt: Date.now(),
        ring: [],
        ...(sessionId === undefined ? { pending: session } : {}),
      };
      this.live.set(session.id, ch);
    }
    this.io.toChannel(session.id, 'assistant:session.ready', {
      sessionId: session.id,
      assistantId: ch.assistantId,
      assistantName: config.name,
    });
    const rows = await this.deps.uow.assistants.listMessages(session.id);
    this.io.toChannel(session.id, 'assistant:history', {
      sessionId: session.id,
      items: await rowsToHistoryItems(rows, this.historyResolver()),
    });
    // #66 — a rejoin mid-turn continues the timeline past history with the
    // ring (the in-flight generation), BEFORE the synthetic active status.
    this.replayRing(session.id);
    this.emit(session.id, await this.sessionConfigEvent(ch));
    if (this.running.get(userId) === session.id) {
      this.emit(session.id, { kind: 'session_status', state: 'active' });
    }
    if (ch.queuedPrompt !== null) {
      this.emit(session.id, {
        kind: 'queue_state',
        prompt: await this.wireView(ch.queuedPrompt),
        flushed: false,
      });
    }
    void this.pushSessions(userId);
    return { ok: true, sessionId: session.id, assistantName: config.name };
  }

  /** `assistant:session.close` — end the live channel; the row persists. */
  async close(userId: string, sessionId: string, reason: string): Promise<AssistantSendResult> {
    const ch = this.channelOf(userId, sessionId);
    if (ch === null) return { ok: false, code: 'SESSION_NOT_FOUND' };
    this.live.delete(sessionId);
    // Unanswered write gates die with the channel (denied, card settled).
    this.cancelApprovals(sessionId);
    // A running turn is NOT aborted: it finishes and persists; the user
    // re-opens to see it (cost already committed).
    this.io.toChannel(sessionId, 'assistant:session.closed', {
      sessionId,
      reason: reason.slice(0, 64) || 'user',
    });
    void this.pushSessions(userId);
    return { ok: true };
  }

  /**
   * #57 — a /app socket of the owner died. Mirrors the #66 chat-axis rule:
   * liveness is USER-scoped, the reap is GRACE-DELAYED (viewerGraceMs, 0 =
   * immediate), and any reconnect within the window cancels it. Without this,
   * an abruptly closed tab leaked the live flag forever — the session row
   * stayed busy in the rail and undeletable (409) until a server restart.
   */
  async onViewerGone(userId: string): Promise<void> {
    if ((await this.io.userSockets(userId)).length > 0) return;
    if (this.opts.viewerGraceMs <= 0) {
      await this.reapViewer(userId);
      return;
    }
    this.armViewerGrace(userId);
  }

  /** A /app socket of this user (re)connected — cancel any armed reap. */
  onViewerBack(userId: string): void {
    const timer = this.viewerGrace.get(userId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.viewerGrace.delete(userId);
  }

  /** #57 — arm the per-user reap timer (idempotent within a grace cycle). */
  private armViewerGrace(userId: string): void {
    if (this.viewerGrace.has(userId)) return;
    const timer = setTimeout(() => {
      this.viewerGrace.delete(userId);
      void this.reapViewer(userId);
    }, this.opts.viewerGraceMs);
    timer.unref();
    this.viewerGrace.set(userId, timer);
  }

  /** #57 — the grace-expired (or grace-disabled) viewer reap. */
  private async reapViewer(userId: string): Promise<void> {
    // Re-check: a socket may have reconnected without firing onViewerBack
    // (the connect handler raced this timer's tick).
    if ((await this.io.userSockets(userId)).length > 0) return;
    for (const ch of [...this.live.values()]) {
      if (ch.ownerId !== userId) continue;
      if (this.running.get(userId) === ch.sessionId) {
        // Never abort a running turn: it finishes and persists; the channel
        // closes at settle (see startTurn's finally).
        ch.closeWhenIdle = true;
        continue;
      }
      await this.close(userId, ch.sessionId, 'connection-lost');
    }
  }

  /** Server shutdown — abort what is running (persisted as aborted) and notify. */
  stop(): void {
    for (const timer of this.viewerGrace.values()) clearTimeout(timer);
    this.viewerGrace.clear();
    for (const [, pending] of [...this.pendingApprovals.entries()]) {
      clearTimeout(pending.timer);
      pending.resolve(false);
    }
    this.pendingApprovals.clear();
    for (const ch of [...this.live.values()]) {
      ch.run?.abort();
      this.io.toChannel(ch.sessionId, 'assistant:session.closed', {
        sessionId: ch.sessionId,
        reason: 'server-shutdown',
      });
    }
    this.live.clear();
    this.running.clear();
  }

  // ---- send / queue / cancel ----

  /**
   * #59 — the send-side image split: wire image blocks (base64) become blob
   * stores + persisted `imageRef` blocks. Text and resource_link pass
   * through; a legacy inline block (only possible from internal callers)
   * splits like a wire block. Returns the DOMAIN blocks the channel, the
   * queue, and the turn all carry from here on.
   */
  private async splitImageBlocks(
    prompt: readonly (PromptBlock | AssistantPromptBlock)[],
  ): Promise<AssistantPromptBlock[]> {
    const settings = await this.deps.uow.settings.get();
    const expiresAt = imageExpiryFrom(settings, new Date());
    const out: AssistantPromptBlock[] = [];
    for (const b of prompt) {
      if (b.type === 'image') {
        const row = await this.deps.uow.fileBlobs.put({
          data: Buffer.from(b.data, 'base64'),
          mimeType: b.mimeType,
          expiresAt,
        });
        out.push({ type: 'imageRef', ref: row.id, mimeType: b.mimeType });
      } else if (b.type === 'imageRef') {
        out.push(b);
      } else {
        out.push(b);
      }
    }
    return out;
  }

  /**
   * #59 — the wire view of persisted blocks for the events the WEB sees
   * (`user_message` echo, `queue_state`): imageRefs resolve back to inline
   * data URLs, transiently — never persisted. An expired/missing blob
   * degrades to the replay placeholder.
   */
  private async wireView(blocks: readonly AssistantPromptBlock[]): Promise<PromptBlock[]> {
    const now = new Date().toISOString();
    const out: PromptBlock[] = [];
    for (const b of blocks) {
      if (b.type !== 'imageRef') {
        out.push(b);
        continue;
      }
      const hit = await this.deps.uow.fileBlobs.get(b.ref);
      out.push(
        hit !== null && hit.row.expiresAt > now
          ? {
              type: 'image',
              data: Buffer.from(hit.data).toString('base64'),
              // Ingest came from a wire-validated block — the union holds.
              mimeType: hit.row.mimeType as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif',
            }
          : { type: 'text', text: '[image expired]' },
      );
    }
    return out;
  }

  /** #59 — the history replay's ref resolver (owner-authed socket push). */
  private historyResolver(): (ref: string) => Promise<{ data: string; mimeType: string } | null> {
    const now = new Date().toISOString();
    return async (ref) => {
      const hit = await this.deps.uow.fileBlobs.get(ref);
      return hit !== null && hit.row.expiresAt > now
        ? { data: Buffer.from(hit.data).toString('base64'), mimeType: hit.row.mimeType }
        : null;
    };
  }

  /** `assistant:message.send` — per-user busy gate + depth-1 queue. */
  async onMessageSend(
    userId: string,
    sessionId: string,
    content: string | PromptBlock[],
  ): Promise<AssistantSendResult> {
    const ch = this.channelOf(userId, sessionId);
    if (ch === null) return { ok: false, code: 'SESSION_NOT_FOUND' };
    const wire: PromptBlock[] =
      typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    if (wire.length === 0) return { ok: false, code: 'VALIDATION' };
    // #59 — bytes leave the prompt here: blobs are stored, the channel and
    // the queue carry refs only (the blobs' expiry is stamped at THIS moment).
    const prompt = await this.splitImageBlocks(wire);

    if (this.running.has(userId)) {
      if (ch.queuedPrompt !== null) return { ok: false, code: 'QUEUE_FULL' };
      ch.queuedPrompt = prompt;
      this.emit(sessionId, {
        kind: 'queue_state',
        prompt: await this.wireView(prompt),
        flushed: false,
      });
      return { ok: true, queued: true };
    }
    // The gate flips SYNCHRONOUSLY (a send racing the turn's first await
    // must park, not double-run) and the turn itself is fire-and-forget —
    // the ack returns immediately, never after a whole generation.
    this.running.set(userId, sessionId);
    void this.pushSessions(userId);
    void this.startTurn(ch, prompt);
    return { ok: true, queued: false };
  }

  /** `assistant:queue.cancel` — drop the parked entry (idempotent). */
  onQueueCancel(userId: string, sessionId: string): AssistantSendResult {
    const ch = this.channelOf(userId, sessionId);
    if (ch === null) return { ok: false, code: 'SESSION_NOT_FOUND' };
    if (ch.queuedPrompt !== null) {
      ch.queuedPrompt = null;
      this.emit(sessionId, { kind: 'queue_state', prompt: null, flushed: false });
    }
    return { ok: true };
  }

  /** `assistant:turn.cancel` — abort the running turn; the parked entry drops. */
  onTurnCancel(userId: string, sessionId: string): AssistantSendResult {
    const ch = this.channelOf(userId, sessionId);
    if (ch === null) return { ok: false, code: 'SESSION_NOT_FOUND' };
    if (ch.queuedPrompt !== null) {
      ch.queuedPrompt = null;
      this.emit(sessionId, { kind: 'queue_state', prompt: null, flushed: false });
    }
    this.cancelApprovals(sessionId);
    if (this.running.get(userId) === sessionId) ch.run?.abort();
    return { ok: true };
  }

  /**
   * `assistant:config.set` — switch the session's assistant config or model.
   * NEXT-TURN effect: the runner reads the channel state at turn start. An
   * `agent` switch persists a note row (the transcript records the rebind).
   */
  async onConfigSet(
    userId: string,
    sessionId: string,
    set: { configId: 'agent' | 'model'; value: string },
  ): Promise<AssistantSendResult> {
    const ch = this.channelOf(userId, sessionId);
    if (ch === null) return { ok: false, code: 'SESSION_NOT_FOUND' };

    if (set.configId === 'agent') {
      const config = await this.configOf(userId, set.value);
      if (config === null || config.deletedAt !== undefined) {
        return { ok: false, code: 'ASSISTANT_NOT_FOUND' };
      }
      if (config.id !== ch.assistantId) {
        ch.assistantId = config.id;
        // A rebind resets BOTH bindings to the new config's defaults — the
        // previous provider override belonged to the old config's session.
        ch.providerId = config.providerId;
        ch.modelId = config.defaultModel;
        await this.appendNote(sessionId, `rebound to assistant "${config.name}"`);
      }
    } else {
      // #58-4 — the value is the compound `providerId/modelId` (or a bare
      // legacy modelId, resolved against the channel's current provider).
      // #36: only providers visible to the owner are eligible — a personal
      // row of ANOTHER user answers 404-shaped, same as everywhere else.
      const slash = set.value.indexOf('/');
      const wantedProviderId = slash === -1 ? ch.providerId : set.value.slice(0, slash);
      const wantedModelId = slash === -1 ? set.value : set.value.slice(slash + 1);
      const provider = (await this.visibleProviders(userId)).find((p) => p.id === wantedProviderId);
      const model = provider?.models.find((m) => m.id === wantedModelId && m.type === 'chat');
      if (provider === undefined || model === undefined) {
        return { ok: false, code: 'ASSISTANT_MODEL_NOT_ON_PROVIDER' };
      }
      ch.providerId = provider.id;
      ch.modelId = model.id;
    }
    this.emit(sessionId, await this.sessionConfigEvent(ch));
    return { ok: true };
  }

  // ---- the turn ----

  private async startTurn(ch: LiveChannel, prompt: AssistantPromptBlock[]): Promise<void> {
    // #54 — an ephemeral open persists HERE (first real content): save the
    // pending row, then everything downstream sees a normal session.
    let session: AssistantSession | null = ch.pending ?? null;
    if (session === null) {
      session = await this.deps.uow.assistants.findSessionById(ch.sessionId);
    }
    if (ch.pending !== undefined) {
      await this.deps.uow.assistants.saveSession(ch.pending);
      ch.pending = undefined;
      void this.pushSessions(ch.ownerId);
    }
    const config = await this.configOf(ch.ownerId, ch.assistantId);
    if (session === null || config === null || config.deletedAt !== undefined) {
      this.emit(ch.sessionId, {
        kind: 'raw',
        method: 'hnx/prompt-error',
        params: { message: 'This assistant is no longer available.' },
      });
      this.emit(ch.sessionId, { kind: 'turn_result', stopReason: 'end_turn' });
      return;
    }

    const rowsBefore = await this.deps.uow.assistants.listMessages(ch.sessionId);
    // #68 — every transcript write allocates its seq UNDER the session's
    // chain (a mid-turn backflow note may have bumped the tail since
    // rowsBefore was read).
    await this.transact(ch.sessionId, async () => {
      const rowsNow = await this.deps.uow.assistants.listMessages(ch.sessionId);
      const seq = rowsNow.reduce((max, r) => Math.max(max, r.seq), 0) + 1;
      await this.deps.uow.assistants.appendMessage(ch.sessionId, {
        seq,
        type: 'user',
        blocks: prompt,
      });
    });
    // #11 — the echo is the single source of the user row for every viewer.
    // #59 — the echo carries the WIRE view (refs resolved inline, transient).
    this.emit(ch.sessionId, { kind: 'user_message', blocks: await this.wireView(prompt) });

    const turn = startAssistantTurn(
      this.mcp === undefined ? this.deps : { ...this.deps, mcp: this.mcp },
      {
        session,
        config,
        providerId: ch.providerId,
        modelId: ch.modelId,
        prompt,
        rows: rowsBefore,
        emit: (event) => this.emit(ch.sessionId, event),
        requestApproval: this.makeApprovalSeam(ch),
        append: async (row: AssistantMessageRow) => {
          // #68 — allocate from the LIVE tail (a mid-turn note may have
          // claimed this seq since the turn started).
          await this.transact(ch.sessionId, async () => {
            const rowsNow = await this.deps.uow.assistants.listMessages(ch.sessionId);
            const seq = rowsNow.reduce((max, r) => Math.max(max, r.seq), 0) + 1;
            await this.deps.uow.assistants.appendMessage(ch.sessionId, { ...row, seq });
          });
        },
        settle: async (summary) => {
          const now = new Date().toISOString();
          await this.deps.uow.assistants.saveSession({
            ...session,
            ...(summary.title !== undefined && session.title === ''
              ? { title: summary.title }
              : {}),
            updatedAt: now,
            lastMessageAt: summary.lastMessageAt,
          });
        },
      },
    );
    ch.run = turn;

    try {
      await turn.done;
    } catch (err) {
      if (!(err instanceof TurnSetupError)) throw err;
      // Setup failures (provider/credential/model drift) end the turn
      // honestly: an error row + system note, never a wedged busy gate.
      await this.transact(ch.sessionId, async () => {
        const rowsNow = await this.deps.uow.assistants.listMessages(ch.sessionId);
        const seq = rowsNow.reduce((max, r) => Math.max(max, r.seq), 0) + 1;
        await this.deps.uow.assistants.appendMessage(ch.sessionId, {
          seq,
          type: 'note',
          text: `error: ${err.message}`,
        });
      });
      this.emit(ch.sessionId, {
        kind: 'raw',
        method: 'hnx/prompt-error',
        params: { message: err.message },
      });
      this.emit(ch.sessionId, { kind: 'turn_result', stopReason: 'end_turn' });
      this.emit(ch.sessionId, { kind: 'session_status', state: 'idle' });
    } finally {
      // #66 — the turn settled and its rows are persisted: history now
      // covers everything the ring held. Clear it BEFORE flushQueue so a
      // next-turn flush starts with an empty ring of its own.
      ch.ring.length = 0;
      // The gate ALWAYS releases — a thrown turn must not wedge the user.
      if (this.running.get(ch.ownerId) === ch.sessionId) this.running.delete(ch.ownerId);
      ch.run = null;
      // #57 — the viewer grace expired mid-turn: the generation was allowed
      // to finish (closeWhenIdle), the channel ends now. Guarded against a
      // channel the user closed explicitly mid-turn (close() already ran);
      // the unconditional pushSessions below unpaints the rail either way.
      if (ch.closeWhenIdle === true && this.live.get(ch.sessionId) === ch) {
        await this.close(ch.ownerId, ch.sessionId, 'connection-lost');
      }
      void this.pushSessions(ch.ownerId);
      await this.flushQueue(ch.ownerId);
    }
  }

  /** Flush the user's OLDEST parked slot once the turn ended. */
  private async flushQueue(userId: string): Promise<void> {
    if (this.running.has(userId)) return;
    const parked = [...this.live.values()]
      .filter((ch) => ch.ownerId === userId && ch.queuedPrompt !== null)
      .sort((a, b) => a.openedAt - b.openedAt)[0];
    if (parked === undefined) return;
    const prompt = parked.queuedPrompt!;
    parked.queuedPrompt = null;
    this.running.set(userId, parked.sessionId);
    this.emit(parked.sessionId, { kind: 'queue_state', prompt: null, flushed: true });
    void this.pushSessions(userId);
    try {
      await this.startTurn(parked, prompt);
    } finally {
      if (this.running.get(userId) === parked.sessionId) this.running.delete(userId);
    }
  }

  private async appendNote(sessionId: string, text: string, modelVisible = false): Promise<void> {
    await this.transact(sessionId, async () => {
      const rows = await this.deps.uow.assistants.listMessages(sessionId);
      const seq = rows.reduce((max, r) => Math.max(max, r.seq), 0) + 1;
      await this.deps.uow.assistants.appendMessage(sessionId, {
        seq,
        type: 'note',
        text,
        ...(modelVisible ? { modelVisible: true as const } : {}),
      });
    });
  }

  /**
   * #68 — serialize per-session seq allocation. Mid-turn notes (dispatch
   * backflow) and the turn's settle-time row batch both allocate max(seq)+1;
   * unsynchronized they collide and one silently overwrites the other (the
   * memory driver keys by seq; sqlite's PK would throw). One chain per
   * session keeps every writer strictly ordered; the chain entry drops
   * itself once idle.
   */
  private seqChains = new Map<string, Promise<unknown>>();

  private transact<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.seqChains.get(sessionId) ?? Promise.resolve();
    const run = prev.then(fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.seqChains.set(sessionId, tail);
    void tail.then(() => {
      if (this.seqChains.get(sessionId) === tail) this.seqChains.delete(sessionId);
    });
    return run;
  }

  /**
   * #68 — a dispatch-backflow note (user operation on a driven channel, or a
   * dispatch completion): persisted as a modelVisible note row AND relayed
   * live to the session's room, so an open stream shows it the moment it
   * happens and the next model turn folds it into its context. Called by the
   * dispatch coordinator at any time — a closed page just misses the live
   * relay and finds the row in history.
   */
  async addDispatchNote(sessionId: string, text: string): Promise<void> {
    await this.appendNote(sessionId, text, true);
    this.emit(sessionId, { kind: 'raw', method: 'hnx/note', params: { message: text } });
  }

  /**
   * `assistant:session.sync` — re-push the open-time bundle (ready + history
   * + config) into the room. Idempotent (history ingestion rebuilds), and it
   * closes the open-ack/listener race for freshly mounted panes. #66: also
   * the reconnect-recovery verb, so the caller is owner-checked here (the
   * room receive path must never be joinable by another user).
   */
  async resync(userId: string, sessionId: string, socketId: string): Promise<boolean> {
    const ch = this.live.get(sessionId);
    if (ch === undefined || ch.ownerId !== userId) return false;
    this.io.joinChannel(socketId, sessionId);
    const config = await this.configOf(ch.ownerId, ch.assistantId);
    this.io.toChannel(sessionId, 'assistant:session.ready', {
      sessionId,
      assistantId: ch.assistantId,
      assistantName: config?.name ?? '',
    });
    const rows = await this.deps.uow.assistants.listMessages(sessionId);
    this.io.toChannel(sessionId, 'assistant:history', {
      sessionId,
      items: await rowsToHistoryItems(rows, this.historyResolver()),
    });
    // #66 — the in-flight turn's events continue the timeline past history.
    this.replayRing(sessionId);
    this.emit(sessionId, await this.sessionConfigEvent(ch));
    if (this.running.get(ch.ownerId) === sessionId) {
      this.emit(sessionId, { kind: 'session_status', state: 'active' });
    }
    return true;
  }

  /**
   * M3 — settle one pending approval: clears the watchdog, resolves the
   * runner's wait, and settles every viewer's card. `optionId` undefined =
   * cancelled (turn stopped / channel gone).
   */
  private settleApproval(
    requestId: string,
    outcome: 'selected' | 'cancelled' | 'timeout',
    optionId?: string,
  ): void {
    const pending = this.pendingApprovals.get(requestId);
    if (pending === undefined) return;
    this.pendingApprovals.delete(requestId);
    clearTimeout(pending.timer);
    pending.resolve(outcome === 'selected' && optionId === 'allow_once');
    this.emit(pending.sessionId, {
      kind: 'permission_resolved',
      requestId,
      outcome,
      ...(optionId !== undefined ? { optionId } : {}),
    });
  }

  /** Resolve everything a session waits on as cancelled (stop/close/shutdown). */
  private cancelApprovals(sessionId: string): void {
    for (const [requestId, pending] of [...this.pendingApprovals.entries()]) {
      if (pending.sessionId === sessionId) this.settleApproval(requestId, 'cancelled');
    }
  }

  /** `assistant:permission.respond` — the browser answered a write gate. */
  onPermissionRespond(
    userId: string,
    sessionId: string,
    requestId: string,
    optionId: string | undefined,
  ): AssistantSendResult {
    const ch = this.channelOf(userId, sessionId);
    if (ch === null) return { ok: false, code: 'SESSION_NOT_FOUND' };
    const pending = this.pendingApprovals.get(requestId);
    if (pending === undefined || pending.sessionId !== sessionId) {
      return { ok: false, code: 'PERMISSION_NOT_FOUND' };
    }
    this.settleApproval(requestId, optionId !== undefined ? 'selected' : 'cancelled', optionId);
    return { ok: true };
  }

  /**
   * The runner's approval seam: surface the ACP-shaped card, arm the
   * watchdog, and wait. Timeout and turn-cancel both deny (the write never
   * runs silently).
   */
  private makeApprovalSeam(ch: LiveChannel) {
    return (toolCall: { toolCallId: string; toolName: string; args: unknown }): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        const requestId = generateId();
        this.emit(ch.sessionId, {
          kind: 'permission_request',
          requestId,
          toolCall: {
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            status: 'pending',
            ...(isRecord(toolCall.args) ? { rawInput: toolCall.args } : {}),
          },
          options: [
            { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' as const },
            { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' as const },
          ],
        });
        const timer = setTimeout(() => {
          this.settleApproval(requestId, 'timeout');
        }, this.opts.permissionTimeoutMs);
        this.pendingApprovals.set(requestId, {
          sessionId: ch.sessionId,
          resolve,
          timer,
        });
      });
  }

  /** History for a session (used by tests / future re-sync paths). */
  async historyFor(sessionId: string): Promise<HistoryItem[]> {
    const rows = await this.deps.uow.assistants.listMessages(sessionId);
    return rowsToHistoryItems(rows, this.historyResolver());
  }
}
