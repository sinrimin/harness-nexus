// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { testConfig } from './helpers.js';

/**
 * #88 — the /mcp outlet exposes the caller's own notes library as the
 * `notes__` virtual namespace (the #80 api-tools pattern): listed on every
 * profile session, called through the #53 services with the PAT owner as
 * principal, and strictly per-owner (a foreign private note 404-hides).
 */

let app: FastifyInstance;
let aliceJwt: string;
let bobJwt: string;
let aliceProfileId: string;
let aliceNoteId: string;

const authed = (token: string) => ({ authorization: `Bearer ${token}` });

async function rpc(
  token: string,
  profileId: string,
  method: string,
  params: unknown,
  sessionId?: string,
): Promise<{ status: number; body: unknown; sessionId?: string }> {
  const res = await app.inject({
    method: 'POST',
    url: `/mcp?profile=${profileId}`,
    headers: {
      ...authed(token),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId !== undefined ? { 'mcp-session-id': sessionId } : {}),
    },
    payload: { jsonrpc: '2.0', id: Math.floor(Math.random() * 10_000), method, params },
  });
  let body: unknown;
  const text = res.body;
  if (text.startsWith('event:') || text.startsWith('data:')) {
    const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
    body = dataLine !== undefined ? (JSON.parse(dataLine.slice(5).trim()) as unknown) : undefined;
  } else if (text.length > 0) {
    body = JSON.parse(text) as unknown;
  }
  return {
    status: res.statusCode,
    body,
    sessionId: res.headers['mcp-session-id'] as string | undefined,
  };
}

beforeAll(async () => {
  app = await buildApp(testConfig({}));
  await app.listen({ port: 0, host: '127.0.0.1' });
  afterAll(async () => {
    await app.close();
  });

  const register = async (username: string) =>
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username, password: 'hunter2hunter2' },
      })
    ).json().token as string;
  await register('root'); // first = admin
  aliceJwt = await register('alice');
  bobJwt = await register('bobo');

  aliceProfileId = (
    await app.inject({
      method: 'POST',
      url: '/api/profiles',
      headers: authed(aliceJwt),
      payload: { name: 'alice-notes-kit', target: 'generic', scope: 'personal', entries: [] },
    })
  ).json().profile.id as string;

  const note = (
    await app.inject({
      method: 'POST',
      url: '/api/notes',
      headers: authed(aliceJwt),
      payload: {
        title: 'MCP 传输层演进调研',
        summary: 'Streamable HTTP 单端点成为主流。',
        contentMd: '正文：Streamable HTTP 将成为默认传输。',
        tags: ['调研', 'MCP'],
        source: { kind: 'manual' },
      },
    })
  ).json().note as { id: string };
  aliceNoteId = note.id;

  await app.inject({
    method: 'POST',
    url: `/api/notes/${aliceNoteId}/annotations`,
    headers: authed(aliceJwt),
    payload: {
      quote: 'Streamable HTTP 将成为默认传输',
      contextPrefix: '正文：',
      contextSuffix: '。',
      comment: '加规范版本号',
    },
  });

  await app.inject({
    method: 'POST',
    url: '/api/notes',
    headers: authed(bobJwt),
    payload: {
      title: 'bob 的私有笔记',
      contentMd: 'bob secret body',
      source: { kind: 'manual' },
    },
  });
});

type ToolResult = { result?: { content?: { type: string; text: string }[]; isError?: boolean } };

describe('notes__ tools on the /mcp outlet (#88)', () => {
  it('lists the notes__ namespace on a plain profile session', async () => {
    const init = await rpc(aliceJwt, aliceProfileId, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'notes-outlet-test', version: '0' },
    });
    expect(init.status).toBe(200);
    const sessionId = init.sessionId!;

    const listed = await rpc(aliceJwt, aliceProfileId, 'tools/list', {}, sessionId);
    const tools = (listed.body as { result?: { tools?: { name: string }[] } }).result?.tools ?? [];
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['notes__search', 'notes__get', 'notes__annotations']),
    );
  });

  it('searches and fetches the caller\u2019s own notes over the wire', async () => {
    const init = await rpc(aliceJwt, aliceProfileId, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'notes-outlet-test-2', version: '0' },
    });
    const sessionId = init.sessionId!;

    const searched = await rpc(
      aliceJwt,
      aliceProfileId,
      'tools/call',
      {
        name: 'notes__search',
        arguments: { query: '传输' },
      },
      sessionId,
    );
    const search = searched.body as ToolResult;
    expect(search.result?.isError).toBeUndefined();
    const parsed = JSON.parse(search.result!.content![0]!.text) as {
      results: { id: string; title: string }[];
    };
    expect(parsed.results[0]!.title).toContain('MCP');
    expect(parsed.results[0]!.id).toBe(aliceNoteId);

    const got = await rpc(
      aliceJwt,
      aliceProfileId,
      'tools/call',
      {
        name: 'notes__get',
        arguments: { id: aliceNoteId },
      },
      sessionId,
    );
    expect((got.body as ToolResult).result?.content![0]!.text).toContain(
      'Streamable HTTP 将成为默认传输',
    );

    const annos = await rpc(
      aliceJwt,
      aliceProfileId,
      'tools/call',
      {
        name: 'notes__annotations',
        arguments: { noteId: aliceNoteId },
      },
      sessionId,
    );
    expect((annos.body as ToolResult).result?.content![0]!.text).toContain('加规范版本号');
  });

  it('creates a note over the wire (source=agent), then reads it back', async () => {
    const init = await rpc(aliceJwt, aliceProfileId, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'notes-outlet-create', version: '0' },
    });
    const sessionId = init.sessionId!;
    const created = await rpc(
      aliceJwt,
      aliceProfileId,
      'tools/call',
      {
        name: 'notes__create',
        arguments: {
          title: 'Agent 存的调研',
          contentMd: 'Streamable HTTP 已成主流。',
          tags: ['调研'],
        },
      },
      sessionId,
    );
    const createResult = created.body as ToolResult;
    expect(createResult.result?.isError).toBeUndefined();
    const createdRow = JSON.parse(createResult.result!.content![0]!.text) as { id: string };

    const got = await rpc(
      aliceJwt,
      aliceProfileId,
      'tools/call',
      { name: 'notes__get', arguments: { id: createdRow.id } },
      sessionId,
    );
    expect((got.body as ToolResult).result?.content![0]!.text).toContain(
      'Streamable HTTP 已成主流',
    );

    // The row itself carries source.kind = 'agent' (REST read-back).
    const row = (
      await app.inject({
        method: 'GET',
        url: `/api/notes/${createdRow.id}`,
        headers: authed(aliceJwt),
      })
    ).json().note as { source: { kind: string } };
    expect(row.source.kind).toBe('agent');
  });

  it('updates a note over the wire: diff edit, version gate, re-read refusal', async () => {
    const init = await rpc(aliceJwt, aliceProfileId, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'notes-outlet-update', version: '0' },
    });
    const sessionId = init.sessionId!;

    const stale = await rpc(
      aliceJwt,
      aliceProfileId,
      'tools/call',
      {
        name: 'notes__update',
        arguments: {
          id: aliceNoteId,
          expectVersion: 99,
          edits: [{ oldText: '正文', newText: 'x' }],
        },
      },
      sessionId,
    );
    const staleResult = (stale.body as ToolResult).result;
    expect(staleResult?.isError).toBe(true);
    expect(staleResult?.content![0]!.text).toContain('version mismatch');

    const ok = await rpc(
      aliceJwt,
      aliceProfileId,
      'tools/call',
      {
        name: 'notes__update',
        arguments: {
          id: aliceNoteId,
          expectVersion: 1,
          edits: [
            {
              oldText: 'Streamable HTTP 将成为默认传输',
              newText: 'Streamable HTTP（2025-03-26 规范）将成为默认传输',
            },
          ],
        },
      },
      sessionId,
    );
    const okResult = ok.body as ToolResult;
    expect(okResult.result?.isError).toBeUndefined();
    expect(JSON.parse(okResult.result!.content![0]!.text).contentVersion).toBe(2);
  });

  it('hides another user\u2019s private note (isError, NOTE_NOT_FOUND)', async () => {
    const bobNoteId = (
      (
        await app.inject({
          method: 'GET',
          url: '/api/notes?limit=1',
          headers: authed(bobJwt),
        })
      ).json().notes as { id: string }[]
    )[0]!.id;

    const init = await rpc(aliceJwt, aliceProfileId, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'notes-outlet-test-3', version: '0' },
    });
    const got = await rpc(
      aliceJwt,
      aliceProfileId,
      'tools/call',
      {
        name: 'notes__get',
        arguments: { id: bobNoteId },
      },
      init.sessionId!,
    );
    const result = (got.body as ToolResult).result;
    expect(result?.isError).toBe(true);
    expect(result?.content![0]!.text).toContain('NOTE_NOT_FOUND');
  });
});
