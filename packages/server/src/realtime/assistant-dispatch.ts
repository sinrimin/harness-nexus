// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { ChatResumeArm, ChatService, ChatTapEvent } from './chat.js';

/**
 * #67 — the assistant's client-agent dispatch coordinator. The assistant
 * tool layer (`agent_dispatch` / `agent_dispatch_poll`) rides this; it wraps
 * ChatService with an in-process consumer instead of a browser socket:
 *
 *   dispatch → chat.open(opener: null) → tap 'ready' → chat.onMessageSend
 *   tap events → accumulate the turn's text / stopReason / usage / pending
 *   permission cards → on turn end CLOSE the channel (reason 'dispatch') and
 *   keep a bounded terminal record for polls.
 *
 * Everything the driven channel does stays an ordinary channel: owner gates,
 * machine budgets, eviction, presence rules, the #66 control-verb gate, and
 * visibility in the owner's tab bar (a human can watch — and answer the
 * driven agent's permission cards there; the watchdog backstops). The
 * driven agent's SESSION is its own (W7): the dispatch result carries
 * `nativeSessionId` + `cwd`, and a follow-up dispatch passes them back as
 * the resume arm — that continuation, not a server-side record, is the
 * cross-turn state (the assistant transcript already persists the handle).
 *
 * #68 — the driven channel being an ordinary channel cuts both ways: the
 * user can also OPERATE it from the tab bar (stop, interject, switch config,
 * answer cards, close). Those operations flow back through
 * {@link AssistantDispatchService.noteUserOp} (called by the /app route
 * handlers on every successful verb) as model-visible notes in the owning
 * assistant session + `notices` on the next poll — so the model learns the
 * USER's intent (a user stop is not an adapter failure to retry) and the
 * user's interjection keeps the channel alive past its turn. The future
 * sync sugar (`wait: true`) will bundle the same notices into its return.
 */

/** The dispatch handle returned to the model (and kept in its transcript). */
export interface AssistantDispatchOpen {
  ok: true;
  channelId: string;
  cwd: string;
}

export interface AssistantDispatchPollResult {
  ok: true;
  status: 'starting' | 'running' | 'done' | 'failed' | 'closed';
  channelId: string;
  /** The turn is generating on the machine right now. */
  busy: boolean;
  /** An unanswered driven-agent permission card — answerable in the web tab. */
  pendingPermission: boolean;
  /**
   * #68 — user operations on the driven channel since the last poll drained
   * them (stops, interjections, config switches the USER made). Carries the
   * user's intent; also persisted as transcript notes for later turns.
   */
  notices?: string[];
  /** Continuation handle — present once the agent reported its own session. */
  nativeSessionId?: string;
  cwd: string;
  /** `done`/`closed`: the accumulated assistant text of the turn. */
  text?: string;
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  /** `failed`/`closed`: why. */
  error?: string;
  reason?: string;
}

/** One live-dispatch entry of an assistant session, pushed to the owner's /app sockets. */
export interface AssistantDispatchView {
  channelId: string;
  agentInstanceId: string;
  status: AssistantDispatchPollResult['status'];
  busy: boolean;
}

/** #68 — the assistant-session side of the backflow (wired by the realtime plugin). */
export interface AssistantDispatchSink {
  /** Persist + relay a model-visible platform note in the assistant session. */
  note: (sessionId: string, text: string) => Promise<void> | void;
  /** Push the session's dispatch snapshot to the owner's /app sockets. */
  dispatches: (userId: string, assistantSessionId: string, views: AssistantDispatchView[]) => void;
}

/** A user verb on a driven channel that the assistant session must hear about. */
export type AssistantDispatchUserOp =
  | 'turn.cancel'
  | 'message.send'
  | 'queue.cancel'
  | 'config.set'
  | 'permission.respond'
  | 'elicitation.respond'
  | 'session.close'
  | 'channels.closeAll';

interface DispatchRecord {
  channelId: string;
  ownerId: string;
  /** '' when the dispatch did not come from an assistant turn (tests). */
  assistantSessionId: string;
  agentInstanceId: string;
  cwd: string;
  prompt: string;
  status: AssistantDispatchPollResult['status'];
  busy: boolean;
  openPermissions: Set<string>;
  nativeSessionId: string | null;
  text: string;
  stopReason: string | undefined;
  usage: { inputTokens?: number; outputTokens?: number } | undefined;
  error: string | undefined;
  reason: string | undefined;
  /** #68 — undrained user-op/completion notices for the next poll. */
  notices: string[];
  /** Resolved on every state change (poll waiters re-check). */
  waiters: Set<() => void>;
}

const MAX_RECORDS = 64;
const INTERJECT_MAX = 300;

function clip(s: string): string {
  return s.length > INTERJECT_MAX ? `${s.slice(0, INTERJECT_MAX)}…` : s;
}

function userOpText(
  channelId: string,
  op: AssistantDispatchUserOp,
  detail: { text?: string; optionId?: string; action?: string; config?: unknown },
): string {
  switch (op) {
    case 'turn.cancel':
      return `dispatch ${channelId}: the user stopped the driven agent turn manually — that was the user's intent, not a failure; do not retry or re-dispatch it`;
    case 'message.send':
      return `dispatch ${channelId}: the user sent a message into the driven session${detail.text !== undefined ? `: "${clip(detail.text)}"` : ''}`;
    case 'queue.cancel':
      return `dispatch ${channelId}: the user dropped their queued message`;
    case 'config.set':
      return `dispatch ${channelId}: the user changed the driven session's config${detail.config !== undefined ? ` (${JSON.stringify(detail.config)})` : ''}`;
    case 'permission.respond':
      return `dispatch ${channelId}: the user answered the driven agent's permission card${detail.optionId !== undefined ? ` (option: ${detail.optionId})` : ''}`;
    case 'elicitation.respond':
      return `dispatch ${channelId}: the user answered the driven agent's elicitation${detail.action !== undefined ? ` (action: ${detail.action})` : ''}`;
    case 'session.close':
    case 'channels.closeAll':
      return `dispatch ${channelId}: the user closed the driven channel`;
  }
}

export class AssistantDispatchService {
  private records = new Map<string, DispatchRecord>();
  private sink: AssistantDispatchSink | undefined;

  constructor(private readonly chat: ChatService) {}

  /** #68 — late-bound: the assistant realtime service is constructed after this. */
  attach(sink: AssistantDispatchSink): void {
    this.sink = sink;
  }

  /**
   * Open a channel on the owner's agent and send the prompt when the agent
   * is ready. Returns the handle immediately — the async arm; poll for the
   * outcome. `resume` continues the agent's OWN native session (the handle
   * a previous dispatch returned).
   */
  async dispatch(
    ownerId: string,
    input: {
      agentInstanceId: string;
      prompt: string;
      /** #68 — the assistant session whose turn dispatched (notes + pushes route there). */
      assistantSessionId?: string | undefined;
      directory?: string | undefined;
      resume?: ChatResumeArm | undefined;
    },
  ): Promise<AssistantDispatchOpen | { ok: false; code: string }> {
    const opened = await this.chat.open(
      ownerId,
      input.agentInstanceId,
      undefined,
      null,
      input.directory,
      input.resume,
      // #70 — the dispatch tool promises a NEW session directory; a fresh
      // project path must not die on "does not exist" (the server already
      // containment-checked it inside baseWorkspace).
      true,
    );
    if (!opened.ok) return { ok: false, code: opened.code };
    const channelId = opened.sessionId;
    const record: DispatchRecord = {
      channelId,
      ownerId,
      assistantSessionId: input.assistantSessionId ?? '',
      agentInstanceId: input.agentInstanceId,
      cwd: opened.cwd,
      prompt: input.prompt,
      status: 'starting',
      busy: false,
      openPermissions: new Set(),
      nativeSessionId: null,
      text: '',
      stopReason: undefined,
      usage: undefined,
      error: undefined,
      reason: undefined,
      notices: [],
      waiters: new Set(),
    };
    this.remember(record);
    this.chat.tap(channelId, (e) => this.onTap(record, e));
    this.pushFor(ownerId, record.assistantSessionId);
    return { ok: true, channelId, cwd: opened.cwd };
  }

  /**
   * The dispatch's outcome — terminal states stay answerable (the record
   * lingers), non-terminal ones block up to `waitMs` for a TERMINAL
   * transition (running→running changes do not wake the wait: a poll that
   * asked to wait wants the outcome, not an intermediate blip).
   */
  async poll(
    ownerId: string,
    channelId: string,
    waitMs = 0,
  ): Promise<AssistantDispatchPollResult | { ok: false; code: 'DISPATCH_NOT_FOUND' }> {
    const record = this.records.get(channelId);
    if (record === undefined || record.ownerId !== ownerId) {
      return { ok: false, code: 'DISPATCH_NOT_FOUND' };
    }
    if (!this.isTerminal(record) && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          record.waiters.delete(resolve);
          resolve();
        }, waitMs);
        timer.unref?.();
        record.waiters.add(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    const view = this.view(record);
    // #68 — notices drain on read: each user-op/completion notice reaches the
    // model exactly once through the poll (the transcript note persists it).
    const notices = record.notices.splice(0);
    if (notices.length > 0) view.notices = notices;
    return view;
  }

  /**
   * #68 — a /app verb SUCCEEDED on this channel (the route handlers call it
   * after every ok ack). Ordinary channels (no record) are a cheap no-op;
   * driven channels get the operation noted in the owning assistant session
   * and queued as a poll notice.
   */
  noteUserOp(
    userId: string,
    channelId: string,
    op: AssistantDispatchUserOp,
    detail: { text?: string; optionId?: string; action?: string; config?: unknown } = {},
  ): void {
    const record = this.records.get(channelId);
    if (record === undefined || record.ownerId !== userId) return;
    const text = userOpText(channelId, op, detail);
    record.notices.push(text);
    this.note(record, text);
  }

  /** #68 — `chat:channels.closeAll`: every live dispatch of the user closes. */
  noteCloseAll(userId: string): void {
    for (const record of this.records.values()) {
      if (record.ownerId === userId && !this.isTerminal(record)) {
        this.noteUserOp(userId, record.channelId, 'channels.closeAll');
      }
    }
  }

  /** #68 — (re)push one assistant session's dispatch snapshot to the owner. */
  pushFor(userId: string, assistantSessionId: string): void {
    if (this.sink === undefined || assistantSessionId === '') return;
    const views: AssistantDispatchView[] = [];
    for (const record of this.records.values()) {
      if (record.ownerId !== userId || record.assistantSessionId !== assistantSessionId) continue;
      views.push({
        channelId: record.channelId,
        agentInstanceId: record.agentInstanceId,
        status: record.status,
        busy: record.busy,
      });
    }
    this.sink.dispatches(userId, assistantSessionId, views);
  }

  /**
   * #69 — the turn-start brief: this assistant session's still-live
   * dispatches, as prompt text. The model's transcript holds the handles;
   * without this it cannot know they are STILL RUNNING — or that the user
   * drove them further since. '' when nothing is live (no noise).
   */
  briefFor(assistantSessionId: string): string {
    const lines: string[] = [];
    for (const record of this.records.values()) {
      if (record.assistantSessionId !== assistantSessionId || this.isTerminal(record)) continue;
      lines.push(
        `- ${record.channelId} on agent ${record.agentInstanceId}: ${record.status}` +
          `${record.busy ? ', mid-turn' : ''}` +
          `${record.openPermissions.size > 0 ? ', a permission card awaits the user' : ''}`,
      );
    }
    if (lines.length === 0) return '';
    return `Live dispatched client-agent sessions (handles from your earlier turns; state at this turn's start — poll before acting on them):\n${lines.join('\n')}`;
  }

  // ---- internals ----

  private note(record: DispatchRecord, text: string): void {
    if (record.assistantSessionId === '') return;
    void this.sink?.note(record.assistantSessionId, text);
  }

  private isTerminal(record: DispatchRecord): boolean {
    return record.status === 'done' || record.status === 'failed' || record.status === 'closed';
  }

  private view(record: DispatchRecord): AssistantDispatchPollResult {
    return {
      ok: true,
      status: record.status,
      channelId: record.channelId,
      busy: record.busy,
      pendingPermission: record.openPermissions.size > 0,
      ...(record.nativeSessionId !== null ? { nativeSessionId: record.nativeSessionId } : {}),
      cwd: record.cwd,
      ...(record.text !== '' ? { text: record.text } : {}),
      ...(record.stopReason !== undefined ? { stopReason: record.stopReason } : {}),
      ...(record.usage !== undefined ? { usage: record.usage } : {}),
      ...(record.error !== undefined ? { error: record.error } : {}),
      ...(record.reason !== undefined ? { reason: record.reason } : {}),
    };
  }

  private remember(record: DispatchRecord): void {
    this.records.set(record.channelId, record);
    // Bounded FIFO — evicted records are terminal or in-flight-but-old; the
    // continuation handle lives in the assistant transcript either way.
    while (this.records.size > MAX_RECORDS) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
  }

  /** Poll waiters wake on TERMINAL transitions only (see poll). */
  private wake(record: DispatchRecord): void {
    for (const w of [...record.waiters.values()]) w();
    record.waiters.clear();
  }

  /**
   * The turn's settle gate (#68): a user interjection parked on the send
   * queue runs as the NEXT turn on the same channel — settling (and the
   * auto-close that follows) would drop it. Stay running; the next
   * turn_result/idle re-runs this gate with an empty queue.
   */
  private settle(record: DispatchRecord, status: 'done' | 'closed' | 'failed'): void {
    if (status === 'done' && this.chat.hasQueuedPrompt(record.channelId)) {
      // turn_result AND the following idle both route here while the queue is
      // parked — separate the turns' text once, not per re-check.
      if (record.text !== '' && !record.text.endsWith('\n')) record.text += '\n';
      return;
    }
    this.finalize(record, status);
  }

  private finalize(
    record: DispatchRecord,
    status: 'done' | 'failed' | 'closed',
    extra: { error?: string; reason?: string } = {},
  ): void {
    if (this.isTerminal(record)) return;
    // A poll blocked in waitMs is about to consume the outcome — it does not
    // need a completion note (captured BEFORE wake clears the waiters).
    const hadWaiter = record.waiters.size > 0;
    record.status = status;
    // turn_result lands before idle on some adapters — a terminal record is
    // not busy regardless of whether the idle event ever arrived.
    record.busy = false;
    record.error = extra.error;
    record.reason = extra.reason;
    this.wake(record);
    this.pushFor(record.ownerId, record.assistantSessionId);
    // `done` still needs the channel GONE (budget back): our own close lands
    // as a 'dispatch' tap that finalize ignores (already terminal).
    if (status === 'done') {
      void this.chat.close(record.ownerId, record.channelId, 'dispatch');
    }
    // #68 — nobody was waiting when the outcome landed, so no poll returned
    // it inside a turn: record the completion where the NEXT turn (or the
    // user, watching the stream) will find it. Never starts a turn itself.
    if (!hadWaiter && (status === 'done' || status === 'failed')) {
      const summary =
        status === 'done'
          ? `dispatch ${record.channelId}: the driven turn finished (stopReason: ${record.stopReason ?? 'end_turn'}) — agent_dispatch_poll has the full result`
          : `dispatch ${record.channelId}: the driven turn FAILED${record.error !== undefined ? ` (${record.error})` : ''}`;
      record.notices.push(summary);
      this.note(record, summary);
    }
  }

  private onTap(record: DispatchRecord, e: ChatTapEvent): void {
    switch (e.kind) {
      case 'ready': {
        if (e.nativeSessionId !== undefined) record.nativeSessionId = e.nativeSessionId;
        // The agent is up — the prompt goes out through the SAME door a
        // browser send uses (#66 presence gate, active budget, queue).
        const sent = this.chat.onMessageSend(record.ownerId, record.channelId, record.prompt);
        if (!sent.ok) {
          this.finalize(record, 'failed', { error: `prompt rejected: ${sent.code}` });
        }
        return;
      }
      case 'event': {
        const event = e.event;
        switch (event.kind) {
          case 'message_delta':
            record.text += event.delta;
            record.busy = true;
            // A queued user interjection opened the next turn — the previous
            // turn's stopReason is stale until the new one lands.
            record.stopReason = undefined;
            return;
          case 'session_status':
            if (event.state === 'active') {
              record.status = record.status === 'starting' ? 'running' : record.status;
              record.busy = true;
            } else {
              record.busy = false;
              // Turn end: settle once the stop reason landed (turn_result
              // precedes idle on every adapter; a turn_result-less idle is
              // not a completed dispatch — wait for the real one).
              if (record.stopReason !== undefined) this.settle(record, 'done');
            }
            return;
          case 'turn_result':
            record.stopReason = event.stopReason;
            // Idle may never arrive (adapter dialect); settle on the result
            // itself so the channel does not linger on the budget.
            this.settle(record, 'done');
            return;
          case 'usage':
            record.usage = {
              ...(event.inputTokens !== undefined ? { inputTokens: event.inputTokens } : {}),
              ...(event.outputTokens !== undefined ? { outputTokens: event.outputTokens } : {}),
            };
            return;
          case 'permission_request':
            record.openPermissions.add(event.requestId);
            return;
          case 'permission_resolved':
            record.openPermissions.delete(event.requestId);
            return;
          default:
            return;
        }
      }
      case 'closed':
        this.finalize(record, 'closed', {
          reason: e.reason,
          ...(e.error !== undefined ? { error: e.error } : {}),
        });
        return;
    }
  }
}
