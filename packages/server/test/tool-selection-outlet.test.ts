// SPDX-FileCopyrightText: 2026 sinromium
//
// SPDX-License-Identifier: MIT

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Server as HttpServer } from 'node:http';
import { createServer } from 'node:http';
import { UpstreamPool } from '@harness-nexus/mcp-runtime';
import { buildApp } from '../src/app.js';
import { NOTES_TOOL_PREFIX } from '../src/mcp/notes-tools.js';
import { testConfig, waitFor } from './helpers.js';

/**
 * Per-tool selection on profile mcp entries (#113) — the outlet contract,
 * end-to-end over `/mcp?profile=` with a minimal fake streamable-HTTP
 * upstream (initialize / tools/list / tools/call — enough for the SDK client
 * to connect and cache three tools):
 *
 *   - whole-server entry  → every live tool of that upstream;
 *   - pinned entry        → the intersection only, and CALLS outside the set
 *                           fail with the ordinary unknown-tool error (the
 *                           allow-set is enforced at call time too — the pool
 *                           spans tenants; listing was never a boundary);
 *   - builtin entry       → the notes tools under the same semantics;
 *   - zero mcp entries    → NO pooled tools (entries define the surface; the
 *                           old full-pool fallback is gone — behavior change
 *                           pinned here deliberately).
 */

let app: FastifyInstance;
let upstream: HttpServer;
let jwt: string;
let serverRowId: string;
let serverNamespace: string;

let pAll: string;
let pPin: string;
let pBuiltinAll: string;
let pBuiltinPin: string;
let pEmpty: string;

const TOOL_NAMES = ['alpha', 'beta', 'gamma'];
const authed = (token: string): { authorization: string } => ({
  authorization: `Bearer ${token}`,
});

/** A minimal streamable-HTTP MCP upstream: three tools, echoing calls. */
function startFakeUpstream(): Promise<HttpServer> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => {
      let msg: {
        id?: number;
        method?: string;
        params?: { protocolVersion?: string; name?: string };
      };
      try {
        msg = JSON.parse(body);
      } catch {
        res.writeHead(400).end();
        return;
      }
      // Notifications (no id) get the 202 ack.
      if (msg.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const reply = (result: object): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      };
      if (msg.method === 'initialize') {
        reply({
          protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'fake-upstream', version: '0' },
        });
      } else if (msg.method === 'tools/list') {
        reply({
          tools: TOOL_NAMES.map((name) => ({
            name,
            description: `tool ${name}`,
            inputSchema: { type: 'object', properties: {} },
          })),
        });
      } else if (msg.method === 'tools/call') {
        reply({ content: [{ type: 'text', text: `${msg.params?.name} ok` }] });
      } else {
        reply({});
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** The SDK transport may answer a request as SSE (`event: message`) instead
 * of bare JSON even under a dual Accept — parse either shape. */
function parseRpcBody(body: string): Record<string, unknown> {
  if (body.startsWith('event:')) {
    const data = body
      .split('\n')
      .find((l) => l.startsWith('data:'))
      ?.slice(5)
      .trim();
    return JSON.parse(data ?? '{}');
  }
  return JSON.parse(body);
}

/** JSON-RPC over the outlet; returns the parsed body. */
async function rpc(
  profileId: string,
  sessionId: string,
  method: string,
  params?: object,
): Promise<Record<string, unknown>> {
  const res = await app.inject({
    method: 'POST',
    url: `/mcp?profile=${profileId}`,
    headers: {
      ...authed(jwt),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': sessionId,
    },
    payload: { jsonrpc: '2.0', id: 7, method, ...(params ? { params } : {}) },
  });
  expect(res.statusCode).toBe(200);
  return parseRpcBody(res.body);
}

/** initialize → session id; then tools/list names. */
async function openSession(profileId: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/mcp?profile=${profileId}`,
    headers: {
      ...authed(jwt),
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    payload: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'tool-selection-test', version: '0' },
      },
    },
  });
  expect(res.statusCode).toBe(200);
  const sid = res.headers['mcp-session-id'];
  return typeof sid === 'string' ? sid : '';
}

async function listToolNames(profileId: string): Promise<string[]> {
  const sid = await openSession(profileId);
  const body = await rpc(profileId, sid, 'tools/list');
  const result = body.result as { tools: { name: string }[] } | undefined;
  return (result?.tools ?? []).map((t) => t.name);
}

beforeAll(async () => {
  app = await buildApp(testConfig());
  await app.listen({ port: 0, host: '127.0.0.1' });

  upstream = await startFakeUpstream();
  const addr = upstream.address();
  if (typeof addr !== 'object' || addr === null) throw new Error('no upstream port');
  const upstreamUrl = `http://127.0.0.1:${addr.port}/mcp`;

  const reg = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { username: 'root', password: 'hunter2hunter2' },
  });
  jwt = reg.json().token;

  // The pooled upstream (server-dialed, global → visible to every profile).
  const created = await app.inject({
    method: 'POST',
    url: '/api/mcp-servers',
    headers: authed(jwt),
    payload: {
      name: 'pinnedupstream',
      transport: { type: 'streamable-http', url: upstreamUrl },
      dialSite: 'server',
      scope: 'global',
    },
  });
  expect(created.statusCode).toBe(201);
  serverRowId = created.json().mcpServer.id;
  serverNamespace = 'pinnedupstream__';

  // Wait for the fire-and-forget pool reload to connect it.
  await waitFor(async () => {
    const statuses = await app.inject({
      method: 'GET',
      url: '/api/mcp-servers/status',
      headers: authed(jwt),
    });
    return (
      (statuses.json().statuses as { id: string; status: string }[])?.find(
        (s) => s.id === serverRowId,
      )?.status === 'connected'
    );
  });

  // The five profiles spanning the matrix. Global scope (root is admin).
  const mk = async (name: string, entries: object[]): Promise<string> => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/profiles',
      headers: authed(jwt),
      payload: { name, target: 'claude-code', scope: 'global', entries },
    });
    expect(res.statusCode).toBe(201);
    return res.json().profile.id;
  };
  pAll = await mk('sel-all', [{ mcpServerId: serverRowId }]);
  pPin = await mk('sel-pin', [{ mcpServerId: serverRowId, tools: ['alpha'] }]);
  pBuiltinAll = await mk('sel-builtin-all', [{ mcpServerId: 'builtin' }]);
  pBuiltinPin = await mk('sel-builtin-pin', [{ mcpServerId: 'builtin', tools: ['notes__search'] }]);
  pEmpty = await mk('sel-empty', []);
}, 30000);

afterAll(async () => {
  await app?.close();
  upstream?.close();
});

describe('per-tool selection over the outlet (#113)', () => {
  it('whole-server entry lists every upstream tool', async () => {
    const names = await listToolNames(pAll);
    for (const t of TOOL_NAMES) expect(names).toContain(serverNamespace + t);
  });

  it('pinned entry lists the intersection only', async () => {
    const names = await listToolNames(pPin);
    expect(names).toContain(serverNamespace + 'alpha');
    expect(names).not.toContain(serverNamespace + 'beta');
    expect(names).not.toContain(serverNamespace + 'gamma');
  });

  it('pinned entry can CALL an in-set tool', async () => {
    const sid = await openSession(pPin);
    const body = await rpc(pPin, sid, 'tools/call', {
      name: serverNamespace + 'alpha',
      arguments: {},
    });
    const result = body.result as { content: { text: string }[] };
    // The pool strips the namespace — the upstream sees its OWN tool name.
    expect(result.content[0].text).toBe('alpha ok');
  });

  it('CALLS outside the allow-set fail as unknown tools (call-side enforcement)', async () => {
    const sid = await openSession(pPin);
    const body = await rpc(pPin, sid, 'tools/call', {
      name: serverNamespace + 'beta',
      arguments: {},
    });
    // The pool rejects with the SAME unknown-tool error a genuinely-unknown
    // tool gets — membership is not leakable from the error shape.
    const text =
      (body.error as { message?: string } | undefined)?.message ??
      (body.result as { content?: { text: string }[] } | undefined)?.content?.[0]?.text ??
      '';
    expect(text).toContain('tool not found');
  });

  it('a zero-entry profile exposes NO pooled tools (entries define the surface)', async () => {
    const names = await listToolNames(pEmpty);
    for (const t of TOOL_NAMES) expect(names).not.toContain(serverNamespace + t);
    expect(names.some((n) => n.startsWith(NOTES_TOOL_PREFIX))).toBe(false);
  });

  it('builtin whole-server entry lists the full notes toolset', async () => {
    const names = await listToolNames(pBuiltinAll);
    expect(names.filter((n) => n.startsWith(NOTES_TOOL_PREFIX)).length).toBeGreaterThan(1);
  });

  it('builtin pinned entry lists — and gates calls to — the picked notes tools', async () => {
    const names = await listToolNames(pBuiltinPin);
    expect(names).toContain('notes__search');
    expect(names).not.toContain('notes__get');

    const sid = await openSession(pBuiltinPin);
    const body = await rpc(pBuiltinPin, sid, 'tools/call', { name: 'notes__get', arguments: {} });
    const result = body.result as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('unknown tool notes__get');
  });
});

describe('passthrough selection on the pool itself (#113 — the shim outlet def)', () => {
  // The client shim dials the platform outlet as ONE namespaced upstream and
  // passes a closed-world selection map beside every list/call. The pool
  // enforces the allow-set on the passthrough arm exactly like the local
  // arm: listing intersects with the FULL (already namespaced) names, and a
  // call outside the set dies as the ordinary unknown-tool error.
  let pool: UpstreamPool;

  beforeAll(async () => {
    const addr = upstream.address();
    if (typeof addr !== 'object' || addr === null) throw new Error('no upstream port');
    pool = new UpstreamPool({
      logger: {
        info() {},
        warn() {},
        debug() {},
      },
      clientName: 'passthrough-selection-test',
      clientVersion: '0',
    });
    await pool.sync([
      {
        id: '__outlet__',
        name: 'harness-nexus',
        transport: { type: 'streamable-http', url: `http://127.0.0.1:${addr.port}/mcp` },
        namespaced: true,
      },
    ]);
    await pool.settle();
  });

  afterAll(async () => {
    await pool?.shutdown();
  });

  it('a pinned passthrough lists the intersection and gates calls to it', async () => {
    const pinned = new Map([['__outlet__', new Set(['alpha'])]]);
    expect(pool.listTools(pinned).map((t) => t.name)).toEqual(['alpha']);

    await expect(pool.callTool('alpha', {}, pinned)).resolves.toBeTruthy();
    await expect(pool.callTool('beta', {}, pinned)).rejects.toThrow(
      /upstream not connected or tool unknown/,
    );
  });

  it("'all' keeps the whole passthrough surface (the shim's outlet default)", async () => {
    const all = new Map([['__outlet__', 'all' as const]]);
    expect(
      pool
        .listTools(all)
        .map((t) => t.name)
        .sort(),
    ).toEqual([...TOOL_NAMES].sort());
    await expect(pool.callTool('gamma', {}, all)).resolves.toBeTruthy();
  });
});
