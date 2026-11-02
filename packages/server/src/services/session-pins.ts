// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { SessionPin } from '@harness-nexus/core';
import {
  assistantPinKey,
  machinePinKey,
  sessionPinKeyOf,
  type SessionPinPut,
} from '@harness-nexus/shared';
import type { Principal, ServiceDeps } from './principal.js';

/**
 * #110 — pinned sessions, one store for both rails. Owner-only by
 * construction (#36 personal rule): every method is the principal's own
 * rows, admin widens nothing. No existence checks — a pin for a session no
 * listing ever returns is an orphan: filtered at render, GC'd here.
 *
 * The EMPTY-LISTING GUARD lives in `gcSessionPins`, the single door: a
 * listing that came back empty (daemon failure, offline machine, a genuinely
 * emptied store) must never read as "all sessions deleted" — one bad listing
 * would otherwise wipe every pin for that axis. The accepted trade: a
 * machine whose sessions were really all deleted keeps its orphan pins until
 * the next non-empty listing (harmless — render filters them).
 */

export async function listSessionPins(
  deps: ServiceDeps,
  principal: Principal,
): Promise<SessionPin[]> {
  return deps.uow.sessionPins.listByOwner(principal.userId);
}

export async function pinSession(
  deps: ServiceDeps,
  principal: Principal,
  input: SessionPinPut,
): Promise<SessionPin> {
  const pin: SessionPin = {
    ownerId: principal.userId,
    sessionKey: sessionPinKeyOf(input),
    pinnedAt: new Date().toISOString(),
  };
  return deps.uow.sessionPins.save(pin);
}

export async function unpinSession(
  deps: ServiceDeps,
  principal: Principal,
  input: SessionPinPut,
): Promise<void> {
  await deps.uow.sessionPins.delete(principal.userId, sessionPinKeyOf(input));
}

/**
 * Orphan GC over one axis scope. Callers pass the session ids a SUCCESSFUL
 * listing returned; an empty id list prunes NOTHING (see the guard above).
 * The machine scope is one (machine, target) pair — listings are per agent
 * instance, so one instance's listing must never prune a sibling's pins.
 */
export async function gcSessionPins(
  deps: ServiceDeps,
  ownerId: string,
  axis: { kind: 'assistant' } | { kind: 'machine'; machineId: string; target: string },
  liveSessionIds: string[],
): Promise<void> {
  if (liveSessionIds.length === 0) return;
  const prefix =
    axis.kind === 'assistant' ? 'assistant/' : `machine/${axis.machineId}/${axis.target}/`;
  const live = new Set(
    liveSessionIds.map((id) =>
      axis.kind === 'assistant'
        ? assistantPinKey(id)
        : machinePinKey(axis.machineId, axis.target, id),
    ),
  );
  const pins = await deps.uow.sessionPins.listByOwner(ownerId);
  await Promise.all(
    pins
      .filter((p) => p.sessionKey.startsWith(prefix) && !live.has(p.sessionKey))
      .map((p) => deps.uow.sessionPins.delete(ownerId, p.sessionKey)),
  );
}
