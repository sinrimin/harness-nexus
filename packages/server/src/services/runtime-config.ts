// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { LlmProvider, Machine, RuntimeConfig } from '@harness-nexus/core';
import {
  AppError,
  runtimeConfigSpecSchema,
  runtimeSpecUnsupportedReason,
  runtimeTargetSchema,
  type RuntimeConfigSpec,
  type RuntimeTarget,
} from '@harness-nexus/shared';
import { generateId } from '../infra/crypto.js';
import { findCredentialForOwner } from '../infra/credential-scope.js';
import { getMachine } from './machines.js';
import type { Principal, ServiceDeps } from './principal.js';

/**
 * Runtime-config domain service (#53 slice 14, Phase 9 W3) — the PURE half of
 * the provider-spec surface: owner gate, target gate, the dial-site-style
 * distributable-credential gate, providerId visibility, extras normalization,
 * and the #51 modelEntries snapshot. Extracted verbatim from the route
 * handlers; only the door changed.
 *
 * What deliberately stays at the route (realtime residue): the W4 redacted
 * view round-trip (presence + capability + ctl emit + waiter) and, on PUT, the
 * soft capability gate + the apply-config job dispatch — both read LIVE
 * daemon state. To keep their original position (between validation and
 * save), the PUT is split into `planRuntimeConfigUpsert` (decide) and
 * `saveRuntimeConfig` (persist) with the route's gate in between.
 */

/** Machine + parsed target — the shared resolution of every REST arm. */
export interface RuntimeTargetRef {
  machine: Machine;
  target: RuntimeTarget;
}

/**
 * Owner gate + runtime-target gate. Owner-only (404 existence-hiding, #36 —
 * machines are personal, admins are not overseers); the target must be
 * runtime-managed (400).
 */
export async function resolveRuntimeTarget(
  deps: ServiceDeps,
  principal: Principal,
  machineId: string,
  rawTarget: string,
): Promise<RuntimeTargetRef> {
  const machine = await getMachine(deps, principal, machineId);
  const parsedTarget = runtimeTargetSchema.safeParse(rawTarget);
  if (!parsedTarget.success) {
    throw new AppError(
      `Target '${rawTarget}' is not runtime-managed`,
      400,
      'RUNTIME_TARGET_INVALID',
    );
  }
  return { machine, target: parsedTarget.data };
}

/** The spec-echo GET arm: the stored row or 404 (the secret NEVER appears). */
export async function getRuntimeConfig(
  deps: ServiceDeps,
  principal: Principal,
  machineId: string,
  rawTarget: string,
): Promise<RuntimeConfig> {
  const { machine, target } = await resolveRuntimeTarget(deps, principal, machineId, rawTarget);
  const row = await deps.uow.runtimeConfigs.findByMachineAndTarget(machine.id, target);
  if (!row) {
    throw new AppError('No runtime config for this target', 404, 'RUNTIME_CONFIG_NOT_FOUND');
  }
  return row;
}

/** A validated, normalized upsert waiting to be persisted. */
export interface RuntimeConfigUpsertPlan {
  machine: Machine;
  /** Fully gated + normalized row (id/createdAt preserved on replace). */
  row: RuntimeConfig;
  /** false = replacing an existing row (the PUT replies 200, not 201). */
  created: boolean;
}

/**
 * Validate one PUT end-to-end WITHOUT persisting: spec parse (after the
 * machine/target gates, exactly as the route ordered them), the
 * per-target support gate, the distributable-credential gate (dial-site
 * rules: the plaintext must be allowed to leave the server, and it must
 * resolve in the CALLER's namespace — #21), providerId visibility, extras
 * dedupe, and the #51 modelEntries snapshot from the provider registry.
 */
export async function planRuntimeConfigUpsert(
  deps: ServiceDeps,
  principal: Principal,
  machineId: string,
  rawTarget: string,
  body: unknown,
): Promise<RuntimeConfigUpsertPlan> {
  const { machine, target } = await resolveRuntimeTarget(deps, principal, machineId, rawTarget);

  const spec: RuntimeConfigSpec = runtimeConfigSpecSchema.parse(body);
  const unsupported = runtimeSpecUnsupportedReason(target, spec);
  if (unsupported !== null) {
    throw new AppError(unsupported, 409, 'RUNTIME_CONFIG_UNSUPPORTED');
  }

  // The credential gate (dial-site rules): the plaintext must be allowed to
  // leave the server, and it must resolve in the CALLER's namespace (#21) —
  // another user's same-named personal secret does not exist as far as
  // this caller is concerned.
  const cred = await findCredentialForOwner(deps.uow, spec.credentialName, principal.userId);
  if (!cred) {
    throw new AppError(
      `Credential "${spec.credentialName}" not found`,
      404,
      'CREDENTIAL_NOT_FOUND',
    );
  }
  if (!cred.distributable) {
    throw new AppError(
      `Credential "${spec.credentialName}" is not distributable — a runtime config's key is applied on the machine (opt in via the credential's distributable flag)`,
      409,
      'CREDENTIAL_NOT_DISTRIBUTABLE',
    );
  }

  // W10 — `providerId` is provenance only, but it must still name a
  // provider visible to the caller at PUT time (a dangling ref later is
  // fine: the spec is a snapshot and the form falls back to manual).
  let providerRow: LlmProvider | null = null;
  if (spec.providerId !== undefined) {
    const provider = await deps.uow.llmProviders.findById(spec.providerId);
    if (!provider || (provider.scope === 'personal' && provider.ownerId !== principal.userId)) {
      throw new AppError('Provider not found', 404, 'PROVIDER_NOT_FOUND');
    }
    providerRow = provider;
  }

  // W10 — extra switchable models: dedupe and drop the default (the
  // writers prepend `model` themselves; the stored value is the extras
  // only, and an empty remainder normalizes back to null).
  const uniqueExtras =
    spec.models !== undefined ? [...new Set(spec.models)].filter((m) => m !== spec.model) : [];
  const models = uniqueExtras.length > 0 ? uniqueExtras : null;

  // #51 — metadata snapshot for [model, ...extras] from the provider's
  // registry (ids not in the registry get no entry: bare ids stay
  // honest). Old daemons' zod strips the unknown field — wire-compatible.
  let modelEntries: RuntimeConfigSpec['modelEntries'];
  if (providerRow !== null && providerRow.models.length > 0) {
    const byId = new Map(providerRow.models.map((m) => [m.id, m]));
    const allIds = [spec.model, ...uniqueExtras];
    const entries = allIds.flatMap((id) => {
      const m = byId.get(id);
      if (m === undefined) return [];
      return [
        {
          id: m.id,
          ...(m.displayName !== undefined ? { displayName: m.displayName } : {}),
          ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
          ...(m.maxOutputTokens !== undefined ? { maxOutputTokens: m.maxOutputTokens } : {}),
          ...(m.vision !== undefined ? { vision: m.vision } : {}),
        },
      ];
    });
    if (entries.length > 0) modelEntries = entries;
  }

  const existing = await deps.uow.runtimeConfigs.findByMachineAndTarget(machine.id, target);
  const now = new Date().toISOString();
  const row: RuntimeConfig = {
    id: existing?.id ?? generateId(),
    machineId: machine.id,
    ownerId: machine.ownerId,
    target,
    spec: {
      providerLabel: spec.providerLabel,
      baseUrl: spec.baseUrl ?? null,
      api: spec.api,
      model: spec.model,
      credentialName: spec.credentialName,
      providerId: spec.providerId ?? null,
      models,
      modelEntries: modelEntries ?? null,
      // #60 — the claude-code panel rides the row verbatim (zod-validated
      // above; null keeps untouched rows in their pre-#60 shape). #62 — same
      // contract for the opencode panel. #63 — same for the codex panel.
      // #64 — same for the dsh panel. #65 — same for the pi panel.
      claudeCode: spec.claudeCode ?? null,
      opencode: spec.opencode ?? null,
      codex: spec.codex ?? null,
      deepseek: spec.deepseek ?? null,
      pi: spec.pi ?? null,
      extra: spec.extra ?? null,
    },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  return { machine, row, created: existing === null };
}

/**
 * Persist a planned upsert. Split from `planRuntimeConfigUpsert` on purpose:
 * the route's soft capability gate (an ONLINE daemon without the W3 executor
 * is refused early) reads live presence and must run BETWEEN validation and
 * save — the original ordering.
 */
export async function saveRuntimeConfig(
  deps: ServiceDeps,
  plan: RuntimeConfigUpsertPlan,
): Promise<RuntimeConfig> {
  await deps.uow.runtimeConfigs.save(plan.row);
  return plan.row;
}
