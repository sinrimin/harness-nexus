// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { Job, Machine, Profile, User } from '@harness-nexus/core';
import { AppError, type CreateMachineJobInput } from '@harness-nexus/shared';
import { getMachine } from './machines.js';
import type { Principal, ServiceDeps } from './principal.js';

/**
 * Job-creation domain service (#53 slice 16, Phase 8 C4 + 9 W2) — the PURE
 * decisions behind `POST/GET /api/machines/:id/jobs`: the owner-only machine
 * gate (404 existence-hiding, #36), deploy-profile visibility, the
 * deployable-target gate, and the claude-code marketplace-ownership rule.
 * Extracted verbatim from the route handlers; only the door changed.
 *
 * What deliberately stays at the route (realtime residue): the soft
 * capability gates (they read LIVE presence — an online daemon without the
 * executor is refused early; an offline machine may queue) and every
 * `app.realtime.jobs.createJob` dispatch (job state machine + /ctl emit +
 * /app push live in the realtime JobService, not here). Their positions
 * relative to these decisions are documented at the route.
 */

/**
 * Targets that have a local-write install adapter in the CLI registry.
 * claude-code branches BEFORE this list (#6): its deploys ride the 3.5
 * marketplace emitter — the daemon drives CC's own `claude plugin` CLI, not
 * an adapter. deepseek (T1) writes skills + a home cordis-patch MCP row like
 * the others.
 */
export const DEPLOYABLE_TARGETS = ['hermes', 'codex', 'deepseek', 'pi'] as const;

export function isDeployableTarget(target: Profile['target']): boolean {
  return DEPLOYABLE_TARGETS.includes(target as (typeof DEPLOYABLE_TARGETS)[number]);
}

/** 409 for a target whose deploys this instance does not serve at all. */
export function assertDeployableTarget(target: Profile['target']): void {
  if (!isDeployableTarget(target)) {
    throw new AppError(
      `Profiles for target '${target}' are deployed via a path this instance does not serve`,
      409,
      'TARGET_NOT_DEPLOYABLE',
    );
  }
}

/** The owner's machine jobs, newest first (anyone else gets the 404). */
export async function listMachineJobs(
  deps: ServiceDeps,
  principal: Principal,
  machineId: string,
): Promise<Job[]> {
  const machine = await getMachine(deps, principal, machineId);
  return deps.uow.jobs.listByMachine(machine.id);
}

/**
 * A harness job body may name any action EXCEPT `apply-config`: provider
 * config is managed as a SPEC (upsert + queue on the dedicated surface), not
 * a bare job body.
 */
export function assertHarnessJobAllowed(
  input: Extract<CreateMachineJobInput, { type: 'harness' }>,
): void {
  if (input.action === 'apply-config') {
    throw new AppError(
      'Use PUT /api/machines/:id/runtime-config/:target to apply provider config',
      409,
      'USE_RUNTIME_CONFIG_ENDPOINT',
    );
  }
}

/** A deploy payload's profile, visible to the caller or 404-hid. */
export async function getVisibleDeployProfile(
  deps: ServiceDeps,
  principal: Principal,
  profileId: string,
): Promise<Profile> {
  const profile = await deps.uow.profiles.findById(profileId);
  const profileVisible =
    profile && (profile.scope === 'global' || profile.ownerId === principal.userId);
  if (!profile || !profileVisible) {
    throw new AppError('Profile not found', 404, 'PROFILE_NOT_FOUND');
  }
  return profile;
}

/**
 * The claude-code marketplace rule (#6): the catalog the daemon reads belongs
 * to the MACHINE OWNER, so the profile must be global or owned by them (an
 * admin deploying their own personal profile onto a user's machine would emit
 * a catalog that never contains it). Returns the owner row — the dispatch
 * payload's marketplace name derives from their username.
 */
export async function requireProfileInOwnerMarketplace(
  deps: ServiceDeps,
  profile: Profile,
  machine: Machine,
): Promise<User> {
  if (profile.scope !== 'global' && profile.ownerId !== machine.ownerId) {
    throw new AppError(
      "claude-code deploys install from the machine owner's marketplace — the profile must be global or owned by the machine owner",
      409,
      'PROFILE_NOT_IN_OWNER_MARKETPLACE',
    );
  }
  const owner = await deps.uow.users.findById(machine.ownerId);
  if (!owner) throw new AppError('Machine not found', 404, 'MACHINE_NOT_FOUND');
  return owner;
}
