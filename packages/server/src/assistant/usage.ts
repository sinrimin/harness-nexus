// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { AssistantMessageRow } from '@harness-nexus/core';
import type { SessionUsageSnapshot } from '@harness-nexus/shared';

/**
 * #128 — session-cumulative token/cache totals for the ASSISTANT HUD, the
 * server-process counterpart of the daemon-side UsageLedger (#124). The
 * assistant runs in-process over pi-ai, whose `AssistantMessage.usage` is a
 * REQUIRED object with input/output/cacheRead/cacheWrite — the turn runner
 * funnels every model response of the turn loop (tool round-trips included)
 * through `record` via its `usage` stream events. Bypass calls — the title
 * refine (#109) and the delegated-approvals decision model (#95 follow-up) —
 * never touch that emit path, so they are excluded by construction.
 *
 * Honesty semantics mirror the ledger: a field rides the snapshot only when
 * it was ever REPORTED (0 is a report, absence is unknown), and `turns`
 * counts USER turns. One deliberate deviation: pi-ai normalizes missing
 * cache fields to 0 in several dialects (openai-completions maps
 * `cached_tokens ?? 0`), so a 0 cache field cannot be told apart from an
 * absent one — the accumulator marks cache fields reported only when > 0,
 * the conservative direction (the CACHE cell stays blank rather than
 * rendering a possibly-fake 0%). input/output are genuine reports in every
 * pi-ai dialect, so 0 counts as reported there.
 */
export class SessionUsageAccumulator {
  turns = 0;
  readonly #totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  readonly #reported = { input: false, output: false, cacheRead: false, cacheWrite: false };
  /** The LAST response's derived occupancy (the HUD's CTX reading). */
  #context: { contextUsed: number; contextSize: number } | null = null;

  /**
   * Seed from the persisted transcript: one user row = one turn, each
   * assistant row's `usage` one recorded response. Rows carry the cache
   * counts and the derived occupancy since #128's persistence amendment, so
   * a reopened session restores the whole strip (legacy rows without those
   * fields keep them honestly unknown).
   */
  static fromRows(rows: readonly AssistantMessageRow[]): SessionUsageAccumulator {
    const acc = new SessionUsageAccumulator();
    for (const row of rows) {
      if (row.type === 'user') {
        acc.countTurn();
      } else if (row.type === 'assistant' && row.usage !== undefined) {
        acc.record(row.usage);
      }
    }
    return acc;
  }

  /** One user turn began (counted at the prompt's append, queued flushes included). */
  countTurn(): void {
    this.turns += 1;
  }

  /** Fold one model response's reported fields into the session totals. */
  record(report: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    cacheReadTokens?: number | undefined;
    cacheWriteTokens?: number | undefined;
    contextUsed?: number | undefined;
    contextSize?: number | undefined;
  }): void {
    if (report.inputTokens !== undefined) {
      this.#reported.input = true;
      this.#totals.inputTokens += Math.max(0, report.inputTokens);
    }
    if (report.outputTokens !== undefined) {
      this.#reported.output = true;
      this.#totals.outputTokens += Math.max(0, report.outputTokens);
    }
    // Ambiguous-zero dialects: only a positive value proves a report (#128).
    if (report.cacheReadTokens !== undefined && report.cacheReadTokens > 0) {
      this.#reported.cacheRead = true;
      this.#totals.cacheReadTokens += report.cacheReadTokens;
    }
    if (report.cacheWriteTokens !== undefined && report.cacheWriteTokens > 0) {
      this.#reported.cacheWrite = true;
      this.#totals.cacheWriteTokens += report.cacheWriteTokens;
    }
    // Occupancy is a LAST-WINS reading, never a sum (it describes the window
    // as it now stands, not the session's throughput).
    if (
      report.contextUsed !== undefined &&
      report.contextSize !== undefined &&
      report.contextSize > 0
    ) {
      this.#context = { contextUsed: report.contextUsed, contextSize: report.contextSize };
    }
  }

  /** The last response's derived occupancy (null when none was ever known). */
  contextSnapshot(): { contextUsed: number; contextSize: number } | null {
    return this.#context;
  }

  /**
   * The wire snapshot (#124's `sessionUsageSnapshotSchema`): only fields the
   * session ever reported ride along (absent = unknown, never 0); null when
   * no token count was ever reported (nothing for the HUD to say).
   */
  snapshot(): SessionUsageSnapshot | null {
    if (
      !this.#reported.input &&
      !this.#reported.output &&
      !this.#reported.cacheRead &&
      !this.#reported.cacheWrite
    ) {
      return null;
    }
    return {
      turns: this.turns,
      ...(this.#reported.input ? { inputTokens: this.#totals.inputTokens } : {}),
      ...(this.#reported.output ? { outputTokens: this.#totals.outputTokens } : {}),
      ...(this.#reported.cacheRead ? { cacheReadTokens: this.#totals.cacheReadTokens } : {}),
      ...(this.#reported.cacheWrite ? { cacheWriteTokens: this.#totals.cacheWriteTokens } : {}),
    };
  }
}
