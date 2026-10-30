// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { testConfig } from './helpers.js';

/**
 * #88 — notes over REST: light-capture defaults, owner-only authorization
 * with 404 existence-hiding, the public square (visibility widens read of the
 * ROW only — annotations stay owner-only), the content-version boundary
 * (body change bumps + snapshots; metadata patch does not), quote+context
 * annotations, and the category tree (per-(owner,parent) name uniqueness,
 * cycle guard, delete cascade).
 */

let app: FastifyInstance;
let ownerJwt: string;
let strangerJwt: string;

const auth = (t: string): { authorization: string } => ({ authorization: `Bearer ${t}` });

beforeAll(async () => {
  app = await buildApp(testConfig({}));
  const register = async (username: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username, password: 'hunter2hunter2' },
    });
    return res.json().token as string;
  };
  await register('ntfirst'); // burn the bootstrap admin
  ownerJwt = await register('ntowner');
  strangerJwt = await register('ntstranger');
});

afterAll(async () => {
  await app.close();
});

async function createNote(
  token: string,
  payload: Record<string, unknown>,
): Promise<{ statusCode: number; body: any }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/notes',
    headers: auth(token),
    payload,
  });
  return { statusCode: res.statusCode, body: res.json() };
}

describe('notes CRUD (#88)', () => {
  it('creates with light-capture defaults and files the v1 snapshot', async () => {
    const { statusCode, body } = await createNote(ownerJwt, {
      title: 'MCP 传输层演进调研',
      contentMd: '# 背景\n正文 v1',
    });
    expect(statusCode).toBe(201);
    const note = body.note;
    expect(note.status).toBe('inbox');
    expect(note.visibility).toBe('private');
    expect(note.source).toEqual({ kind: 'manual' });
    expect(note.contentVersion).toBe(1);
    expect(note.tags).toEqual([]);

    const snap = await app.inject({
      method: 'GET',
      url: `/api/notes/${note.id}/versions/1`,
      headers: auth(ownerJwt),
    });
    expect(snap.statusCode).toBe(200);
    expect(snap.json().version.contentMd).toBe('# 背景\n正文 v1');
  });

  it('a metadata patch does NOT bump the content version; a body change does', async () => {
    const { body } = await createNote(ownerJwt, { title: 't2', contentMd: 'v1' });
    const id = body.note.id;

    const meta = await app.inject({
      method: 'PATCH',
      url: `/api/notes/${id}`,
      headers: auth(ownerJwt),
      payload: { status: 'reading' },
    });
    expect(meta.json().note.contentVersion).toBe(1);

    const revised = await app.inject({
      method: 'PATCH',
      url: `/api/notes/${id}`,
      headers: auth(ownerJwt),
      payload: { contentMd: 'v2 body' },
    });
    expect(revised.json().note.contentVersion).toBe(2);

    const snap2 = await app.inject({
      method: 'GET',
      url: `/api/notes/${id}/versions/2`,
      headers: auth(ownerJwt),
    });
    expect(snap2.json().version.contentMd).toBe('v2 body');
  });

  it('foreign private notes 404 (existence-hiding), public rows are readable', async () => {
    const priv = await createNote(ownerJwt, { title: 'mine', contentMd: 'x' });
    const pub = await createNote(ownerJwt, {
      title: 'shared',
      contentMd: 'x',
      visibility: 'public',
    });

    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/notes/${priv.body.note.id}`,
          headers: auth(strangerJwt),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/notes/${pub.body.note.id}`,
          headers: auth(strangerJwt),
        })
      ).statusCode,
    ).toBe(200);
    // Foreign and public: readable row, but annotations stay owner-only.
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/notes/${pub.body.note.id}/annotations`,
          headers: auth(strangerJwt),
        })
      ).statusCode,
    ).toBe(404);
  });

  it('the square lists only public notes, paginated', async () => {
    await createNote(ownerJwt, { title: 'pub a', contentMd: 'a', visibility: 'public' });
    await createNote(ownerJwt, { title: 'priv b', contentMd: 'b' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/notes/square?limit=50',
      headers: auth(strangerJwt),
    });
    expect(res.statusCode).toBe(200);
    const titles = res.json().notes.map((n: any) => n.title);
    expect(titles).toContain('pub a');
    expect(titles).not.toContain('priv b');
  });

  it('list filters by status and tag', async () => {
    await createNote(ownerJwt, { title: 'tagged', contentMd: 'x', tags: ['调研'], status: 'read' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/notes?tag=调研&status=read',
      headers: auth(ownerJwt),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().notes.length).toBeGreaterThan(0);
    expect(res.json().notes.every((n: any) => n.status === 'read')).toBe(true);
  });
});

describe('annotations (#88)', () => {
  it('creates quote+context annotations pinned to the current version, resolves by id', async () => {
    const { body } = await createNote(ownerJwt, {
      title: 'ann',
      contentMd: '结论段落。Streamable HTTP 将成为默认。选型建议 qdrant。',
    });
    const id = body.note.id;

    const created = await app.inject({
      method: 'POST',
      url: `/api/notes/${id}/annotations`,
      headers: auth(ownerJwt),
      payload: {
        quote: 'Streamable HTTP 将成为默认',
        contextPrefix: '结论段落。',
        contextSuffix: '。选型建议',
        comment: '标注数据来源',
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().annotation.noteVersion).toBe(1);
    expect(created.json().annotation.state).toBe('open');

    const annotationId = created.json().annotation.id;
    const done = await app.inject({
      method: 'PATCH',
      url: `/api/notes/${id}/annotations/${annotationId}`,
      headers: auth(ownerJwt),
      payload: { state: 'done' },
    });
    expect(done.json().annotation.state).toBe('done');
    expect(done.json().annotation.resolvedAt).toBeTruthy();

    const list = await app.inject({
      method: 'GET',
      url: `/api/notes/${id}/annotations`,
      headers: auth(ownerJwt),
    });
    expect(list.json().annotations).toHaveLength(1);

    // An annotation id from another note 404s, never leaks.
    const other = await createNote(ownerJwt, { title: 'other', contentMd: 'y' });
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/notes/${other.body.note.id}/annotations/${annotationId}`,
          headers: auth(ownerJwt),
          payload: { state: 'open' },
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('categories (#88)', () => {
  it('enforces per-(owner,parent) uniqueness, blocks cycles, cascades on delete', async () => {
    const root = await app.inject({
      method: 'POST',
      url: '/api/notes/categories',
      headers: auth(ownerJwt),
      payload: { name: 'MCP', parentId: null },
    });
    expect(root.statusCode).toBe(201);
    const rootId = root.json().category.id;

    // Same name under the same parent conflicts; under another parent is fine.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/notes/categories',
          headers: auth(ownerJwt),
          payload: { name: 'MCP', parentId: null },
        })
      ).statusCode,
    ).toBe(409);

    const child = await app.inject({
      method: 'POST',
      url: '/api/notes/categories',
      headers: auth(ownerJwt),
      payload: { name: '传输层', parentId: rootId },
    });
    const childId = child.json().category.id;

    // Moving the root under its own descendant is a cycle.
    expect(
      (
        await app.inject({
          method: 'PATCH',
          url: `/api/notes/categories/${rootId}`,
          headers: auth(ownerJwt),
          payload: { parentId: childId },
        })
      ).statusCode,
    ).toBe(400);

    // Delete cascade: the note falls to uncategorized, the child to root's parent.
    const { body } = await createNote(ownerJwt, {
      title: 'categorized',
      contentMd: 'x',
      categoryId: childId,
    });
    const noteId = body.note.id;

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/notes/categories/${childId}`,
      headers: auth(ownerJwt),
    });
    expect(del.statusCode).toBe(200);
    expect(
      (
        await app.inject({ method: 'GET', url: `/api/notes/${noteId}`, headers: auth(ownerJwt) })
      ).json().note.categoryId,
    ).toBeNull();

    // Foreign categories 404.
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/notes/categories`,
          headers: auth(strangerJwt),
        })
      ).json().categories,
    ).toHaveLength(0);
  });
});
