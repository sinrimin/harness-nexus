// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { testConfig } from './helpers.js';

/**
 * #21 — auth hardening: rate-limited login/register, no username enumeration
 * (dummy argon2 on the unknown path; disabled-status only after a successful
 * verify), and a race-free bootstrap-admin pick under concurrent registration.
 */

const PASSWORD = 'hunter2hunter2';

describe('login hardening (#21)', () => {
  it('throttles repeated failures with 429', async () => {
    const app = await buildApp(testConfig());
    let saw429 = false;
    let saw401 = false;
    for (let i = 0; i < 12; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'ghost', password: 'wrong-wrong-wrong' },
      });
      if (res.statusCode === 429) saw429 = true;
      if (res.statusCode === 401) saw401 = true;
    }
    expect(saw401).toBe(true);
    expect(saw429).toBe(true);
    await app.close();
  });

  it('reveals a disabled account only to callers holding the password', async () => {
    const app = await buildApp(testConfig());
    await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'sleeper', password: PASSWORD },
    });
    const user = await app.uow.users.findByUsername('sleeper');
    await app.uow.users.save({ ...user!, status: 'disabled' });

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'sleeper', password: 'wrong-wrong-wrong' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error).toBe('INVALID_CREDENTIALS');

    // This fresh app's login budget is untouched by the wrong-password call.
    const right = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'sleeper', password: PASSWORD },
    });
    expect(right.statusCode).toBe(403);
    expect(right.json().error).toBe('ACCOUNT_DISABLED');
    await app.close();
  });

  it('picks exactly one bootstrap admin under concurrent registration', async () => {
    const app = await buildApp(testConfig());
    const results = await Promise.all(
      ['racer-a', 'racer-b', 'racer-c'].map((username) =>
        app
          .inject({
            method: 'POST',
            url: '/api/auth/register',
            payload: { username, password: PASSWORD },
          })
          .then((r) => r.statusCode),
      ),
    );
    expect(results.every((c) => c === 201)).toBe(true);
    const admins = (await app.uow.users.list()).filter((u) => u.role === 'admin');
    expect(admins).toHaveLength(1);
    await app.close();
  });
});
