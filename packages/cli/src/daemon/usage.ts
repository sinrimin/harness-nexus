/**
 * #39/#44 — token and cost accounting for the TUI (and anyone in-process).
 *
 * Three halves:
 *
 *   normalizeUsage — one place that knows every upstream's spelling of a
 *     token count. The targets speak several dialects of cache field
 *     (Anthropic camelCase, deepseek snake_case prompt cache, the ACP
 *     end-turn strawman's cachedRead/cachedWrite); the mapping layers
 *     (`mapAcpUpdate`, the dsh mapper, the pi connection) all funnel raw
 *     usage objects through here so the semantic event carries ONE shape.
 *     deepseek's `prompt_cache_miss_tokens` deliberately does NOT map to
 *     cacheWrite — "uncached input" is not "cache write".
 *
 *   responseUsageMode — whether a target's `session/prompt` RESPONSE carries
 *     usage, and in which dialect (#44): the claude wrapper returns
 *     session-CUMULATIVE totals (read straight off its accumulatedUsage);
 *     opencode returns PER-TURN values. Targets not in the map are ignored —
 *     counting an unknown dialect (or one that also reports through usage
 *     events) would double-count, so we wait for rig verification instead.
 *
 *   UsageLedger — per-(target, model) and per-session totals. Usage EVENTS
 *     (dsh/pi) carry per-turn counts and are summed. Response usage is
 *     applied per dialect (cumulative → delta vs the session's last
 *     cumulative snapshot, a reset re-credits the full value; per-turn →
 *     summed). `usage_update.cost.amount` is session-CUMULATIVE by spec, so
 *     it is also delta-accounted. Daemon-lifetime only — nothing persists
 *     across restarts.
 */

/** Dialect spellings for each normalized field, most-explicit first. */
const INPUT_KEYS = ['inputTokens', 'input'] as const;
const OUTPUT_KEYS = ['outputTokens', 'output'] as const;
const READ_KEYS = [
  'cacheReadTokens',
  'cachedReadTokens', // ACP end-turn strawman + the claude wrapper's response
  'cacheReadInputTokens',
  'cache_read_input_tokens',
  'cachedInputTokens',
  'prompt_cache_hit_tokens',
] as const;
const WRITE_KEYS = [
  'cacheWriteTokens',
  'cachedWriteTokens', // ACP end-turn strawman + the claude wrapper's response
  'cacheCreationInputTokens',
  'cache_creation_input_tokens',
  'cacheWriteInputTokens',
] as const;

export interface UsageFields {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
}

function pick(raw: unknown, keys: readonly string[]): number | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  for (const key of keys) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  }
  return undefined;
}

/** Normalize any dialect's raw usage object into the semantic shape. */
export function normalizeUsage(raw: unknown): UsageFields {
  const inputTokens = pick(raw, INPUT_KEYS);
  const outputTokens = pick(raw, OUTPUT_KEYS);
  const cacheReadTokens = pick(raw, READ_KEYS);
  const cacheWriteTokens = pick(raw, WRITE_KEYS);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
  };
}

/** Occupancy-only updates (dsh's wire `usage_update`) carry no counts to add. */
export function hasTokenCounts(f: UsageFields): boolean {
  return (
    f.inputTokens !== undefined ||
    f.outputTokens !== undefined ||
    f.cacheReadTokens !== undefined ||
    f.cacheWriteTokens !== undefined
  );
}

/**
 * #44 — does this target's `session/prompt` response carry usage, and is it
 * session-cumulative or per-turn? Null = unknown/unreported → NOT counted.
 */
const RESPONSE_USAGE_MODES: Record<string, 'cumulative' | 'perTurn'> = {
  'claude-code': 'cumulative', // wrapper's sessionUsage() off accumulatedUsage
  opencode: 'perTurn', // verified against 1.15.11+ (issue #30118 example)
};

export function responseUsageMode(target: string): 'cumulative' | 'perTurn' | null {
  return RESPONSE_USAGE_MODES[target] ?? null;
}

export interface UsageRow {
  target: string;
  model: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Daemon-run spend accumulated from usage_update cost deltas (USD). */
  costUsd: number;
  /** Distinct sessions that ever reported under this (target, model). */
  sessions: number;
  lastAt: string;
}

export interface SessionUsage {
  target: string;
  model: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  lastAt: string;
}

interface Acc {
  target: string;
  model: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  sessions: Set<string>;
  lastAt: string;
}

/** Per-session counters the delta dialects need between reports. */
interface SessionBaseline {
  /** usage_update `cost.amount` — cumulative by spec. */
  lastCostUsd?: number;
  /** claude-style cumulative response-usage snapshot. */
  lastCumulative?: UsageFields;
}

type TokenField =
  'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'costUsd';
const TOKEN_FIELDS = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
] as const;

/**
 * Credit rule for CUMULATIVE counters: first sighting = full value, later
 * sightings = the increment, a backwards step = reset (credit full again).
 */
function cumulativeDelta(last: number | undefined, now: number): number {
  if (last === undefined || now < last) return now;
  return now - last;
}

export class UsageLedger {
  #rows = new Map<string, Acc>();
  #sessions = new Map<string, Acc & { baseline: SessionBaseline }>();

  #rowFor(
    sessionId: string,
    target: string,
    model: string,
    at: string,
  ): { row: Acc; sess: Acc & { baseline: SessionBaseline } } {
    const key = `${target}\u0000${model}`;
    let row = this.#rows.get(key);
    if (row === undefined) {
      row = {
        target,
        model,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        sessions: new Set<string>(),
        lastAt: at,
      };
      this.#rows.set(key, row);
    }
    let sess = this.#sessions.get(sessionId);
    if (sess === undefined) {
      // Fresh ZEROED accumulator — never spread the row here: a new session
      // joining an existing (target, model) row must not inherit another
      // session's totals.
      sess = {
        target,
        model,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        sessions: new Set<string>(),
        lastAt: at,
        baseline: {},
      };
      this.#sessions.set(sessionId, sess);
    } else if (sess.model !== model) {
      // A mid-session model switch re-labels the session view (the rows keep
      // their per-model history; the session total spans models). Deltas
      // restart: the new model's counters describe its own context.
      sess.model = model;
      sess.baseline = {};
    }
    return { row, sess };
  }

  #credit(row: Acc, sess: Acc, field: TokenField, add: number): void {
    if (add <= 0) return;
    row[field] += add;
    sess[field] += add;
  }

  #bump(row: Acc, sess: Acc, sessionId: string, at: string): void {
    row.sessions.add(sessionId);
    row.lastAt = at;
    sess.lastAt = at;
  }

  /**
   * Feed one `usage` event. Token fields (per-turn dialects: dsh/pi) are
   * summed; `costUsd` (cumulative by the ACP session-usage RFD) is
   * delta-accounted. TURNS ARE NOT COUNTED HERE — turn_result is the only
   * universal per-turn signal (#44), and counting here too would double-count
   * every dsh/pi/claude turn. Count-less, cost-less events are ignored.
   */
  record(
    sessionId: string,
    target: string,
    model: string,
    ev: UsageFields & { costUsd?: number | undefined },
    at: string,
  ): void {
    if (!hasTokenCounts(ev) && ev.costUsd === undefined) return;
    const { row, sess } = this.#rowFor(sessionId, target, model, at);
    for (const field of TOKEN_FIELDS) {
      const now = ev[field];
      if (now === undefined || now <= 0) continue;
      this.#credit(row, sess, field, now);
    }
    if (ev.costUsd !== undefined && ev.costUsd >= 0) {
      this.#credit(row, sess, 'costUsd', cumulativeDelta(sess.baseline.lastCostUsd, ev.costUsd));
      sess.baseline.lastCostUsd = ev.costUsd;
    }
    this.#bump(row, sess, sessionId, at);
  }

  /**
   * Feed one turn completion (#44). Turns count for EVERY target — the
   * turn_result signal is universal. Response usage is applied only for
   * targets with a known dialect: cumulative deltas vs the session snapshot,
   * per-turn values summed straight in. `usage` may be null (unknown target
   * or a response that carried none).
   */
  recordTurn(
    sessionId: string,
    target: string,
    model: string,
    usage: UsageFields | null,
    at: string,
  ): void {
    const mode = responseUsageMode(target);
    const { row, sess } = this.#rowFor(sessionId, target, model, at);
    if (usage !== null && mode !== null && hasTokenCounts(usage)) {
      if (mode === 'cumulative') {
        for (const field of TOKEN_FIELDS) {
          const now = usage[field];
          if (now === undefined) continue;
          this.#credit(
            row,
            sess,
            field,
            cumulativeDelta(sess.baseline.lastCumulative?.[field], now),
          );
        }
        sess.baseline.lastCumulative = usage;
      } else {
        for (const field of TOKEN_FIELDS) {
          const now = usage[field];
          if (now === undefined || now <= 0) continue;
          this.#credit(row, sess, field, now);
        }
      }
    }
    row.turns += 1;
    sess.turns += 1;
    this.#bump(row, sess, sessionId, at);
  }

  /** All (target, model) rows, most recently active first. */
  rows(): UsageRow[] {
    return [...this.#rows.values()]
      .map((r) => ({
        target: r.target,
        model: r.model,
        turns: r.turns,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheReadTokens: r.cacheReadTokens,
        cacheWriteTokens: r.cacheWriteTokens,
        costUsd: r.costUsd,
        sessions: r.sessions.size,
        lastAt: r.lastAt,
      }))
      .sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
  }

  /** One session's totals, or null when it never reported. */
  sessionUsage(sessionId: string): SessionUsage | null {
    const s = this.#sessions.get(sessionId);
    if (s === undefined) return null;
    return {
      target: s.target,
      model: s.model,
      turns: s.turns,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      cacheReadTokens: s.cacheReadTokens,
      cacheWriteTokens: s.cacheWriteTokens,
      costUsd: s.costUsd,
      lastAt: s.lastAt,
    };
  }
}
