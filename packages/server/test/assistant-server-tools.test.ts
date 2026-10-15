import { describe, expect, it } from 'vitest';
import { appendServerTools, serverToolsFetch } from '../src/assistant/provider.js';

/**
 * #56 — the serverTools append semantics. The #51-era mapping rode
 * `samplingParams.tools`, which pi-ai merges LAST over the converted client
 * tools (Object.assign) — a replace that stripped the agent's own tools on
 * every turn. These tests pin the replacement: append into the wire body's
 * tools array via the fetch seam, never touch non-chat requests.
 */

const RESPONSES_BODY = {
  model: 'qwen3.8-max',
  input: [{ role: 'user', content: 'hi' }],
  tools: [{ type: 'function', name: 'read_skill' }],
  stream: true,
};

describe('appendServerTools — pure body surgery', () => {
  it('APPENDS after existing client tools (the #51 replace defect)', () => {
    const next = appendServerTools(RESPONSES_BODY, ['web_search']) as typeof RESPONSES_BODY & {
      tools: Array<{ type: string; name?: string }>;
    };
    expect(next.tools).toEqual([
      { type: 'function', name: 'read_skill' }, // the agent's own tool SURVIVES
      { type: 'web_search' },
    ]);
  });

  it('creates the tools array when the body has none (anthropic minimal body)', () => {
    const next = appendServerTools({ model: 'claude-x', messages: [], max_tokens: 1024 }, [
      'web_search_20250305',
    ]) as { tools: Array<{ type: string }> };
    expect(next.tools).toEqual([{ type: 'web_search_20250305' }]);
  });

  it('leaves non-chat bodies, arrays, and primitives untouched', () => {
    const listing = { object: 'list', data: [{ id: 'm1' }] };
    expect(appendServerTools(listing, ['web_search'])).toBe(listing);
    const arr = ['x'];
    expect(appendServerTools(arr, ['web_search'])).toBe(arr);
    expect(appendServerTools('str', ['web_search'])).toBe('str');
    expect(appendServerTools(null, ['web_search'])).toBe(null);
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
    const fetch = serverToolsFetch(['web_search'], fakeInner(seen));

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
    const wrapped = serverToolsFetch(['web_search'], fakeInner(seen));
    // compose the way streamFn does: outer wrapper over an inner fetch
    const composed = serverToolsFetch(['code_interpreter'], wrapped);
    await composed('https://gw.example.com/v1/responses', {
      method: 'POST',
      body: JSON.stringify({ model: 'm', input: [] }),
    });
    const body = JSON.parse(String(seen[0]!.init!.body)) as {
      tools: Array<{ type: string }>;
    };
    expect(body.tools).toEqual([{ type: 'code_interpreter' }, { type: 'web_search' }]);
  });
});
