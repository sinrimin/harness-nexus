/**
 * #39 — token usage accounting for the TUI (and anyone else in-process).
 *
 * Two halves:
 *
 *   normalizeUsage — one place that knows every upstream's spelling of a
 *     token count. The four targets speak three dialects of cache field
 *     (Anthropic's cache_creation/cache_read, deepseek's snake_case prompt
 *     cache, our own normalized shape); the mapping layers
 *     (`mapAcpUpdate`, the dsh mapper, the pi connection) all funnel raw
 *     usage objects through here so the semantic event carries ONE shape.
 *     deepseek's `prompt_cache_miss_tokens` deliberately does NOT map to
 *     cacheWrite — "uncached input" is not "cache write".
 *
 *   UsageLedger — per-(target, model) and per-session totals, fed by the
 *     chat manager at every token-bearing usage event. Every adapter we
 *     ship reports PER-TURN counts (claude's usage_update at turn end,
 *     opencode per message, pi's message_end, dsh's committed block), so
 *     the ledger simply SUMS events; if a future target reports running
 *     counters instead, it needs a dialect flag here, not silence.
 *     Daemon-lifetime only — nothing persists across restarts.
 */

/** Dialect spellings for each normalized field, most-explicit first. */
const INPUT_KEYS = ['inputTokens', 'input'] as const;
const OUTPUT_KEYS = ['outputTokens', 'output'] as const;
const READ_KEYS = [
  'cacheReadTokens',
  'cacheReadInputTokens',
  'cache_read_input_tokens',
  'cachedInputTokens',
  'prompt_cache_hit_tokens',
] as const;
const WRITE_KEYS = [
  'cacheWriteTokens',
  'cacheCreationInputTokens',
  'cache_creation_input_tokens',
  'cacheWriteInputTokens',
] as const;

/**
 * `| undefined` on every field (exactOptionalPropertyTypes): callers hand us
 * zod-inferred event objects whose optional properties may be explicitly
 * undefined; record() treats undefined and absent identically.
 */
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

export interface UsageRow {
  target: string;
  model: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
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
  sessions: Set<string>;
  lastAt: string;
}

export class UsageLedger {
  #rows = new Map<string, Acc>();
  #sessions = new Map<string, Acc>();

  /** Feed one token-bearing usage event. Ignores occupancy-only payloads. */
  record(sessionId: string, target: string, model: string, ev: UsageFields, at: string): void {
    if (!hasTokenCounts(ev)) return;
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
        sessions: new Set<string>(),
        lastAt: at,
      };
      this.#rows.set(key, row);
    }
    let sess = this.#sessions.get(sessionId);
    if (sess === undefined) {
      sess = {
        target,
        model,
        turns: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        sessions: new Set<string>(),
        lastAt: at,
      };
      this.#sessions.set(sessionId, sess);
    } else if (sess.model !== model) {
      // A mid-session model switch re-labels the session view (the rows
      // keep their per-model history; the session total spans models).
      sess.model = model;
    }
    const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;
    for (const field of fields) {
      const now = ev[field];
      if (now === undefined || now <= 0) continue;
      row[field] += now;
      sess[field] += now;
    }
    row.turns += 1;
    row.sessions.add(sessionId);
    row.lastAt = at;
    sess.turns += 1;
    sess.lastAt = at;
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
        sessions: r.sessions.size,
        lastAt: r.lastAt,
      }))
      .sort((a, b) => (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0));
  }

  /** One session's totals, or null when it never reported tokens. */
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
      lastAt: s.lastAt,
    };
  }
}
