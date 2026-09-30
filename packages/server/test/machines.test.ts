import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { testConfig } from './helpers.js';

/**
 * Machines REST surface (Phase 8 C1): enroll (token shown once), visibility
 * (owner/admin, 404 else), patch, delete, and — critically — machine tokens
 * are rejected by the REST auth hook.
 */

async function setup() {
  const app = await buildApp(testConfig());
  const reg = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'root', password: 'hunter2hunter2' },
  });
  expect(reg.statusCode).toBe(201);
  const token: string = reg.json().token;
  return { app, token, auth: { authorization: `Bearer ${token}` } };
}

describe('POST /api/machines (enroll)', () => {
  it('creates the machine and returns the machine token exactly once', async () => {
    const { app, auth } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/machines',
      headers: auth,
      payload: { name: 'laptop' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.machine.name).toBe('laptop');
    expect(body.machine.online).toBe(false);
    expect(body.machine.remoteChatEnabled).toBe(false);
    expect(body.token).toMatch(/^hnpat_/);

    // The stored PAT carries the machine-ctl scope (REST-rejected).
    const pat = await app.uow.tokens.findById(body.machine.enrollmentPatId);
    expect(pat?.scopes).toEqual(['machine-ctl']);
    await app.close();
  });

  it('requires auth and validates the name', async () => {
    const { app, auth } = await setup();
    const anon = await app.inject({ method: 'POST', url: '/api/machines', payload: { name: 'x' } });
    expect(anon.statusCode).toBe(401);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/machines',
      headers: auth,
      payload: { name: '' },
    });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });
});

describe('machine tokens vs the REST API', () => {
  it('a machine token cannot call the REST API (401)', async () => {
    const { app, auth } = await setup();
    const enroll = await app.inject({
      method: 'POST',
      url: '/api/machines',
      headers: auth,
      payload: { name: 'laptop' },
    });
    const machineToken: string = enroll.json().token;

    const res = await app.inject({
      method: 'GET',
      url: '/api/machines',
      headers: { authorization: `Bearer ${machineToken}` },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('GET/PATCH/DELETE /api/machines', () => {
  it('lists own machines, hides others (404), patches and deletes', async () => {
    const { app, token, auth } = await setup();

    // A second (non-admin) user must not see the first user's machine.
    const reg2 = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'hunter2hunter2' },
    });
    const aliceToken: string = reg2.json().token;
    const aliceAuth = { authorization: `Bearer ${aliceToken}` };

    const enroll = await app.inject({
      method: 'POST',
      url: '/api/machines',
      headers: auth,
      payload: { name: 'laptop' },
    });
    const machine = enroll.json().machine;

    // Owner list shows it; admin sees all (owner IS the bootstrap admin here).
    const list = await app.inject({ method: 'GET', url: '/api/machines', headers: auth });
    expect(list.statusCode).toBe(200);
    expect(list.json().machines).toHaveLength(1);
    expect(list.json().machines[0].online).toBe(false);

    // Alice cannot fetch it by id — 404, not 403 (no existence leak).
    const foreign = await app.inject({
      method: 'GET',
      url: `/api/machines/${machine.id}`,
      headers: aliceAuth,
    });
    expect(foreign.statusCode).toBe(404);

    // Alice's list does not include it.
    const aliceList = await app.inject({ method: 'GET', url: '/api/machines', headers: aliceAuth });
    expect(aliceList.json().machines).toHaveLength(0);

    // Patch: rename + enable remote chat.
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/machines/${machine.id}`,
      headers: auth,
      payload: { name: 'desk', remoteChatEnabled: true },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().machine.name).toBe('desk');
    expect(patched.json().machine.remoteChatEnabled).toBe(true);

    // Delete: row + enrollment PAT gone.
    const gone = await app.inject({
      method: 'DELETE',
      url: `/api/machines/${machine.id}`,
      headers: auth,
    });
    expect(gone.statusCode).toBe(200);
    expect(await app.uow.machines.findById(machine.id)).toBeNull();
    expect(await app.uow.tokens.findById(machine.enrollmentPatId)).toBeNull();
    const after = await app.inject({ method: 'GET', url: '/api/machines', headers: auth });
    expect(after.json().machines).toHaveLength(0);

    // Admin path (#36): an admin is NOT a tenant overseer — alice's machine
    // stays invisible to them in the list AND by id (404, no existence leak).
    const aliceEnroll = await app.inject({
      method: 'POST',
      url: '/api/machines',
      headers: aliceAuth,
      payload: { name: 'alice-laptop' },
    });
    const aliceMachine = aliceEnroll.json().machine;
    const adminList = await app.inject({ method: 'GET', url: '/api/machines', headers: auth });
    expect(adminList.json().machines.map((m: { id: string }) => m.id)).not.toContain(
      aliceMachine.id,
    );
    const adminView = await app.inject({
      method: 'GET',
      url: `/api/machines/${aliceMachine.id}`,
      headers: auth,
    });
    expect(adminView.statusCode).toBe(404);
    void token;
    await app.close();
  });
});
