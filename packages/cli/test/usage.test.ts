import { describe, expect, it } from 'vitest';
import {
  UsageLedger,
  hasTokenCounts,
  normalizeUsage,
  responseUsageMode,
} from '../src/daemon/usage.js';

/**
 * #39 — the dialect pick (one place knows every upstream's spelling of a
 * token count) and the daemon-lifetime usage ledger (per-(target, model)
 * and per-session totals with counter-reset tolerance).
 */

describe('normalizeUsage', () => {
  it('maps every dialect spelling of the cache fields', () => {
    // Anthropic-style camelCase (claude-agent-acp / opencode).
    expect(
      normalizeUsage({
        inputTokens: 10,
        outputTokens: 2,
        cacheCreationInputTokens: 300,
        cacheReadInputTokens: 5000,
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 2, cacheWriteTokens: 300, cacheReadTokens: 5000 });
    // The ACP end-turn strawman / claude wrapper response spellings.
    expect(normalizeUsage({ cachedReadTokens: 6, cachedWriteTokens: 7 })).toEqual({
      cacheReadTokens: 6,
      cacheWriteTokens: 7,
    });
    // deepseek's snake_case prompt cache (the tap/commit payload).
    expect(
      normalizeUsage({ inputTokens: 7, outputTokens: 1, prompt_cache_hit_tokens: 900 }),
    ).toEqual({ inputTokens: 7, outputTokens: 1, cacheReadTokens: 900 });
    // pi's short keys pass through the same pick.
    expect(normalizeUsage({ input: 3, output: 4 })).toEqual({
      inputTokens: 3,
      outputTokens: 4,
    });
    // Already-normalized shape (a future adapter adopting ours).
    expect(normalizeUsage({ cacheReadTokens: 8, cacheWriteTokens: 9 })).toEqual({
      cacheReadTokens: 8,
      cacheWriteTokens: 9,
    });
  });

  it('ignores malformed values and the cache-miss field', () => {
    expect(
      normalizeUsage({ inputTokens: -5, outputTokens: 'x', prompt_cache_miss_tokens: 10 }),
    ).toEqual({});
    // deepseek's miss is UNCACHED input, not a cache write — never mapped.
    expect('cacheWriteTokens' in normalizeUsage({ prompt_cache_miss_tokens: 10 })).toBe(false);
  });

  it('flags occupancy-only payloads as count-less', () => {
    expect(hasTokenCounts(normalizeUsage(undefined))).toBe(false);
    expect(hasTokenCounts(normalizeUsage({ cachedInputTokens: 1 }))).toBe(true);
  });
});

describe('responseUsageMode (#44)', () => {
  it('maps only the verified dialects; unknown targets are ignored', () => {
    expect(responseUsageMode('claude-code')).toBe('cumulative');
    expect(responseUsageMode('opencode')).toBe('perTurn');
    expect(responseUsageMode('codex')).toBeNull();
    expect(responseUsageMode('deepseek')).toBeNull();
    expect(responseUsageMode('pi')).toBeNull();
  });
});

describe('UsageLedger', () => {
  it('sums per-turn reports across sessions and turns', () => {
    const ledger = new UsageLedger();
    // Every shipped adapter reports PER-TURN counts — the ledger sums.
    ledger.record('s1', 'claude-code', 'sonnet', { inputTokens: 100, outputTokens: 10 }, 't1');
    ledger.record('s1', 'claude-code', 'sonnet', { inputTokens: 200, outputTokens: 5 }, 't2');
    ledger.record('s2', 'claude-code', 'sonnet', { inputTokens: 700 }, 't3');

    const [row] = ledger.rows();
    expect(row).toMatchObject({
      target: 'claude-code',
      model: 'sonnet',
      // Turns count ONLY on turn_result (#44) — usage events alone leave 0.
      turns: 0,
      inputTokens: 1000,
      outputTokens: 15,
      sessions: 2,
    });
    expect(ledger.sessionUsage('s1')!.inputTokens).toBe(300);
    expect(ledger.sessionUsage('s2')!.inputTokens).toBe(700);
  });

  it('keeps a model switch out of the old row and re-labels the session', () => {
    const ledger = new UsageLedger();
    ledger.record('s', 'claude-code', 'sonnet', { inputTokens: 100 }, 't1');
    ledger.record('s', 'claude-code', 'opus', { inputTokens: 4000 }, 't2');
    const rows = ledger.rows();
    expect(rows.find((r) => r.model === 'sonnet')!.inputTokens).toBe(100);
    expect(rows.find((r) => r.model === 'opus')!.inputTokens).toBe(4000);
    expect(ledger.sessionUsage('s')!.model).toBe('opus');
    expect(ledger.sessionUsage('s')!.inputTokens).toBe(4100);
  });

  it('ignores occupancy-only events and reports per-session totals', () => {
    const ledger = new UsageLedger();
    ledger.record('s', 'deepseek', 'deepseek-chat', { cacheReadTokens: 5 }, 't0'); // no in/out — still counts
    expect(ledger.sessionUsage('never')).toBeNull();
    expect(ledger.rows()[0]!.cacheReadTokens).toBe(5);
  });

  it('sorts rows most-recently-active first', () => {
    const ledger = new UsageLedger();
    ledger.record('a', 'pi', 'm1', { inputTokens: 1 }, '2026-01-01T00:00:03Z');
    ledger.record('b', 'pi', 'm2', { inputTokens: 1 }, '2026-01-01T00:00:01Z');
    ledger.record('c', 'pi', 'm3', { inputTokens: 1 }, '2026-01-01T00:00:02Z');
    expect(ledger.rows().map((r) => r.model)).toEqual(['m1', 'm3', 'm2']);
  });

  it('recordTurn counts EVERY target and applies known response dialects', () => {
    const ledger = new UsageLedger();
    // Unknown target (codex today): turn counts, usage ignored.
    ledger.recordTurn('c1', 'codex', 'gpt-5', { inputTokens: 500 }, 't0');
    // claude-code: CUMULATIVE responses — deltas credited, reset re-credits.
    ledger.recordTurn(
      'c2',
      'claude-code',
      'opus',
      { inputTokens: 100, cacheReadTokens: 500 },
      't1',
    );
    ledger.recordTurn(
      'c2',
      'claude-code',
      'opus',
      { inputTokens: 200, cacheReadTokens: 1000 },
      't2',
    );
    ledger.recordTurn('c2', 'claude-code', 'opus', { inputTokens: 30 }, 't3'); // compaction reset
    // opencode: PER-TURN responses — summed straight in.
    ledger.recordTurn('c3', 'opencode', 'qwen', { inputTokens: 52 }, 't4');
    ledger.recordTurn('c3', 'opencode', 'qwen', { inputTokens: 80 }, 't5');

    const rows = ledger.rows();
    const codex = rows.find((r) => r.target === 'codex')!;
    expect(codex).toMatchObject({ turns: 1, inputTokens: 0 });
    const claude = rows.find((r) => r.target === 'claude-code')!;
    expect(claude).toMatchObject({ turns: 3, inputTokens: 230, cacheReadTokens: 1000 });
    const open = rows.find((r) => r.target === 'opencode')!;
    expect(open).toMatchObject({ turns: 2, inputTokens: 132 });
  });

  it('delta-accounts the session-cumulative usage_update cost', () => {
    const ledger = new UsageLedger();
    ledger.record('s', 'claude-code', 'opus', { costUsd: 0.012 }, 't1');
    ledger.record('s', 'claude-code', 'opus', { costUsd: 0.03 }, 't2');
    ledger.record('s', 'claude-code', 'opus', { costUsd: 0.005 }, 't3'); // new session context
    const [row] = ledger.rows();
    expect(row.costUsd).toBeCloseTo(0.012 + 0.018 + 0.005, 9);
    // Turns come ONLY from turn_result — cost events never bump them.
    expect(row.turns).toBe(0);
  });
});
