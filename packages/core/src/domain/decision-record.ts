// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * Issue #97 — one row per delegated-approvals verdict the gate produced.
 * The decision runs server-side (both axes share `approvals-gate.ts`), so
 * the trail is written at the settle site, fire-and-forget. Append-only
 * audit, personal-scope by construction; the ONE later write is the
 * `humanResponse` backfill (an escalated card the human then answered —
 * the model-lean × human-answer labeled pair calibration needs).
 */
export type DecisionAxis = 'chat' | 'assistant';

/** The gate's settled answer: the option it chose (or leaned toward). */
export type DecisionOutcome = 'allow' | 'deny' | 'escalate';

/** Which layer produced it: a deterministic layer or the model call. */
export type DecisionLayer = 'floor' | 'model';

/** The human's answer on a card the gate escalated (backfilled later). */
export type DecisionHumanResponse = 'allow' | 'reject' | 'timeout' | 'cancel';

/** Mirrors shared's DelegationDenialReason — kept in sync by hand, like every pair. */
export type DecisionDenialReason =
  'policy' | 'not_covered' | 'destructive' | 'sensitive' | 'risky' | 'other';

export interface DecisionRecord {
  id: string;
  ownerId: string;
  createdAt: string;
  axis: DecisionAxis;
  /**
   * Chat-axis context — string references, never FKs: the audit outlives the
   * machine and the (live-only, W7) session. `ownerId` alone carries the FK
   * (user delete cascades the trail away).
   */
  machineId?: string;
  sessionId?: string;
  /** The permission request id — the backfill key for `humanResponse`. */
  requestId?: string;
  target?: string;
  toolTitle: string;
  toolKind?: string;
  /** The same bounded arguments view the model judged (≤ the gate's char cap). */
  toolInputPreview?: string;
  outcome: DecisionOutcome;
  decidedBy: DecisionLayer;
  /** The model's raw verdict inputs (absent on floor rows — nothing ran). */
  severity?: number;
  intent?: number;
  why?: DecisionDenialReason;
  sevConfidence?: number;
  intentConfidence?: number;
  /** Call provenance (absent on floor rows). */
  providerName?: string;
  modelId?: string;
  latencyMs?: number;
  /** The denial that crossed the wire (floor rows say 'policy'). */
  denialReason?: DecisionDenialReason;
  /** Backfilled when the human answered an escalated card. */
  humanResponse?: DecisionHumanResponse;
}

export interface DecisionRecordListFilter {
  /** Always required — the table is personal-scope by construction. */
  ownerId: string;
  sessionId?: string;
  machineId?: string;
  outcome?: DecisionOutcome;
  /** Exclusive createdAt cursor (ISO); drivers return newest-first. */
  before?: string;
  limit?: number;
}

/**
 * Per-owner retention cap. Pruning is ON-WRITE inside `append` (an indexed
 * surplus DELETE, sub-millisecond, off the settle hot path) — no sweeper
 * timer; #97 pinned the numbers (≤2000 rows ≈ 5MB/owner worst case).
 */
export const DECISION_RECORDS_CAP = 2000;
