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

interface DispatchRecord {
  channelId: string;
  ownerId: string;
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
  /** Resolved on every state change (poll waiters re-check). */
  waiters: Set<() => void>;
}

const MAX_RECORDS = 64;

export class AssistantDispatchService {
  private records = new Map<string, DispatchRecord>();

  constructor(private readonly chat: ChatService) {}

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
    );
    if (!opened.ok) return { ok: false, code: opened.code };
    const channelId = opened.sessionId;
    const record: DispatchRecord = {
      channelId,
      ownerId,
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
      waiters: new Set(),
    };
    this.remember(record);
    this.chat.tap(channelId, (e) => this.onTap(record, e));
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
    return this.view(record);
  }

  // ---- internals ----

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

  private finalize(
    record: DispatchRecord,
    status: 'done' | 'failed' | 'closed',
    extra: { error?: string; reason?: string } = {},
  ): void {
    if (this.isTerminal(record)) return;
    record.status = status;
    // turn_result lands before idle on some adapters — a terminal record is
    // not busy regardless of whether the idle event ever arrived.
    record.busy = false;
    record.error = extra.error;
    record.reason = extra.reason;
    this.wake(record);
    // `done` still needs the channel GONE (budget back): our own close lands
    // as a 'dispatch' tap that finalize ignores (already terminal).
    if (status === 'done') {
      void this.chat.close(record.ownerId, record.channelId, 'dispatch');
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
              if (record.stopReason !== undefined) this.finalize(record, 'done');
            }
            return;
          case 'turn_result':
            record.stopReason = event.stopReason;
            // Idle may never arrive (adapter dialect); settle on the result
            // itself so the channel does not linger on the budget.
            this.finalize(record, 'done');
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
