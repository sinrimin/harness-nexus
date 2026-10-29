// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { DecisionRecord } from '@harness-nexus/core';
import type { DecisionRecordListQuery } from '@harness-nexus/shared';
import type { Principal, ServiceDeps } from './principal.js';

/**
 * #97 — the delegated-decision audit trail. The table is personal-scope by
 * construction (the port REQUIRES an ownerId on every read) and the owner is
 * the principal, never a query param — admin widens nothing here: the rows
 * are "what my delegation did", not a cross-user oversight surface.
 *
 * The writes are not services: both realtime axes append fire-and-forget at
 * the gate's settle site (the row is telemetry of a decision already
 * authorized to run, not a mutation a caller could request).
 */
export async function listDecisionRecords(
  deps: ServiceDeps,
  principal: Principal,
  query: DecisionRecordListQuery,
): Promise<DecisionRecord[]> {
  return deps.uow.decisionRecords.list({
    ownerId: principal.userId,
    ...(query.sessionId !== undefined ? { sessionId: query.sessionId } : {}),
    ...(query.machineId !== undefined ? { machineId: query.machineId } : {}),
    ...(query.outcome !== undefined ? { outcome: query.outcome } : {}),
    ...(query.before !== undefined ? { before: query.before } : {}),
    limit: query.limit,
  });
}
