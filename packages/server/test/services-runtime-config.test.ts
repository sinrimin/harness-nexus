// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import type { Credential, LlmProvider, ProviderModelConfig } from '@harness-nexus/core';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import { enrollMachine } from '../src/services/machines.js';
import type { Principal, ServiceDeps } from '../src/services/principal.js';
import {
  getRuntimeConfig,
  planRuntimeConfigUpsert,
  resolveRuntimeTarget,
  saveRuntimeConfig,
} from '../src/services/runtime-config.js';

/**
 * #53 slice 14 — the runtime-config service's PURE half, tested DIRECTLY
 * against the memory driver (no HTTP, no sockets). The W4 redacted-view
 * round-trip and the apply-config dispatch are route residue and stay pinned
 * by test/runtime-config.test.ts + test/config-view.test.ts; these assert the
 * owner gate, the spec/credential/provider gates, extras normalization, and
 * the #51 modelEntries snapshot at the shared door.
 */

const owner: Principal = { userId: 'u-owner', role: 'user' };
const stranger: Principal = { userId: 'u-stranger', role: 'user' };
const admin: Principal = { userId: 'u-admin', role: 'admin' };

function deps(): ServiceDeps {
  return { uow: createMemoryUnitOfWork() };
}

const now = '2026-10-14T00:00:00.000Z';

async function seedCred(d: ServiceDeps, over: Partial<Credential> = {}): Promise<Credential> {
  const cred: Credential = {
    id: 'cred-' + Math.random().toString(36).slice(2, 8),
    name: 'gw-key',
    secret: 'opaque',
    scope: 'personal',
    ownerId: owner.userId,
    distributable: true,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  await d.uow.credentials.save(cred);
  return cred;
}

async function seedProvider(
  d: ServiceDeps,
  models: ProviderModelConfig[],
  over: Partial<LlmProvider> = {},
): Promise<LlmProvider> {
  const provider: LlmProvider = {
    id: 'prov-' + Math.random().toString(36).slice(2, 8),
    name: 'gw',
    api: 'openai-chat',
    baseUrl: 'https://gw.example.com/v1',
    credentialName: 'gw-key',
    scope: 'personal',
    ownerId: owner.userId,
    models,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  await d.uow.llmProviders.save(provider);
  return provider;
}

async function ownerMachine(d: ServiceDeps) {
  const { machine } = await enrollMachine(d, owner, { name: 'w3-box' });
  return machine;
}

const codexSpec = {
  providerLabel: 'team gateway',
  baseUrl: 'https://gw.example.com/v1',
  api: 'openai',
  model: 'gw-large',
  credentialName: 'gw-key',
};

describe('svc runtime-config — target resolution + spec echo', () => {
  it('is owner-only: strangers and admins get the same 404 (#36)', async () => {
    const d = deps();
    const machine = await ownerMachine(d);
    for (const p of [stranger, admin]) {
      await expect(resolveRuntimeTarget(d, p, machine.id, 'codex')).rejects.toMatchObject({
        statusCode: 404,
        code: 'MACHINE_NOT_FOUND',
      });
    }
  });

  it("400s a target that is not runtime-managed (e.g. 'hermes')", async () => {
    const d = deps();
    const machine = await ownerMachine(d);
    await expect(resolveRuntimeTarget(d, owner, machine.id, 'hermes')).rejects.toMatchObject({
      statusCode: 400,
      code: 'RUNTIME_TARGET_INVALID',
    });
  });

  it('echo GET: 404 RUNTIME_CONFIG_NOT_FOUND until a row exists, then the row', async () => {
    const d = deps();
    const machine = await ownerMachine(d);
    await seedCred(d);
    await expect(getRuntimeConfig(d, owner, machine.id, 'codex')).rejects.toMatchObject({
      statusCode: 404,
      code: 'RUNTIME_CONFIG_NOT_FOUND',
    });
    const plan = await planRuntimeConfigUpsert(d, owner, machine.id, 'codex', codexSpec);
    const saved = await saveRuntimeConfig(d, plan);
    expect((await getRuntimeConfig(d, owner, machine.id, 'codex')).id).toBe(saved.id);
  });
});

describe('svc runtime-config — PUT validation gates', () => {
  it('rejects an api flavor the target cannot speak', async () => {
    const d = deps();
    const machine = await ownerMachine(d);
    await seedCred(d);
    await expect(
      planRuntimeConfigUpsert(d, owner, machine.id, 'claude-code', {
        ...codexSpec,
        api: 'openai',
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'RUNTIME_CONFIG_UNSUPPORTED' });
  });

  it('rejects a baseUrl-less deepseek spec with 409 RUNTIME_CONFIG_UNSUPPORTED', async () => {
    const d = deps();
    const machine = await ownerMachine(d);
    await seedCred(d);
    const { baseUrl: _drop, ...noUrl } = codexSpec;
    await expect(
      planRuntimeConfigUpsert(d, owner, machine.id, 'deepseek', noUrl),
    ).rejects.toMatchObject({ statusCode: 409, code: 'RUNTIME_CONFIG_UNSUPPORTED' });
  });

  it('gates on credential existence and the caller’s namespace (#21)', async () => {
    const d = deps();
    const machine = await ownerMachine(d);
    await seedCred(d);
    await expect(
      planRuntimeConfigUpsert(d, owner, machine.id, 'codex', {
        ...codexSpec,
        credentialName: 'nope',
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'CREDENTIAL_NOT_FOUND' });
    // A stranger's same-named PERSONAL secret does not exist for the caller.
    await seedCred(d, { ownerId: stranger.userId, name: 'foreign' });
    await expect(
      planRuntimeConfigUpsert(d, owner, machine.id, 'codex', {
        ...codexSpec,
        credentialName: 'foreign',
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'CREDENTIAL_NOT_FOUND' });
  });

  it('refuses a locked (non-distributable) credential — even a global one', async () => {
    const d = deps();
    const machine = await ownerMachine(d);
    await seedCred(d, {
      name: 'locked-global',
      scope: 'global',
      ownerId: null,
      distributable: false,
    });
    await expect(
      planRuntimeConfigUpsert(d, owner, machine.id, 'codex', {
        ...codexSpec,
        credentialName: 'locked-global',
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CREDENTIAL_NOT_DISTRIBUTABLE' });
  });

  it('providerId must name a provider visible to the caller (W10 provenance gate)', async () => {
    const d = deps();
    const machine = await ownerMachine(d);
    await seedCred(d);
    // The machine is the owner's, but the PROVIDER is a stranger's personal row.
    const foreign = await seedProvider(d, [], { ownerId: stranger.userId });
    await expect(
      planRuntimeConfigUpsert(d, owner, machine.id, 'codex', {
        ...codexSpec,
        providerId: foreign.id,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'PROVIDER_NOT_FOUND' });
    // A GLOBAL provider is visible to everyone.
    const global = await seedProvider(d, [], { scope: 'global', ownerId: null });
    await expect(
      planRuntimeConfigUpsert(d, owner, machine.id, 'codex', {
        ...codexSpec,
        providerId: global.id,
      }),
    ).resolves.toBeTruthy();
  });
});

describe('svc runtime-config — extras normalization + #51 modelEntries snapshot', () => {
  it('dedupes extras, drops the default, and normalizes an empty remainder to null', async () => {
    const d = deps();
    const machine = await ownerMachine(d);
    await seedCred(d);
    const plan = await planRuntimeConfigUpsert(d, owner, machine.id, 'codex', {
      ...codexSpec,
      models: ['gw-large', 'm2', 'm2', 'm3'],
    });
    expect(plan.row.spec.models).toEqual(['m2', 'm3']);
    const onlyDefault = await planRuntimeConfigUpsert(d, owner, machine.id, 'codex', {
      ...codexSpec,
      models: ['gw-large', 'gw-large'],
    });
    expect(onlyDefault.row.spec.models).toBeNull();
  });

  it('snapshots metadata for [model, ...extras] from the provider registry; bare ids stay honest', async () => {
    const d = deps();
    const machine = await ownerMachine(d);
    await seedCred(d);
    const provider = await seedProvider(d, [
      {
        id: 'gw-large',
        type: 'chat',
        displayName: 'GW Large',
        contextWindow: 200000,
        temperature: 0.7, // advanced params never enter the snapshot
      },
      { id: 'm2', type: 'chat', vision: true },
    ]);
    const plan = await planRuntimeConfigUpsert(d, owner, machine.id, 'codex', {
      ...codexSpec,
      providerId: provider.id,
      models: ['m2', 'unregistered'],
    });
    expect(plan.row.spec.modelEntries).toEqual([
      { id: 'gw-large', displayName: 'GW Large', contextWindow: 200000 },
      { id: 'm2', vision: true },
    ]);
    // Without a providerId there is no registry — no entries at all.
    const bare = await planRuntimeConfigUpsert(d, owner, machine.id, 'codex', {
      ...codexSpec,
      models: ['m2'],
    });
    expect(bare.row.spec.modelEntries).toBeNull();
  });

  it('second PUT reuses the row identity (created=false, createdAt preserved)', async () => {
    const d = deps();
    const machine = await ownerMachine(d);
    await seedCred(d);
    const first = await planRuntimeConfigUpsert(d, owner, machine.id, 'codex', codexSpec);
    await saveRuntimeConfig(d, first);
    const second = await planRuntimeConfigUpsert(d, owner, machine.id, 'codex', {
      ...codexSpec,
      model: 'gw-large-2',
    });
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(second.row.createdAt).toBe(first.row.createdAt);
    await saveRuntimeConfig(d, second);
    expect((await getRuntimeConfig(d, owner, machine.id, 'codex')).spec.model).toBe('gw-large-2');
  });
});
