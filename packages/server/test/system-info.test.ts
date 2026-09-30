import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { serverVersion } from '../src/version.js';
import { testConfig } from './helpers.js';

/** #37 — GET /api/system/info exposes the server build version (auth'd). */
describe('GET /api/system/info', () => {
  it('returns the manifest version for an authenticated caller', async () => {
    const app = await buildApp(testConfig());
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'root', password: 'hunter2hunter2' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/system/info',
      headers: { authorization: `Bearer ${reg.json().token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().version).toBe(serverVersion());
    expect(res.json().version).toMatch(/^\d+\.\d+\.\d+/);
    await app.close();
  });

  it('is anonymous-rejected', async () => {
    const app = await buildApp(testConfig());
    const res = await app.inject({ method: 'GET', url: '/api/system/info' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
