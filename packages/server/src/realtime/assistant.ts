import type {
  AssistantConfig,
  AssistantMessageRow,
  AssistantPromptBlock,
  AssistantSession,
} from '@harness-nexus/core';
import type { ChatStreamEvent, HistoryItem, PromptBlock } from '@harness-nexus/shared';
import { generateId } from '../infra/crypto.js';
import { rowsToHistoryItems } from '../assistant/history.js';
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
}

interface LiveChannel {
  sessionId: string;
  ownerId: string;
  /** Current config (a rebind via config.set changes it; next-turn effect). */
  assistantId: string;
  /** Current model id on that config's provider. */
  modelId: string;
  /** #10 semantics — depth-1 send slot, parked while the user is busy. */
  queuedPrompt: PromptBlock[] | null;
  run: RunningTurn | null;
  openedAt: number;
  /**
   * #54 — LAZY persistence: the not-yet-saved row of a fresh open. Nothing
   * hits the DB until the first message (startTurn saves it), so an
   * open-then-abandon conversation leaves no trace behind a refresh.
   */
  pending?: AssistantSession | undefined;
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

  constructor(
    private readonly deps: AssistantRunnerDeps,
    private readonly io: AssistantIO,
    /** M2 — the registry seam, resolved LAZILY (mountMcpProxy decorates after registerRealtime). */
    private readonly mcp?: AssistantMcpDeps,
    private readonly opts: { permissionTimeoutMs: number } = { permissionTimeoutMs: 120_000 },
  ) {}

  // ---- helpers ----

  private emit(sessionId: string, event: ChatStreamEvent): void {
    this.io.toChannel(sessionId, 'assistant:event', { sessionId, event });
  }

  private channelOf(userId: string, sessionId: string): LiveChannel | null {
    const ch = this.live.get(sessionId);
    return ch !== undefined && ch.ownerId === userId ? ch : null;
  }

  private async configOf(userId: string, assistantId: string): Promise<AssistantConfig | null> {
    const config = await this.deps.uow.assistants.findById(assistantId);
    return config !== null && config.ownerId === userId ? config : null;
  }

  /** The composer's selectors: agent + model options (W9 opaque-value surface). */
  private async sessionConfigEvent(ch: LiveChannel): Promise<ChatStreamEvent> {
    const [configs, provider] = await Promise.all([
      this.deps.uow.assistants.listByOwner(ch.ownerId),
      this.deps.uow.llmProviders.findById(
        (await this.configOf(ch.ownerId, ch.assistantId))?.providerId ?? '',
      ),
    ]);
    const models = (provider?.models ?? []).filter((m) => m.type === 'chat');
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
          currentValue: ch.modelId,
          options: models.map((m) => ({
            value: m.id,
            name: m.displayName ?? m.id,
          })),
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
        modelId: config.defaultModel,
        queuedPrompt: null,
        run: null,
        openedAt: Date.now(),
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
      items: rowsToHistoryItems(rows),
    });
    this.emit(session.id, await this.sessionConfigEvent(ch));
    if (this.running.get(userId) === session.id) {
      this.emit(session.id, { kind: 'session_status', state: 'active' });
    }
    if (ch.queuedPrompt !== null) {
      this.emit(session.id, { kind: 'queue_state', prompt: ch.queuedPrompt, flushed: false });
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

  /** Server shutdown — abort what is running (persisted as aborted) and notify. */
  stop(): void {
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

  /** `assistant:message.send` — per-user busy gate + depth-1 queue. */
  async onMessageSend(
    userId: string,
    sessionId: string,
    content: string | PromptBlock[],
  ): Promise<AssistantSendResult> {
    const ch = this.channelOf(userId, sessionId);
    if (ch === null) return { ok: false, code: 'SESSION_NOT_FOUND' };
    const prompt: PromptBlock[] =
      typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    if (prompt.length === 0) return { ok: false, code: 'VALIDATION' };

    if (this.running.has(userId)) {
      if (ch.queuedPrompt !== null) return { ok: false, code: 'QUEUE_FULL' };
      ch.queuedPrompt = prompt;
      this.emit(sessionId, { kind: 'queue_state', prompt, flushed: false });
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
        ch.modelId = config.defaultModel;
        await this.appendNote(sessionId, `rebound to assistant "${config.name}"`);
      }
    } else {
      const config = await this.configOf(userId, ch.assistantId);
      const provider =
        config === null ? null : await this.deps.uow.llmProviders.findById(config.providerId);
      const model = provider?.models.find((m) => m.id === set.value && m.type === 'chat');
      if (model === undefined) return { ok: false, code: 'ASSISTANT_MODEL_NOT_ON_PROVIDER' };
      ch.modelId = set.value;
    }
    this.emit(sessionId, await this.sessionConfigEvent(ch));
    return { ok: true };
  }

  // ---- the turn ----

  private async startTurn(ch: LiveChannel, prompt: PromptBlock[]): Promise<void> {
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
    let seq = rowsBefore.reduce((max, r) => Math.max(max, r.seq), 0) + 1;
    await this.deps.uow.assistants.appendMessage(ch.sessionId, {
      seq,
      type: 'user',
      blocks: prompt as AssistantPromptBlock[],
    });
    // #11 — the echo is the single source of the user row for every viewer.
    this.emit(ch.sessionId, { kind: 'user_message', blocks: prompt });

    const turn = startAssistantTurn(
      this.mcp === undefined ? this.deps : { ...this.deps, mcp: this.mcp },
      {
        session,
        config,
        modelId: ch.modelId,
        prompt,
        rows: rowsBefore,
        emit: (event) => this.emit(ch.sessionId, event),
        requestApproval: this.makeApprovalSeam(ch),
        append: async (row: AssistantMessageRow) => {
          seq += 1;
          await this.deps.uow.assistants.appendMessage(ch.sessionId, { ...row, seq });
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
      seq += 1;
      await this.deps.uow.assistants.appendMessage(ch.sessionId, {
        seq,
        type: 'note',
        text: `error: ${err.message}`,
      });
      this.emit(ch.sessionId, {
        kind: 'raw',
        method: 'hnx/prompt-error',
        params: { message: err.message },
      });
      this.emit(ch.sessionId, { kind: 'turn_result', stopReason: 'end_turn' });
      this.emit(ch.sessionId, { kind: 'session_status', state: 'idle' });
    } finally {
      // The gate ALWAYS releases — a thrown turn must not wedge the user.
      if (this.running.get(ch.ownerId) === ch.sessionId) this.running.delete(ch.ownerId);
      ch.run = null;
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

  private async appendNote(sessionId: string, text: string): Promise<void> {
    const rows = await this.deps.uow.assistants.listMessages(sessionId);
    const seq = rows.reduce((max, r) => Math.max(max, r.seq), 0) + 1;
    await this.deps.uow.assistants.appendMessage(sessionId, { seq, type: 'note', text });
  }

  /**
   * `assistant:session.sync` — re-push the open-time bundle (ready + history
   * + config) into the room. Idempotent (history ingestion rebuilds), and it
   * closes the open-ack/listener race for freshly mounted panes.
   */
  async resync(sessionId: string, socketId: string): Promise<boolean> {
    const ch = this.live.get(sessionId);
    if (ch === undefined) return false;
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
      items: rowsToHistoryItems(rows),
    });
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
    return rowsToHistoryItems(rows);
  }
}
