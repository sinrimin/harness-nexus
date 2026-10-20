// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import { PAT_PREFIX } from '../src/infra/crypto.js';
import type { PatDeps } from '../src/services/pats.js';
import { createPat, deletePat, listPats } from '../src/services/pats.js';
import type { Principal } from '../src/services/principal.js';

/**
 * #53 slice 11 — the PAT service, tested DIRECTLY against the memory driver
 * (no HTTP). Route tests pin the wire; these assert the emit-token lifecycle
 * at the shared door: server-assigned scopes (never self-issued), the
 * shown-once raw token + its marketplace URL, and owner-only revocation.
 */

const owner: Principal = { userId: 'u-owner', role: 'user' };
const stranger: Principal = { userId: 'u-stranger', role: 'user' };
const admin: Principal = { userId: 'u-admin', role: 'admin' };

function deps(): PatDeps {
  return { uow: createMemoryUnitOfWork(), publicBaseUrl: 'https://hn.example' };
}

const input = (over: Record<string, unknown> = {}) =>
  ({ name: 'cli token', ...over }) as Parameters<typeof createPat>[2];

describe('svc pats — creation and the shown-once token', () => {
  it('an api token carries NO scopes and no marketplace URL', async () => {
    const d = deps();
    const { pat, token, marketplaceUrl } = await createPat(d, owner, input());
    expect(token.startsWith(PAT_PREFIX)).toBe(true);
    expect(marketplaceUrl).toBeUndefined();
    expect(pat.userId).toBe(owner.userId);
    expect(pat.scopes).toEqual([]);
    expect(pat.tokenHash).not.toContain(token); // sha256 at rest, prefix kept for UI
    expect(pat.prefix).toBe(token.slice(0, PAT_PREFIX.length + 6));
    // The stored row resolves back from the raw token's hash.
    expect(await d.uow.tokens.findByTokenHash(pat.tokenHash)).toMatchObject({ id: pat.id });
  });

  it('a marketplace token gets exactly scopes:["marketplace"] + its emit URL', async () => {
    const d = deps();
    // Client-supplied scope lists are IGNORED — capability tags are never
    // self-issued (#21), even by an admin.
    const { pat, token, marketplaceUrl } = await createPat(
      d,
      admin,
      input({ kind: 'marketplace', scopes: ['machine-ctl'] }),
    );
    expect(pat.scopes).toEqual(['marketplace']);
    expect(marketplaceUrl).toBe(`${d.publicBaseUrl}/api/marketplace/${token}/marketplace.json`);
  });

  it("persists the optional expiry and lists only the caller's rows", async () => {
    const d = deps();
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const mine = await createPat(d, owner, input({ name: 'expiring', expiresAt }));
    expect(mine.pat.expiresAt).toBe(expiresAt);
    await createPat(d, stranger, input({ name: 'theirs' }));
    expect((await listPats({ uow: d.uow }, owner)).map((p) => p.id)).toEqual([mine.pat.id]);
  });
});

describe('svc pats — revocation is owner-only (#36)', () => {
  it('strangers AND admins get the same 404; the owner revokes', async () => {
    const d = deps();
    const { pat } = await createPat(d, owner, input());
    for (const p of [stranger, admin]) {
      await expect(deletePat({ uow: d.uow }, p, pat.id)).rejects.toMatchObject({
        statusCode: 404,
        code: 'PAT_NOT_FOUND',
      });
    }
    await deletePat({ uow: d.uow }, owner, pat.id);
    expect(await d.uow.tokens.findById(pat.id)).toBeNull();
    await expect(deletePat({ uow: d.uow }, owner, pat.id)).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
