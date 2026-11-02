// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * Issue #110 — session pins: the repo round-trip on BOTH drivers, the
 * owner-only REST door, the orphan GC (one instance's listing never prunes a
 * sibling target's pins) and — the guard the issue exists around — that an
 * EMPTY listing never deletes anything (a failed or degraded daemon listing
 * must not read as "all sessions deleted").
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { testConfig } from './helpers.js';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import { createSqliteUnitOfWork } from '../src/infra/storage/sqlite/index.js';
import type { UnitOfWork } from '@harness-nexus/core';
import { machinePinKey } from '@harness-nexus/shared';
import { gcSessionPins, pinSession, unpinSession } from '../src/services/session-pins.js';
import type { Principal } from '../src/services/principal.js';

const NOW = '2026-11-02T00:00:00.000Z';

/** The sqlite driver enforces the owner FK — seed the users both drivers. */
async function seedUsers(uow: UnitOfWork, ids: string[]): Promise<void> {
  for (const id of ids) {
    await uow.users.save({
      id,
      username: `pin-${id}`,
      email: null,
      passwordHash: null,
      role: 'user',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
}
const PIN_INPUT = {
  axis: 'machine',
  machineId: 'm110',
  target: 'claude-code',
  nativeSessionId: 's-native-1',
} as const;

const principalOf = (userId: string): Principal => ({ userId, role: 'user' });

describe.each([
  ['memory', () => createMemoryUnitOfWork()],
  ['sqlite', () => createSqliteUnitOfWork(':memory:')],
])('session pin repo (%s)', (_name, makeUow) => {
  it('pins, lists newest-pinned first, unpins idempotently', async () => {
    const uow: UnitOfWork = makeUow();
    await seedUsers(uow, ['u1']);
    await uow.sessionPins.save({
      ownerId: 'u1',
      sessionKey: 'assistant/a1',
      pinnedAt: '2026-11-02T00:00:01.000Z',
    });
    await uow.sessionPins.save({
      ownerId: 'u1',
      sessionKey: 'assistant/a2',
      pinnedAt: '2026-11-02T00:00:02.000Z',
    });
    // Re-pinning refreshes pinnedAt (the upsert arm).
    await uow.sessionPins.save({
      ownerId: 'u1',
      sessionKey: 'assistant/a1',
      pinnedAt: '2026-11-02T00:00:03.000Z',
    });
    expect((await uow.sessionPins.listByOwner('u1')).map((p) => p.sessionKey)).toEqual([
      'assistant/a1',
      'assistant/a2',
    ]);
    await uow.sessionPins.delete('u1', 'assistant/a1');
    await uow.sessionPins.delete('u1', 'assistant/a1'); // idempotent
    expect(await uow.sessionPins.listByOwner('u1')).toHaveLength(1);
  });

  it('owner rows never cross', async () => {
    const uow: UnitOfWork = makeUow();
    await seedUsers(uow, ['u1', 'u2']);
    await uow.sessionPins.save({ ownerId: 'u1', sessionKey: 'assistant/a1', pinnedAt: NOW });
    expect(await uow.sessionPins.listByOwner('u2')).toHaveLength(0);
    await uow.sessionPins.delete('u2', 'assistant/a1');
    expect(await uow.sessionPins.listByOwner('u1')).toHaveLength(1);
  });
});

describe('session pin GC (#110)', () => {
  it('prunes orphans under one (machine, target) scope only', async () => {
    const uow = createMemoryUnitOfWork();
    await seedUsers(uow, ['u1', 'u2']);
    const deps = { uow };
    await pinSession(deps, principalOf('u1'), {
      axis: 'machine',
      machineId: 'm1',
      target: 'claude-code',
      nativeSessionId: 'live-1',
    });
    await pinSession(deps, principalOf('u1'), {
      axis: 'machine',
      machineId: 'm1',
      target: 'claude-code',
      nativeSessionId: 'gone-1',
    });
    // A sibling target on the SAME machine, and another owner's pin.
    await pinSession(deps, principalOf('u1'), {
      axis: 'machine',
      machineId: 'm1',
      target: 'opencode',
      nativeSessionId: 'sib-1',
    });
    await pinSession(deps, principalOf('u2'), {
      axis: 'machine',
      machineId: 'm1',
      target: 'claude-code',
      nativeSessionId: 'other-owner',
    });

    await gcSessionPins(deps, 'u1', { kind: 'machine', machineId: 'm1', target: 'claude-code' }, [
      'live-1',
    ]);

    const keys = (await uow.sessionPins.listByOwner('u1')).map((p) => p.sessionKey).sort();
    expect(keys).toEqual(
      [
        machinePinKey('m1', 'claude-code', 'live-1'),
        machinePinKey('m1', 'opencode', 'sib-1'),
      ].sort(),
    );
    expect(await uow.sessionPins.listByOwner('u2')).toHaveLength(1);
  });

  it('the empty-listing guard: an empty listing prunes NOTHING', async () => {
    const uow = createMemoryUnitOfWork();
    const deps = { uow };
    await pinSession(deps, principalOf('u1'), { ...PIN_INPUT });
    await gcSessionPins(
      deps,
      'u1',
      { kind: 'machine', machineId: 'm110', target: 'claude-code' },
      [],
    );
    await gcSessionPins(deps, 'u1', { kind: 'assistant' }, []);
    expect(await uow.sessionPins.listByOwner('u1')).toHaveLength(1);
  });

  it('unpin is idempotent and scoped to the owner', async () => {
    const uow = createMemoryUnitOfWork();
    const deps = { uow };
    await pinSession(deps, principalOf('u1'), { ...PIN_INPUT });
    await unpinSession(deps, principalOf('u2'), { ...PIN_INPUT });
    expect(await uow.sessionPins.listByOwner('u1')).toHaveLength(1);
    await unpinSession(deps, principalOf('u1'), { ...PIN_INPUT });
    await unpinSession(deps, principalOf('u1'), { ...PIN_INPUT });
    expect(await uow.sessionPins.listByOwner('u1')).toHaveLength(0);
  });
});

describe('session pin REST (#110)', () => {
  let app: FastifyInstance;
  let ownerJwt: string;
  let strangerJwt: string;

  const auth = (t: string): { authorization: string } => ({ authorization: `Bearer ${t}` });

  beforeAll(async () => {
    app = await buildApp(testConfig({}));
    for (const [username, key] of [
      ['pinowner', 'ownerJwt'],
      ['pinstranger', 'strangerJwt'],
    ] as const) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username, password: 'hunter2hunter2' },
      });
      if (key === 'ownerJwt') ownerJwt = res.json().token;
      else strangerJwt = res.json().token;
    }
  });

  it('PUT → GET → DELETE round-trip, invisible to other users', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/api/session-pins',
      headers: { ...auth(ownerJwt), 'content-type': 'application/json' },
      payload: { axis: 'assistant', sessionId: 'asst-sess-1' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().pin.sessionKey).toBe('assistant/asst-sess-1');

    const mine = await app.inject({
      method: 'GET',
      url: '/api/session-pins',
      headers: auth(ownerJwt),
    });
    expect(mine.json().pins).toHaveLength(1);
    // Owner-only even for admins: personal rows, no wider scope.
    const theirs = await app.inject({
      method: 'GET',
      url: '/api/session-pins',
      headers: auth(strangerJwt),
    });
    expect(theirs.json().pins).toHaveLength(0);

    const del = await app.inject({
      method: 'DELETE',
      url: '/api/session-pins',
      headers: { ...auth(ownerJwt), 'content-type': 'application/json' },
      payload: { axis: 'assistant', sessionId: 'asst-sess-1' },
    });
    expect(del.statusCode).toBe(200);
    expect(
      (
        await app.inject({ method: 'GET', url: '/api/session-pins', headers: auth(ownerJwt) })
      ).json().pins,
    ).toHaveLength(0);
  });

  it('rejects an unauthenticated call', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/session-pins',
    });
    expect(res.statusCode).toBe(401);
  });

  it('deleting the assistant session drops its pin (no orphan window)', async () => {
    const ownerId = (await app.uow.users.findByUsername('pinowner'))!.id;
    const now = new Date().toISOString();
    await app.uow.assistants.save({
      id: 'asst-pin-1',
      ownerId,
      name: 'Pin',
      providerId: 'prov-any',
      defaultModel: 'm',
      enabledToolGroups: [],
      createdAt: now,
      updatedAt: now,
    });
    await app.uow.assistants.saveSession({
      id: 'asst-sess-2',
      assistantId: 'asst-pin-1',
      ownerId,
      title: 'pinned one',
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
    });

    await app.inject({
      method: 'PUT',
      url: '/api/session-pins',
      headers: { ...auth(ownerJwt), 'content-type': 'application/json' },
      payload: { axis: 'assistant', sessionId: 'asst-sess-2' },
    });
    const del = await app.inject({
      method: 'DELETE',
      url: '/api/assistant-sessions/asst-sess-2',
      headers: auth(ownerJwt),
    });
    expect(del.statusCode).toBe(200);
    const pins = (
      await app.inject({ method: 'GET', url: '/api/session-pins', headers: auth(ownerJwt) })
    ).json().pins as { sessionKey: string }[];
    expect(pins.map((p) => p.sessionKey)).not.toContain('assistant/asst-sess-2');
  });
});
