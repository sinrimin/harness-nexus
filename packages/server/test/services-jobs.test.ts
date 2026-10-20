// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import type { Job } from '@harness-nexus/core';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import { enrollMachine } from '../src/services/machines.js';
import type { Principal, ServiceDeps } from '../src/services/principal.js';
import { createProfile } from '../src/services/profiles.js';
import {
  assertDeployableTarget,
  assertHarnessJobAllowed,
  getVisibleDeployProfile,
  isDeployableTarget,
  listMachineJobs,
  requireProfileInOwnerMarketplace,
} from '../src/services/jobs.js';

/**
 * #53 slice 16 — the job-creation decisions, tested DIRECTLY against the
 * memory driver (no HTTP, no sockets). The dispatch/capability-gate half is
 * route residue, pinned end-to-end by test/jobs.test.ts; these assert the
 * owner-only job visibility, deploy-profile visibility, the deployable-target
 * gate, and the claude-code marketplace-ownership rule at the shared door.
 */

const owner: Principal = { userId: 'u-owner', role: 'user' };
const stranger: Principal = { userId: 'u-stranger', role: 'user' };
const admin: Principal = { userId: 'u-admin', role: 'admin' };

function deps(): ServiceDeps {
  return { uow: createMemoryUnitOfWork() };
}

const now = '2026-10-14T00:00:00.000Z';

let clock = 0;
const tick = (): string => new Date(Date.parse(now) + clock++ * 1000).toISOString();

async function seedJob(d: ServiceDeps, machineId: string, over: Partial<Job> = {}): Promise<Job> {
  const at = tick();
  const job: Job = {
    id: 'job-' + Math.random().toString(36).slice(2, 8),
    machineId,
    ownerId: owner.userId,
    type: 'deploy',
    status: 'queued',
    payload: { profileId: 'p1' },
    result: null,
    error: null,
    attempts: 0,
    createdAt: at,
    updatedAt: at,
    ...over,
  };
  await d.uow.jobs.save(job);
  return job;
}

/** The machine owner as a real USER row (the marketplace rule reads username). */
async function seedUser(d: ServiceDeps, id: string, username: string) {
  await d.uow.users.save({
    id,
    username,
    passwordHash: null,
    role: 'user',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
}

const harnessBody = (action: 'install' | 'upgrade' | 'pin' | 'apply-config') =>
  ({ type: 'harness', action, target: 'codex' }) as Parameters<typeof assertHarnessJobAllowed>[0];

describe('svc jobs — job list visibility (#36)', () => {
  it("lists the owner's machine jobs newest-first; strangers and admins get the 404", async () => {
    const d = deps();
    const { machine } = await enrollMachine(d, owner, { name: 'box' });
    await seedJob(d, machine.id, { payload: { profileId: 'a' } });
    const newest = await seedJob(d, machine.id, { payload: { profileId: 'b' } });

    const jobs = await listMachineJobs(d, owner, machine.id);
    expect(jobs.map((j) => j.id)).toEqual([newest.id, expect.any(String)]);
    for (const p of [stranger, admin]) {
      await expect(listMachineJobs(d, p, machine.id)).rejects.toMatchObject({
        statusCode: 404,
        code: 'MACHINE_NOT_FOUND',
      });
    }
  });
});

describe('svc jobs — harness body gate', () => {
  it('refuses a bare apply-config body (the spec surface owns it)', async () => {
    expect(() => assertHarnessJobAllowed(harnessBody('apply-config'))).toThrowError(
      expect.objectContaining({ statusCode: 409, code: 'USE_RUNTIME_CONFIG_ENDPOINT' }),
    );
    for (const action of ['install', 'upgrade', 'pin'] as const) {
      expect(() => assertHarnessJobAllowed(harnessBody(action))).not.toThrow();
    }
  });
});

describe('svc jobs — deploy profile visibility', () => {
  it('hides foreign personal profiles from strangers AND admins (404)', async () => {
    const d = deps();
    const mine = await createProfile(d, owner, {
      name: 'mine',
      target: 'hermes',
      scope: 'personal',
      entries: [],
    });
    const global = await createProfile(d, admin, {
      name: 'shared',
      target: 'hermes',
      scope: 'global',
      entries: [],
    });
    for (const p of [stranger, admin]) {
      await expect(getVisibleDeployProfile(d, p, mine.id)).rejects.toMatchObject({
        statusCode: 404,
        code: 'PROFILE_NOT_FOUND',
      });
    }
    await expect(getVisibleDeployProfile(d, owner, mine.id)).resolves.toMatchObject({
      id: mine.id,
    });
    // Global rows deploy for everyone.
    await expect(getVisibleDeployProfile(d, stranger, global.id)).resolves.toMatchObject({
      id: global.id,
    });
  });
});

describe('svc jobs — deployable targets + the claude-code marketplace rule (#6)', () => {
  it('DEPLOYABLE_TARGETS: adapter targets pass, everything else 409s', () => {
    for (const t of ['hermes', 'codex', 'deepseek', 'pi'] as const) {
      expect(isDeployableTarget(t)).toBe(true);
      expect(() => assertDeployableTarget(t)).not.toThrow();
    }
    expect(isDeployableTarget('claude-code')).toBe(false);
    expect(() => assertDeployableTarget('claude-code')).toThrowError(
      expect.objectContaining({ statusCode: 409, code: 'TARGET_NOT_DEPLOYABLE' }),
    );
  });

  it('claude-code deploys require the profile in the MACHINE OWNER’s marketplace', async () => {
    const d = deps();
    await seedUser(d, owner.userId, 'machineowner');
    const { machine } = await enrollMachine(d, owner, { name: 'box' });
    const foreign = await createProfile(d, stranger, {
      name: 'theirs',
      target: 'claude-code',
      scope: 'personal',
      entries: [],
    });
    await expect(requireProfileInOwnerMarketplace(d, foreign, machine)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PROFILE_NOT_IN_OWNER_MARKETPLACE',
    });
    // Global profiles live in every marketplace; the owner's own do too.
    const global = await createProfile(d, admin, {
      name: 'shared-cc',
      target: 'claude-code',
      scope: 'global',
      entries: [],
    });
    await expect(requireProfileInOwnerMarketplace(d, global, machine)).resolves.toMatchObject({
      id: owner.userId,
    });
    const own = await createProfile(d, owner, {
      name: 'own-cc',
      target: 'claude-code',
      scope: 'personal',
      entries: [],
    });
    await expect(requireProfileInOwnerMarketplace(d, own, machine)).resolves.toMatchObject({
      username: expect.any(String),
    });
  });
});
