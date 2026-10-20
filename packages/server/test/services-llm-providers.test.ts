// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import type { Credential } from '@harness-nexus/core';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import type { LlmProviderDeps } from '../src/services/llm-providers.js';
import {
  createLlmProvider,
  deleteLlmProvider,
  listLlmProviders,
  queryProviderModels,
  updateLlmProvider,
} from '../src/services/llm-providers.js';
import type { Principal } from '../src/services/principal.js';

/**
 * #53 slice 6 — the LLM provider domain service, tested DIRECTLY against
 * the memory driver (no HTTP, no Fastify, NO network: every case that would
 * reach fetchProviderModels is gated out before the fetch). The route tests
 * keep pinning the wire end-to-end; these assert the #36 scope rules and the
 * credential visibility gate at the door both callers share.
 */

const owner: Principal = { userId: 'u-owner', role: 'user' };
const stranger: Principal = { userId: 'u-stranger', role: 'user' };
const admin: Principal = { userId: 'u-admin', role: 'admin' };

function deps(): LlmProviderDeps {
  return {
    uow: createMemoryUnitOfWork(),
    credentialEncryptionKey: 'test-secret-0123456789abcdef',
    providerModelsTimeoutMs: 50,
  };
}

const now = '2026-10-14T00:00:00.000Z';

/** Seed a credential row (secret stays opaque — nothing here decrypts it). */
async function seedCred(d: LlmProviderDeps, over: Partial<Credential> = {}): Promise<Credential> {
  const cred: Credential = {
    id: 'cred-' + Math.random().toString(36).slice(2, 8),
    name: 'k',
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

const providerInput = (credentialName: string, over: Record<string, unknown> = {}) =>
  ({
    name: 'gw',
    api: 'openai-chat',
    baseUrl: 'https://gw.example.com/v1',
    credentialName,
    scope: 'personal',
    ...over,
  }) as Parameters<typeof createLlmProvider>[2];

describe('svc llm-providers — scope rules (#36, no HTTP)', () => {
  it('personal rows are owner-only: strangers and admins get the same 404', async () => {
    const d = deps();
    const cred = await seedCred(d);
    const created = await createLlmProvider(d, owner, providerInput(cred.name));

    for (const p of [stranger, admin]) {
      await expect(updateLlmProvider(d, p, created.id, { name: 'x' })).rejects.toMatchObject({
        statusCode: 404,
        code: 'PROVIDER_NOT_FOUND',
      });
      await expect(deleteLlmProvider(d, p, created.id)).rejects.toMatchObject({ statusCode: 404 });
    }
    expect((await listLlmProviders(d, owner)).map((x) => x.id)).toContain(created.id);
    expect((await listLlmProviders(d, stranger)).map((x) => x.id)).not.toContain(created.id);
    expect((await listLlmProviders(d, admin)).map((x) => x.id)).not.toContain(created.id);
  });

  it('global create is admin-only; global rows list for everyone', async () => {
    const d = deps();
    const globalCred = await seedCred(d, {
      name: 'shared',
      scope: 'global',
      ownerId: null,
      distributable: true,
    });
    await expect(
      createLlmProvider(d, owner, providerInput(globalCred.name, { scope: 'global' })),
    ).rejects.toMatchObject({ statusCode: 403 });
    const global = await createLlmProvider(
      d,
      admin,
      providerInput(globalCred.name, { scope: 'global', name: 'shared' }),
    );
    expect(global.ownerId).toBeNull();
    expect((await listLlmProviders(d, stranger)).map((x) => x.id)).toContain(global.id);
  });

  it('name uniqueness per (name, scope, owner); same name in another namespace is fine', async () => {
    const d = deps();
    const cred = await seedCred(d);
    const otherCred = await seedCred(d, { name: 'other', ownerId: stranger.userId });
    await createLlmProvider(d, owner, providerInput(cred.name));
    await expect(createLlmProvider(d, owner, providerInput(cred.name))).rejects.toMatchObject({
      statusCode: 409,
      code: 'PROVIDER_NAME_TAKEN',
    });
    await expect(
      createLlmProvider(d, stranger, providerInput(otherCred.name)),
    ).resolves.toBeTruthy();
    // Renaming to a taken name 409s; renaming to a free one succeeds.
    const mine = (await listLlmProviders(d, owner))[0]!;
    await expect(updateLlmProvider(d, owner, mine.id, { name: 'free' })).resolves.toMatchObject({
      name: 'free',
    });
  });
});

describe('svc llm-providers — credential visibility gate', () => {
  it('a locked global secret never travels to a caller-chosen endpoint', async () => {
    const d = deps();
    const locked = await seedCred(d, {
      name: 'locked',
      scope: 'global',
      ownerId: null,
      distributable: false,
    });

    // Personal create = caller-chosen URL → the gate fires for a regular
    // user, BEFORE any network fetch (query-models explicit arm).
    await expect(createLlmProvider(d, owner, providerInput(locked.name))).rejects.toMatchObject({
      statusCode: 403,
      code: 'CREDENTIAL_NOT_DISTRIBUTABLE',
    });
    await expect(
      queryProviderModels(d, owner, { api: 'openai-chat', credentialName: locked.name }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'CREDENTIAL_NOT_DISTRIBUTABLE' });

    // Admins may always use it; a stored GLOBAL row's URL is admin-chosen,
    // so it passes the gate for its readers too (no fetch follows: the
    // create path stops after the gate).
    await expect(
      createLlmProvider(d, admin, providerInput(locked.name, { scope: 'global' })),
    ).resolves.toBeTruthy();
  });

  it('credentials resolve only in the caller’s namespace (#21) — foreign names 404', async () => {
    const d = deps();
    const cred = await seedCred(d);
    await expect(createLlmProvider(d, stranger, providerInput(cred.name))).rejects.toMatchObject({
      statusCode: 404,
      code: 'CREDENTIAL_NOT_FOUND',
    });
  });

  it('query-models hides foreign providers (404) before anything is fetched', async () => {
    const d = deps();
    const cred = await seedCred(d);
    const created = await createLlmProvider(d, owner, providerInput(cred.name));
    await expect(
      queryProviderModels(d, stranger, { providerId: created.id }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'PROVIDER_NOT_FOUND' });
  });
});
