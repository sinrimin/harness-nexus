// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { appendServerTools, serverToolsFetch } from '../src/assistant/provider.js';

/**
 * #56 — the serverTools append semantics. The #51-era mapping rode
 * `samplingParams.tools`, which pi-ai merges LAST over the converted client
 * tools (Object.assign) — a replace that stripped the agent's own tools on
 * every turn. These tests pin the replacement: append into the wire body's
 * tools array via the fetch seam, never touch non-chat requests, and the
 * anthropic wire carries the Bailian compat shape (web_search name + the
 * cc_entrypoint billing marker system block — without it Bailian's gateway
 * silently skips web search).
 */

const RESPONSES_BODY = {
  model: 'qwen3.8-max',
  input: [{ role: 'user', content: 'hi' }],
  tools: [{ type: 'function', name: 'read_skill' }],
  stream: true,
};

const ANTHROPIC_BODY = {
  model: 'deepseek-v4.1-flash',
  messages: [{ role: 'user', content: 'hi' }],
  system: [{ type: 'text', text: 'You are the platform assistant.' }],
  max_tokens: 1024,
};

describe('appendServerTools — pure body surgery', () => {
  it('APPENDS after existing client tools on the responses wire (the #51 replace defect)', () => {
    const next = appendServerTools(RESPONSES_BODY, ['web_search'], 'openai-responses') as {
      tools: Array<{ type: string; name?: string }>;
    };
    expect(next.tools).toEqual([
      { type: 'function', name: 'read_skill' }, // the agent's own tool SURVIVES
      { type: 'web_search' }, // bare entry — no name on this wire
    ]);
  });

  it('anthropic wire: web_search* gains name + the billing marker leads the system blocks', () => {
    const next = appendServerTools(ANTHROPIC_BODY, ['web_search_20250305'], 'anthropic') as {
      tools: Array<{ type: string; name?: string }>;
      system: Array<{ type: string; text: string }>;
    };
    expect(next.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search' }]);
    expect(next.system[0]).toEqual({
      type: 'text',
      text: 'x-anthropic-billing-header: cc_entrypoint=cli;',
    });
    expect(next.system[1]).toEqual(ANTHROPIC_BODY.system[0]); // prompt intact
  });

  it('anthropic wire: normalizes a plain-string system and creates one when absent', () => {
    const stringSystem = appendServerTools(
      { model: 'm', messages: [], system: 'plain prompt' },
      ['web_search_20250305'],
      'anthropic',
    ) as { system: Array<{ type: string; text: string }> };
    expect(stringSystem.system.map((b) => b.text)).toEqual([
      'x-anthropic-billing-header: cc_entrypoint=cli;',
      'plain prompt',
    ]);
    const noSystem = appendServerTools(
      { model: 'm', messages: [] },
      ['web_search_20250305'],
      'anthropic',
    ) as { system: Array<{ type: string; text: string }> };
    expect(noSystem.system).toHaveLength(1);
  });

  it('creates the tools array when the body has none', () => {
    const next = appendServerTools(
      { model: 'claude-x', messages: [], max_tokens: 1024 },
      ['web_search_20250305'],
      'anthropic',
    ) as { tools: Array<{ type: string; name?: string }> };
    expect(next.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search' }]);
  });

  it('leaves non-chat bodies, arrays, and primitives untouched', () => {
    const listing = { object: 'list', data: [{ id: 'm1' }] };
    expect(appendServerTools(listing, ['web_search'], 'openai-responses')).toBe(listing);
    const arr = ['x'];
    expect(appendServerTools(arr, ['web_search'], 'anthropic')).toBe(arr);
    expect(appendServerTools('str', ['web_search'], 'anthropic')).toBe('str');
    expect(appendServerTools(null, ['web_search'], 'anthropic')).toBe(null);
  });
});

describe('serverToolsFetch — the wire seam both pi-ai adapters cross', () => {
  const fakeInner =
    (seen: Array<{ url: unknown; init: RequestInit | undefined }>): typeof globalThis.fetch =>
    async (url, init) => {
      seen.push({ url, init });
      return new Response('{}', { status: 200 });
    };

  it('rewrites a chat POST body and forwards everything else verbatim', async () => {
    const seen: Array<{ url: unknown; init: RequestInit | undefined }> = [];
    const fetch = serverToolsFetch(['web_search'], 'openai-responses', fakeInner(seen));

    await fetch('https://gw.example.com/v1/responses', {
      method: 'POST',
      body: JSON.stringify(RESPONSES_BODY),
    });
    const body = JSON.parse(String(seen[0]!.init!.body)) as {
      tools: Array<{ type: string; name?: string }>;
    };
    expect(body.tools).toHaveLength(2); // client tool + server tool
    expect(body.tools[1]).toEqual({ type: 'web_search' });

    // a models-listing GET never gets a body — passes through untouched
    await fetch('https://gw.example.com/v1/models', { method: 'GET' });
    expect(seen[1]!.init).toEqual({ method: 'GET' });

    // a non-JSON body is passed through byte-identical
    await fetch('https://gw.example.com/other', { method: 'POST', body: 'not-json' });
    expect(seen[2]!.init!.body).toBe('not-json');
  });

  it('keeps a caller-provided inner fetch (the agent runner may inject one)', async () => {
    const seen: Array<{ url: unknown; init: RequestInit | undefined }> = [];
    const wrapped = serverToolsFetch(['web_search'], 'anthropic', fakeInner(seen));
    // compose the way streamFn does: outer wrapper over an inner fetch
    const composed = serverToolsFetch(['code_interpreter'], 'openai-responses', wrapped);
    await composed('https://gw.example.com/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'm', input: [] }),
    });
    const body = JSON.parse(String(seen[0]!.init!.body)) as {
      tools: Array<{ type: string; name?: string }>;
    };
    expect(body.tools).toEqual([
      { type: 'code_interpreter' },
      { type: 'web_search', name: 'web_search' }, // the anthropic layer adds the name
    ]);
  });
});
