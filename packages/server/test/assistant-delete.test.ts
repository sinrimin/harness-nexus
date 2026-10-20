// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { testConfig } from './helpers.js';

/**
 * #55 — assistant session deletion over REST: the route guards LIVE rows
 * (an open channel would keep writing into deleted storage — close first)
 * and pushes the fresh snapshot to the owner once a delete lands.
 */

let app: FastifyInstance;
let baseUrl: string;
let ownerJwt: string;
let strangerJwt: string;
let assistantId: string;
let browser: Socket;

const auth = (t: string): { authorization: string } => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  app = await buildApp(testConfig({}));
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (typeof address === 'string' || address === null) throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;

  for (const [username, key] of [
    ['delowner', 'ownerJwt'],
    ['delstranger', 'strangerJwt'],
  ] as const) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username, password: 'hunter2hunter2' },
    });
    if (key === 'ownerJwt') ownerJwt = res.json().token;
    else strangerJwt = res.json().token;
  }

  // Seed the config + one idle session row directly (the delete path under
  // test is the ROUTE's guard + push, not the model run).
  const ownerId = (await app.uow.users.findByUsername('delowner'))!.id;
  const now = new Date().toISOString();
  assistantId = 'asst-del-1';
  await app.uow.assistants.save({
    id: assistantId,
    ownerId,
    name: 'Del',
    providerId: 'prov-any',
    defaultModel: 'm',
    enabledToolGroups: [],
    createdAt: now,
    updatedAt: now,
  });
  await app.uow.assistants.saveSession({
    id: 'sess-del-1',
    ownerId,
    assistantId,
    title: 'delete me',
    createdAt: now,
    updatedAt: now,
    lastMessageAt: now,
  });
  await app.uow.assistants.saveSession({
    id: 'sess-del-2',
    ownerId,
    assistantId,
    title: 'idle too',
    createdAt: now,
    updatedAt: now,
    lastMessageAt: now,
  });
});

afterAll(async () => {
  browser?.disconnect();
  await app.close();
});

describe('DELETE /api/assistant-sessions/:id (#55)', () => {
  it('404-hides foreign ids for every role', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/assistant-sessions/sess-del-1',
      headers: auth(strangerJwt),
    });
    expect(res.statusCode).toBe(404);
    expect(await app.uow.assistants.findSessionById('sess-del-1')).not.toBeNull();
  });

  it('refuses a LIVE session (409 ASSISTANT_SESSION_LIVE), deletes once closed', async () => {
    browser = io(`${baseUrl}/app`, { auth: { token: ownerJwt }, transports: ['websocket'] });
    await new Promise<void>((resolve) => browser.on('connect', () => resolve()));

    // Open a live channel on sess-del-2 (#54: no row write, no model — the
    // channel itself is what the guard must see).
    const ack = (await new Promise((resolve) => {
      browser.emit('assistant:session.open', { assistantId, sessionId: 'sess-del-2' }, resolve);
    })) as { sessionId?: string; assistantName?: string; error?: string };
    expect(ack.error).toBeUndefined();
    expect(ack.sessionId).toBe('sess-del-2');

    const refused = await app.inject({
      method: 'DELETE',
      url: '/api/assistant-sessions/sess-del-2',
      headers: auth(ownerJwt),
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('ASSISTANT_SESSION_LIVE');

    await new Promise((resolve) => {
      browser.emit('assistant:session.close', { sessionId: 'sess-del-2', reason: 'user' }, resolve);
    });

    // Now deletable — and the fresh snapshot is PUSHED to the owner.
    const pushed = new Promise<{ sessions: { id: string }[] }>((resolve) => {
      browser.on('assistant:sessions', (payload: { sessions: { id: string }[] }) =>
        resolve(payload),
      );
    });
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/assistant-sessions/sess-del-2',
      headers: auth(ownerJwt),
    });
    expect(res.statusCode).toBe(200);
    expect(await app.uow.assistants.findSessionById('sess-del-2')).toBeNull();
    const snapshot = await pushed;
    expect(snapshot.sessions.map((s) => s.id)).not.toContain('sess-del-2');
    expect(snapshot.sessions.map((s) => s.id)).toContain('sess-del-1');
  });

  it('deletes an idle session outright', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/assistant-sessions/sess-del-1',
      headers: auth(ownerJwt),
    });
    expect(res.statusCode).toBe(200);
    expect(await app.uow.assistants.findSessionById('sess-del-1')).toBeNull();
  });
});
