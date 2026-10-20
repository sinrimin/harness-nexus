// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import { createJwtService } from '../src/infra/jwt.js';
import type { AuthDeps } from '../src/services/auth.js';
import { getCurrentUser, loginUser, registerUser } from '../src/services/auth.js';
import type { Principal } from '../src/services/principal.js';

/**
 * #53 slice 10 — the auth service, tested DIRECTLY against the memory driver
 * (no HTTP, anonymous flows take no principal). Route tests pin the wire
 * end-to-end; these assert the DECISIONS at the shared door: the registration
 * switch, the first-user bootstrap admin, and the #21 login hardening.
 */

function deps(): AuthDeps {
  return {
    uow: createMemoryUnitOfWork(),
    jwt: createJwtService({
      secret: 'test-secret-0123456789abcdef',
      issuer: 'harness-nexus-test',
      accessTtl: '15m',
    }),
  };
}

const register = (over: Record<string, unknown> = {}) =>
  ({ username: 'alice', password: 'correct-horse-battery', ...over }) as Parameters<
    typeof registerUser
  >[1];

describe('svc auth — register decisions', () => {
  it('the first user bootstraps as admin; the next registers as user', async () => {
    const d = deps();
    const first = await registerUser(d, register({ username: 'first' }));
    expect(first.user.role).toBe('admin');
    expect(first.user.status).toBe('active');
    const second = await registerUser(d, register({ username: 'second' }));
    expect(second.user.role).toBe('user');
  });

  it('respects SystemSettings.allowRegistration and username uniqueness', async () => {
    const d = deps();
    await registerUser(d, register());
    await expect(registerUser(d, register())).rejects.toMatchObject({
      statusCode: 409,
      code: 'USERNAME_TAKEN',
    });
    await d.uow.settings.save({ allowRegistration: false, updatedAt: new Date().toISOString() });
    await expect(registerUser(d, register({ username: 'bob' }))).rejects.toMatchObject({
      statusCode: 403,
      code: 'REGISTRATION_DISABLED',
    });
  });

  it('returns a verifiable access token minted by the deps-provided jwt', async () => {
    const d = deps();
    const { user, token } = await registerUser(d, register());
    const payload = await d.jwt.verifyAccessToken(token);
    expect(payload.sub).toBe(user.id);
    expect(payload.role).toBe('admin');
  });
});

describe('svc auth — login hardening (#21)', () => {
  it('rejects unknown usernames and wrong passwords identically (401)', async () => {
    const d = deps();
    await registerUser(d, register());
    for (const bad of [
      { username: 'ghost', password: 'correct-horse-battery' }, // unknown user burns the dummy hash
      { username: 'alice', password: 'wrong-password' },
    ]) {
      await expect(
        loginUser(d, bad as { username: string; password: string }),
      ).rejects.toMatchObject({ statusCode: 401, code: 'INVALID_CREDENTIALS' });
    }
  });

  it('reveals a disabled account only AFTER password verification (403)', async () => {
    const d = deps();
    const { user } = await registerUser(d, register());
    // Wrong password on a disabled account still answers 401, not 403.
    await d.uow.users.save({ ...user, status: 'disabled' });
    await expect(loginUser(d, { username: 'alice', password: 'nope' })).rejects.toMatchObject({
      statusCode: 401,
    });
    await expect(
      loginUser(d, { username: 'alice', password: 'correct-horse-battery' }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'ACCOUNT_DISABLED' });
  });

  it('happy login returns the row + a token for it', async () => {
    const d = deps();
    const registered = await registerUser(d, register());
    const logged = await loginUser(d, {
      username: 'alice',
      password: 'correct-horse-battery',
    });
    expect(logged.user.id).toBe(registered.user.id);
    expect(await d.jwt.verifyAccessToken(logged.token)).toMatchObject({ sub: logged.user.id });
  });
});

describe('svc auth — current user', () => {
  it('404s a principal whose row vanished', async () => {
    const d = deps();
    const ghost: Principal = { userId: 'u-ghost', role: 'user' };
    await expect(getCurrentUser({ uow: d.uow }, ghost)).rejects.toMatchObject({
      statusCode: 404,
      code: 'USER_NOT_FOUND',
    });
    const { user } = await registerUser(d, register());
    await expect(
      getCurrentUser({ uow: d.uow }, { userId: user.id, role: user.role }),
    ).resolves.toMatchObject({ id: user.id });
  });
});
