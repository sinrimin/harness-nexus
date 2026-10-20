// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { Machine } from '@harness-nexus/core';
import { AppError } from '@harness-nexus/shared';
import { normalizeWorkspacePath, isWithinWorkspace } from '../paths.js';
import type { Principal, ServiceDeps } from './principal.js';

/**
 * Workspace domain service (#53 slice 12) — the PURE half of the directory
 * listing (Phase 9 W6): owner-only machine access, base-workspace gating,
 * and path containment. The other half is a daemon round-trip (`workspace:list`
 * over /ctl with a realtime waiter) and stays at the route — services return
 * facts, callers act.
 */

/** What the listing round-trip needs: the machine row + both normalized paths. */
export interface WorkspaceListingTarget {
  machine: Machine;
  /** The normalized machine base workspace (containment root). */
  root: string;
  /** The normalized requested path (root when the query omitted it). */
  requested: string;
}

/**
 * Validate + prepare one listing: the machine must exist and be the caller's
 * (owner-only read, 404-hiding — #36, same convention as the other machine
 * surfaces), its baseWorkspace must be configured, and the requested path
 * must BE the root or sit under it. The daemon round-trip itself (online
 * check, capability check, ctl emit, waiter) stays at the route.
 */
export async function prepareWorkspaceListing(
  deps: ServiceDeps,
  principal: Principal,
  machineId: string,
  rawPath?: string,
): Promise<WorkspaceListingTarget> {
  const machine = await deps.uow.machines.findById(machineId);
  if (!machine || machine.ownerId !== principal.userId) {
    throw new AppError('Machine not found', 404, 'MACHINE_NOT_FOUND');
  }
  if (machine.baseWorkspace === null) {
    throw new AppError(
      'Base workspace is not configured for this machine',
      400,
      'WORKSPACE_ROOT_NOT_SET',
    );
  }

  // #33: normalize WITHOUT the server's own filesystem semantics — the
  // path belongs to the (possibly Windows) machine, and a Linux server's
  // resolve() would garble `D:\code` into `/app/D:\code`.
  const root = normalizeWorkspacePath(machine.baseWorkspace);
  const requested = normalizeWorkspacePath(rawPath && rawPath !== '' ? rawPath : root);
  if (!isWithinWorkspace(requested, root)) {
    throw new AppError('Path is outside the machine base workspace', 400, 'WORKSPACE_OUTSIDE_ROOT');
  }
  return { machine, root, requested };
}
