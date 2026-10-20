// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import { hashToken, PAT_PREFIX } from '../src/infra/crypto.js';
import type { ServiceDeps } from '../src/services/principal.js';
import {
  getMarketplaceArchiveProfile,
  resolveMarketplaceTokenUser,
} from '../src/services/marketplace.js';
import type { PersonalAccessToken, Profile, User } from '@harness-nexus/core';

/**
 * #53 slice 13 — the marketplace emitter service, tested DIRECTLY against the
 * memory driver (no HTTP). Route tests pin the emitter output end-to-end
 * (test/emitter.test.ts); these assert the emit-token lifecycle and the
 * archive-visibility decisions at the shared door — every rejection is the
 * same 404, so nothing leaks through URLs into logs.
 */

function deps(): ServiceDeps {
  return { uow: createMemoryUnitOfWork() };
}

async function seedUser(d: ServiceDeps, over: Partial<User> & { id: string }): Promise<User> {
  const now = new Date().toISOString();
  return d.uow.users.save({
    username: over.id,
    passwordHash: 'x',
    role: 'user',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

async function seedPat(
  d: ServiceDeps,
  over: Partial<PersonalAccessToken> & { id: string; userId: string; scopes: string[] },
): Promise<string> {
  const raw = PAT_PREFIX + over.id;
  await d.uow.tokens.save({
    name: over.id,
    tokenHash: hashToken(raw),
    prefix: raw.slice(0, PAT_PREFIX.length + 6),
    expiresAt: null,
    lastUsedAt: null,
    createdAt: new Date().toISOString(),
    ...over,
  });
  return raw;
}

async function seedProfile(
  d: ServiceDeps,
  over: Partial<Profile> & { id: string },
): Promise<Profile> {
  const now = new Date().toISOString();
  return d.uow.profiles.save({
    name: over.id,
    version: '1.0.0',
    target: 'claude-code',
    scope: 'personal',
    ownerId: 'u1',
    entries: [],
    createdAt: now,
    updatedAt: now,
    ...over,
  });
}

describe('svc marketplace — emit-token resolution (PAT-in-path)', () => {
  it('accepts marketplace and machine-ctl scoped tokens for active users', async () => {
    const d = deps();
    await seedUser(d, { id: 'u1', username: 'owner' });
    const market = await seedPat(d, { id: 'market', userId: 'u1', scopes: ['marketplace'] });
    const ctl = await seedPat(d, { id: 'ctl', userId: 'u1', scopes: ['machine-ctl'] });

    for (const raw of [market, ctl]) {
      await expect(resolveMarketplaceTokenUser(d, raw)).resolves.toMatchObject({
        id: 'u1',
        username: 'owner',
        role: 'user',
      });
    }
    // Resolving stamps lastUsedAt (fire-and-forget — let the microtask land).
    await new Promise((r) => setTimeout(r, 10));
    const row = await d.uow.tokens.findById(
      (await d.uow.tokens.findByTokenHash(hashToken(market)))!.id,
    );
    expect(row!.lastUsedAt).not.toBeNull();
  });

  it('rejects everything else with the SAME 404 (no existence leak)', async () => {
    const d = deps();
    await seedUser(d, { id: 'u1', username: 'owner' });
    await seedUser(d, { id: 'u3', username: 'gone', status: 'disabled' });
    const api = await seedPat(d, { id: 'api', userId: 'u1', scopes: [] });
    const expired = await seedPat(d, {
      id: 'expired',
      userId: 'u1',
      scopes: ['marketplace'],
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const disabled = await seedPat(d, { id: 'dis', userId: 'u3', scopes: ['marketplace'] });

    for (const raw of ['garbage', api, expired, disabled, PAT_PREFIX + 'unknown']) {
      await expect(resolveMarketplaceTokenUser(d, raw)).rejects.toMatchObject({
        statusCode: 404,
        code: 'MARKETPLACE_NOT_FOUND',
      });
    }
  });
});

describe('svc marketplace — archive visibility', () => {
  it('strips .zip, gates on target + #36 visibility', async () => {
    const d = deps();
    await seedUser(d, { id: 'u1', username: 'owner' });
    await seedUser(d, { id: 'u2', username: 'other' });
    await seedProfile(d, { id: 'p1' }); // u1's personal claude-code
    await seedProfile(d, { id: 'p2', scope: 'global', ownerId: null }); // global
    await seedProfile(d, { id: 'p3', target: 'hermes' }); // wrong target
    await seedProfile(d, { id: 'p4', ownerId: 'u2' }); // foreign personal

    const own = await getMarketplaceArchiveProfile(d, 'u1', 'p1.zip');
    expect(own.profileId).toBe('p1');
    expect(own.profile.id).toBe('p1');
    await expect(getMarketplaceArchiveProfile(d, 'u1', 'p2.zip')).resolves.toMatchObject({
      profileId: 'p2',
    });

    for (const file of ['p9.zip', 'p3.zip', 'p4.zip', 'p1.tar.gz']) {
      await expect(getMarketplaceArchiveProfile(d, 'u1', file)).rejects.toMatchObject({
        statusCode: 404,
        code: 'PROFILE_NOT_FOUND',
      });
    }
  });
});
