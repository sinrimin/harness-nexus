// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { testConfig } from './helpers.js';

/**
 * Profile auto-versioning (#18): create → 0.1; entries change → bump
 * (decimal, carry at 16); name/description-only edits keep the version;
 * client-sent version fields are stripped/ignored.
 */

async function setup() {
  const app = await buildApp(testConfig());
  const reg = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'alice', password: 'hunter2hunter2' },
  });
  const auth = { authorization: `Bearer ${reg.json().token as string}` };
  const seedMcp = async (): Promise<string> =>
    (
      await app.inject({
        method: 'POST',
        url: '/api/mcp-servers',
        headers: auth,
        payload: {
          name: `up-${Math.random().toString(36).slice(2, 8)}`,
          dialSite: 'client',
          scope: 'personal',
          transport: { type: 'streamable-http', url: 'https://x.example.com/mcp' },
        },
      })
    ).json().mcpServer.id as string;
  return { app, auth, seedMcp };
}

describe('profile auto-version', () => {
  it('starts at 0.1, bumps only on entry changes, carries at 16', async () => {
    const { app, auth, seedMcp } = await setup();
    const a = await seedMcp();
    const b = await seedMcp();

    const created = await app.inject({
      method: 'POST',
      url: '/api/profiles',
      headers: auth,
      payload: {
        name: 'P',
        target: 'claude-code',
        scope: 'personal',
        entries: [{ mcpServerId: a }],
      },
    });
    expect(created.statusCode).toBe(201);
    const id: string = created.json().profile.id;
    expect(created.json().profile.version).toBe('0.1');

    // name-only edit: no bump (a client-sent version is also ignored)
    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/profiles/${id}`,
      headers: auth,
      payload: { name: 'P2', description: 'd', version: '9.9.9' },
    });
    expect(renamed.json().profile.version).toBe('0.1');

    // entries change → bump; 15 bumps land at 0.15, the 16th carries to 1.0
    let version = '0.1';
    for (let i = 0; i < 14; i++) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/profiles/${id}`,
        headers: auth,
        payload: { entries: [{ mcpServerId: i % 2 === 0 ? b : a }] },
      });
      version = res.json().profile.version as string;
    }
    expect(version).toBe('0.15');
    const carried = await app.inject({
      method: 'PATCH',
      url: `/api/profiles/${id}`,
      headers: auth,
      payload: { entries: [{ mcpServerId: b }] },
    });
    expect(carried.json().profile.version).toBe('1.0');
    await app.close();
  });
});
