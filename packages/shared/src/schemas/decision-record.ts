// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { z } from 'zod';

/**
 * Issue #97 — the delegated-decision audit row over the wire. Mirrors core's
 * `DecisionRecord` (kept in sync by hand, like every pair); every field the
 * gate did not have is optional, so floor rows (no model ran) render lean.
 */
export const decisionRecordSchema = z.object({
  id: z.string().min(1).max(64),
  ownerId: z.string().min(1).max(64),
  createdAt: z.string().min(1),
  axis: z.enum(['chat', 'assistant']),
  machineId: z.string().min(1).max(64).optional(),
  sessionId: z.string().min(1).max(128).optional(),
  requestId: z.string().min(1).max(128).optional(),
  target: z.string().min(1).max(64).optional(),
  toolTitle: z.string().max(512),
  toolKind: z.string().max(128).optional(),
  toolInputPreview: z.string().max(4000).optional(),
  outcome: z.enum(['allow', 'deny', 'escalate']),
  decidedBy: z.enum(['floor', 'model']),
  severity: z.number().min(1).max(7).optional(),
  intent: z.number().min(0).max(1).optional(),
  why: z.enum(['policy', 'not_covered', 'destructive', 'sensitive', 'risky', 'other']).optional(),
  sevConfidence: z.number().min(0).max(1).optional(),
  intentConfidence: z.number().min(0).max(1).optional(),
  providerName: z.string().min(1).max(64).optional(),
  modelId: z.string().min(1).max(128).optional(),
  latencyMs: z.number().int().min(0).optional(),
  denialReason: z
    .enum(['policy', 'not_covered', 'destructive', 'sensitive', 'risky', 'other'])
    .optional(),
  humanResponse: z.enum(['allow', 'reject', 'timeout', 'cancel']).optional(),
});
export type DecisionRecordView = z.infer<typeof decisionRecordSchema>;

/** GET /api/decision-records — owner is the principal, never a query param. */
export const decisionRecordListQuerySchema = z.object({
  sessionId: z.string().min(1).max(128).optional(),
  machineId: z.string().min(1).max(64).optional(),
  outcome: z.enum(['allow', 'deny', 'escalate']).optional(),
  /** Exclusive createdAt cursor (ISO) — pages walk backward, newest-first. */
  before: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type DecisionRecordListQuery = z.infer<typeof decisionRecordListQuerySchema>;
