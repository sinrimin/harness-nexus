// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { testConfig } from './helpers.js';

/**
 * Built-in MCP service (#106) — the platform's own toolset presented as ONE
 * global, non-modifiable service. Load-bearing assertions: the descriptor is
 * separate from the McpServer row set (it must never become pickable), no
 * id-based mutation route can touch `builtin`, and the tools are the notes
 * namespace every /mcp profile session already serves.
 */

describe('built-in MCP service (#106)', () => {
  it('GET /api/mcp-servers/builtin returns the notes toolset as one descriptor', async () => {
    const app = await buildApp(testConfig());
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'hunter2hunter2' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/mcp-servers/builtin',
      headers: { authorization: `Bearer ${reg.json().token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.builtin.id).toBe('builtin');
    expect(body.builtin.tools.map((t: { name: string }) => t.name)).toEqual([
      'notes__search',
      'notes__get',
      'notes__annotations',
      'notes__create',
      'notes__update',
    ]);
    // Every tool carries the description + JSON-Schema the UI panel renders.
    for (const tool of body.builtin.tools) {
      expect(typeof tool.description).toBe('string');
      expect(tool.inputSchema.type).toBe('object');
    }
    await app.close();
  });

  it('requires authentication', async () => {
    const app = await buildApp(testConfig());
    const res = await app.inject({ method: 'GET', url: '/api/mcp-servers/builtin' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('stays out of the McpServer row set (never pickable, never referencable)', async () => {
    const app = await buildApp(testConfig());
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'hunter2hunter2' },
    });
    const list = await app.inject({
      method: 'GET',
      url: '/api/mcp-servers',
      headers: { authorization: `Bearer ${reg.json().token}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().mcpServers).toEqual([]);
    await app.close();
  });

  it('is non-modifiable: id-based mutation routes 404 on it', async () => {
    const app = await buildApp(testConfig());
    const reg = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username: 'alice', password: 'hunter2hunter2' },
    });
    const auth = { authorization: `Bearer ${reg.json().token}` };
    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/mcp-servers/builtin',
      headers: auth,
      payload: { name: 'hijack' },
    });
    expect(patch.statusCode).toBe(404);
    expect(patch.json().error).toBe('MCP_SERVER_NOT_FOUND');
    const del = await app.inject({
      method: 'DELETE',
      url: '/api/mcp-servers/builtin',
      headers: auth,
    });
    expect(del.statusCode).toBe(404);
    await app.close();
  });
});
