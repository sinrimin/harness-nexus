// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { testConfig } from './helpers.js';

/**
 * #80 slice 3 — the /mcp outlet exposes the caller's visible API tools as a
 * virtual namespace (`api__<service>__<tool>`): listed alongside the
 * profile's pooled upstreams, called through the SAME runtime
 * (allowlist/envelope/caps) the assistant uses, and invisible to other
 * users' sessions.
 */

let app: FastifyInstance;
let aliceJwt: string;
let bobJwt: string;
let aliceProfileId: string;
let bobProfileId: string;

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
  // Streamable HTTP may answer JSON or an SSE frame (`event: message` +
  // `data: <json>`); normalize both.
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

  const register = async (username: string) =>
    (
      await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username, password: 'hunter2hunter2' },
      })
    ).json().token as string;
  const adminJwt = await register('root'); // first = admin
  const alice = await register('alice');
  const bob = await register('bobout');
  aliceJwt = alice;
  bobJwt = bob;

  const mkProfile = async (token: string, name: string) =>
    (
      await app.inject({
        method: 'POST',
        url: '/api/profiles',
        headers: authed(token),
        payload: { name, target: 'generic', scope: 'personal', entries: [] },
      })
    ).json().profile.id as string;
  aliceProfileId = await mkProfile(aliceJwt, 'alice-kit');
  bobProfileId = await mkProfile(bobJwt, 'bob-kit');

  // A REAL loopback upstream + the internal-flagged allowlist entry.
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end('{"code":0,"body":{"temp":21}}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.close();
  });

  await app.inject({
    method: 'PUT',
    url: '/api/settings/api-tool-outbound',
    headers: authed(adminJwt),
    payload: { mode: 'deny', rules: { external: [], internal: ['127.0.0.1'] } },
  });
  await app.inject({
    method: 'POST',
    url: '/api/api-tools',
    headers: authed(aliceJwt),
    payload: {
      bundle: {
        version: 1,
        name: 'weather',
        baseUrl: `http://127.0.0.1:${port}`,
        headers: {},
        tools: [
          {
            name: 'get_forecast',
            description: 'Forecast for one city',
            method: 'GET',
            path: '/v1/forecast',
            params: [{ name: 'city', in: 'query', type: 'string', required: true }],
            envelope: {
              codeField: 'code',
              success: [0],
              payloadField: 'body',
              errorFields: ['message'],
            },
          },
        ],
      },
    },
  });
});

describe('API tools on the /mcp outlet (#80 slice 3)', () => {
  it("lists and calls the caller's API tools; other users never see them", async () => {
    const init = await rpc(aliceJwt, aliceProfileId, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'api-outlet-test', version: '0' },
    });
    expect(init.status).toBe(200);
    const sessionId = init.sessionId!;
    expect(sessionId).toBeTruthy();

    const listed = await rpc(aliceJwt, aliceProfileId, 'tools/list', {}, sessionId);
    const tools =
      (
        listed.body as {
          result?: { tools?: { name: string; inputSchema?: { required?: string[] } }[] };
        }
      ).result?.tools ?? [];
    const api = tools.find((t) => t.name === 'api__weather__get_forecast');
    expect(api).toBeDefined();
    expect(api!.inputSchema?.required).toEqual(['city']);

    const called = await rpc(
      aliceJwt,
      aliceProfileId,
      'tools/call',
      { name: 'api__weather__get_forecast', arguments: { city: 'Oslo' } },
      sessionId,
    );
    const callResult = (
      called.body as { result?: { content?: { type: string; text: string }[]; isError?: boolean } }
    ).result;
    expect(callResult?.isError).toBeUndefined();
    expect(callResult?.content?.[0]?.text).toContain('"temp": 21');

    // Bob's own session sees none of alice's personal tools.
    const bobInit = await rpc(bobJwt, bobProfileId, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'api-outlet-test-bob', version: '0' },
    });
    const bobListed = await rpc(bobJwt, bobProfileId, 'tools/list', {}, bobInit.sessionId!);
    const bobTools =
      (bobListed.body as { result?: { tools?: { name: string }[] } }).result?.tools ?? [];
    expect(bobTools.some((t) => t.name.startsWith('api__'))).toBe(false);
  });
});
