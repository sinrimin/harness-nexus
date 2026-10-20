// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import { findCredentialForOwner } from '../src/infra/credential-scope.js';
import { decryptSecret } from '../src/infra/crypto.js';
import type { CredentialDeps } from '../src/services/credentials.js';
import {
  createCredential,
  credentialSecretPreview,
  deleteCredential,
  listCredentials,
  updateCredential,
} from '../src/services/credentials.js';
import type { Principal } from '../src/services/principal.js';

/**
 * #53 slice 7 — the credential domain service, tested DIRECTLY against the
 * memory driver (no HTTP, no Fastify). The route tests keep pinning the wire
 * end-to-end; these assert the #36 scope rules, the distributable gates, and
 * encryption-at-rest at the door both callers share.
 */

const owner: Principal = { userId: 'u-owner', role: 'user' };
const stranger: Principal = { userId: 'u-stranger', role: 'user' };
const admin: Principal = { userId: 'u-admin', role: 'admin' };

function deps(): CredentialDeps {
  return { uow: createMemoryUnitOfWork(), credentialEncryptionKey: 'test-secret-0123456789abcdef' };
}

const input = (over: Record<string, unknown> = {}) =>
  ({ name: 'k', secret: 'sk-plaintext', scope: 'personal', ...over }) as Parameters<
    typeof createCredential
  >[2];

describe('svc credentials — scope rules (#36, no HTTP)', () => {
  it('personal rows are owner-only: strangers and admins get the same 404', async () => {
    const d = deps();
    const created = await createCredential(d, owner, input());

    for (const p of [stranger, admin]) {
      await expect(updateCredential(d, p, created.id, { name: 'x' })).rejects.toMatchObject({
        statusCode: 404,
        code: 'CREDENTIAL_NOT_FOUND',
      });
      await expect(deleteCredential(d, p, created.id)).rejects.toMatchObject({ statusCode: 404 });
    }
    expect((await listCredentials(d, owner)).map((c) => c.id)).toContain(created.id);
    expect((await listCredentials(d, stranger)).map((c) => c.id)).not.toContain(created.id);
    expect((await listCredentials(d, admin)).map((c) => c.id)).not.toContain(created.id);
  });

  it('global create is admin-only; global rows list for everyone', async () => {
    const d = deps();
    await expect(createCredential(d, owner, input({ scope: 'global' }))).rejects.toMatchObject({
      statusCode: 403,
    });
    const global = await createCredential(d, admin, input({ scope: 'global', name: 'shared' }));
    expect(global.ownerId).toBeNull();
    expect((await listCredentials(d, stranger)).map((c) => c.id)).toContain(global.id);
  });

  it('name uniqueness per (name, scope, owner) — the shadowing precondition', async () => {
    const d = deps();
    await createCredential(d, owner, input());
    await expect(createCredential(d, owner, input())).rejects.toMatchObject({
      statusCode: 409,
      code: 'CREDENTIAL_NAME_TAKEN',
    });
    // Same name in ANOTHER owner's namespace, and in the global namespace,
    // are both fine — personal names shadow same-named globals at resolution.
    await expect(createCredential(d, stranger, input())).resolves.toBeTruthy();
    const global = await createCredential(d, admin, input({ scope: 'global' }));
    const resolved = await findCredentialForOwner(d.uow, 'k', owner.userId);
    expect(resolved?.id).not.toBe(global.id); // owner's personal wins
    expect((await findCredentialForOwner(d.uow, 'k', null))?.id).toBe(global.id);

    // Rename collision inside one namespace 409s; renaming a row to its own
    // name is a no-op pass (the exceptId arm).
    const other = await createCredential(d, admin, input({ scope: 'global', name: 'g2' }));
    await expect(updateCredential(d, admin, other.id, { name: 'k' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'CREDENTIAL_NAME_TAKEN',
    });
    await expect(updateCredential(d, admin, other.id, { name: 'g2' })).resolves.toBeTruthy();
  });
});

describe('svc credentials — distributable gates (Phase 8 C2)', () => {
  it('personal is always distributable; global defaults to locked, opts in', async () => {
    const d = deps();
    const personal = await createCredential(d, owner, input({ distributable: false }));
    expect(personal.distributable).toBe(true); // input flag ignored for personal
    const locked = await createCredential(d, admin, input({ scope: 'global', name: 'g1' }));
    expect(locked.distributable).toBe(false);
    const open = await createCredential(
      d,
      admin,
      input({ scope: 'global', name: 'g2', distributable: true }),
    );
    expect(open.distributable).toBe(true);

    // PATCH: distributable applies to global rows only.
    await expect(
      updateCredential(d, owner, personal.id, { distributable: false }),
    ).resolves.toMatchObject({ distributable: true });
    await expect(
      updateCredential(d, admin, locked.id, { distributable: true }),
    ).resolves.toMatchObject({ distributable: true });
  });
});

describe('svc credentials — encryption at rest', () => {
  it('stores AES-GCM ciphertext; the preview decrypts for masking only', async () => {
    const d = deps();
    const created = await createCredential(d, owner, input());
    expect(created.secret).not.toContain('sk-plaintext');
    expect(decryptSecret(created.secret, d.credentialEncryptionKey)).toBe('sk-plaintext');
    expect(credentialSecretPreview(d, created)).toBe('sk-…ext');

    const rotated = await updateCredential(d, owner, created.id, { secret: 'sk-next-value' });
    expect(decryptSecret(rotated.secret, d.credentialEncryptionKey)).toBe('sk-next-value');
  });
});
