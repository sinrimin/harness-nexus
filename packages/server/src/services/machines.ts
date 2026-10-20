// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { Machine } from '@harness-nexus/core';
import type { CreateMachineInput, UpdateMachineInput } from '@harness-nexus/shared';
import { AppError } from '@harness-nexus/shared';
import { generateId, generatePat, hashToken, patDisplayPrefix } from '../infra/crypto.js';
import type { Principal, ServiceDeps } from './principal.js';

/**
 * Machine domain service (#53 slice 3) — the Phase 8 C1 CRUD. Extracted
 * verbatim from the route handlers; only the door changed.
 *
 * Machines are personal — the owner sees and mutates them; anyone else (admin
 * included, #36: admins are not tenant overseers) gets 404 (existence-hiding,
 * same convention as credentials/mcp-servers).
 *
 * Enrolling creates the Machine plus its dedicated machine PAT (scopes
 * ['machine-ctl'], rejected by REST) whose raw token is returned exactly once.
 *
 * Realtime teardown on delete (socket drop, in-flight scan failure, queued-job
 * purge) stays at the route (#53 residue) — it runs BETWEEN the ownership
 * decision (`getMachine`) and the record purge (`purgeMachineRecords`) so the
 * daemon can never reconnect to a half-deleted machine. Presence (the `online`
 * view flag) is likewise realtime truth the route adds when shaping replies.
 */

/** The enroll result: the machine row + the raw machine token (shown once). */
export interface EnrollMachineResult {
  machine: Machine;
  token: string;
}

export async function enrollMachine(
  deps: ServiceDeps,
  principal: Principal,
  input: CreateMachineInput,
): Promise<EnrollMachineResult> {
  const rawToken = generatePat();
  const now = new Date().toISOString();
  // Machine token: scopes ['machine-ctl'] — accepted by the /ctl namespace
  // middleware only; the REST auth hook rejects it (blast radius = realtime).
  const pat = await deps.uow.tokens.save({
    id: generateId(),
    userId: principal.userId,
    name: `machine: ${input.name}`,
    tokenHash: hashToken(rawToken),
    prefix: patDisplayPrefix(rawToken),
    scopes: ['machine-ctl'],
    expiresAt: null,
    lastUsedAt: null,
    createdAt: now,
  });

  const machine: Machine = {
    id: generateId(),
    ownerId: principal.userId,
    name: input.name,
    hostname: null,
    os: null,
    arch: null,
    daemonVersion: null,
    capabilities: [],
    remoteChatEnabled: false,
    baseWorkspace: null,
    enrollmentPatId: pat.id,
    enrolledAt: now,
    lastSeenAt: null,
  };
  await deps.uow.machines.save(machine);
  return { machine, token: rawToken };
}

/** The caller's own machines (an admin lists their own, not the fleet). */
export async function listMachines(deps: ServiceDeps, principal: Principal): Promise<Machine[]> {
  return deps.uow.machines.list({ ownerId: principal.userId });
}

/** Owner-only fetch; anyone else (admin included) gets the 404. */
export async function getMachine(
  deps: ServiceDeps,
  principal: Principal,
  id: string,
): Promise<Machine> {
  const machine = await deps.uow.machines.findById(id);
  if (!machine || machine.ownerId !== principal.userId) {
    throw new AppError('Machine not found', 404, 'MACHINE_NOT_FOUND');
  }
  return machine;
}

/** Rename / remote-chat toggle / base workspace / chat pre-warm switches. */
export async function updateMachine(
  deps: ServiceDeps,
  principal: Principal,
  id: string,
  input: UpdateMachineInput,
): Promise<Machine> {
  const machine = await getMachine(deps, principal, id);
  return deps.uow.machines.save({
    ...machine,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.remoteChatEnabled !== undefined
      ? { remoteChatEnabled: input.remoteChatEnabled }
      : {}),
    ...(input.baseWorkspace !== undefined ? { baseWorkspace: input.baseWorkspace } : {}),
    // Issue #3 — machine-scoped pre-warm switches (replace semantics).
    ...(input.chatPrewarm !== undefined ? { chatPrewarm: input.chatPrewarm } : {}),
    // Issue #49 — machine-scoped default chat permission modes (replace).
    ...(input.chatDefaultMode !== undefined ? { chatDefaultMode: input.chatDefaultMode } : {}),
  });
}

/**
 * Remove a machine's records: runtime configs, inventory snapshots, the
 * enrollment PAT (so the daemon can never reconnect), then the row. Call only
 * AFTER the route's realtime teardown — the original ordering (sockets, then
 * PAT revocation, then rows) is preserved by the caller.
 */
export async function purgeMachineRecords(deps: ServiceDeps, machine: Machine): Promise<void> {
  await deps.uow.runtimeConfigs.deleteByMachine(machine.id);
  await deps.uow.inventories.deleteByMachine(machine.id);
  await deps.uow.tokens.delete(machine.enrollmentPatId);
  await deps.uow.machines.delete(machine.id);
}
