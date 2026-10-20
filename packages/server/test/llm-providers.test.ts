// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { testConfig } from './helpers.js';
import {
  fetchProviderModels,
  parseProviderModels,
  ProviderModelsError,
} from '../src/infra/provider-models.js';

/**
 * LLM provider management (Phase 9 W10): CRUD scope rules, the credential
 * visibility gate, model-list discovery (STUBBED fetch — tests never touch
 * the network), and the runtime-config PUT's providerId/models arms.
 */

let app: FastifyInstance;
let rootToken: string; // bootstrap admin
let ownerJwt: string;
let strangerJwt: string;
let machineId: string;

const auth = (t: string): { authorization: string } => ({ authorization: `Bearer ${t}` });

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeAll(async () => {
  app = await buildApp(testConfig());
  for (const [username, key] of [
    ['root', 'rootToken'],
    ['owner', 'ownerJwt'],
    ['stranger', 'strangerJwt'],
  ] as const) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username, password: 'hunter2hunter2' },
    });
    if (key === 'rootToken') rootToken = res.json().token;
    if (key === 'ownerJwt') ownerJwt = res.json().token;
    if (key === 'strangerJwt') strangerJwt = res.json().token;
  }

  await app.inject({
    method: 'POST',
    url: '/api/credentials',
    headers: auth(ownerJwt),
    payload: { name: 'gw-key', secret: 'sk-owner-key', scope: 'personal' },
  });
  await app.inject({
    method: 'POST',
    url: '/api/credentials',
    headers: auth(strangerJwt),
    payload: { name: 'stranger-key', secret: 'sk-stranger', scope: 'personal' },
  });
  await app.inject({
    method: 'POST',
    url: '/api/credentials',
    headers: auth(rootToken),
    payload: { name: 'global-key', secret: 'sk-global', scope: 'global', distributable: true },
  });

  const enroll = await app.inject({
    method: 'POST',
    url: '/api/machines',
    headers: auth(ownerJwt),
    payload: { name: 'w10-box' },
  });
  machineId = enroll.json().machine.id;
});

afterAll(async () => {
  await app.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('provider CRUD', () => {
  it('creates a personal provider and lists personal + global to the caller', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/llm-providers',
      headers: auth(ownerJwt),
      payload: {
        name: 'team-gateway',
        api: 'openai-responses',
        baseUrl: 'https://gw.example.com/v1',
        credentialName: 'gw-key',
      },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().provider).toMatchObject({
      name: 'team-gateway',
      api: 'openai-responses',
      scope: 'personal',
      credentialName: 'gw-key',
    });
    expect(JSON.stringify(create.json())).not.toContain('sk-owner-key');

    await app.inject({
      method: 'POST',
      url: '/api/llm-providers',
      headers: auth(rootToken),
      payload: {
        name: 'shared-openai',
        api: 'openai-chat',
        credentialName: 'global-key',
        scope: 'global',
      },
    });

    const list = await app.inject({
      method: 'GET',
      url: '/api/llm-providers',
      headers: auth(ownerJwt),
    });
    expect(list.statusCode).toBe(200);
    const names = list.json().providers.map((p: { name: string }) => p.name);
    expect(names).toContain('team-gateway');
    expect(names).toContain('shared-openai'); // globals are readable by everyone

    const strangerList = await app.inject({
      method: 'GET',
      url: '/api/llm-providers',
      headers: auth(strangerJwt),
    });
    expect(strangerList.json().providers.map((p: { name: string }) => p.name)).not.toContain(
      'team-gateway',
    ); // foreign personal rows are invisible
  });

  it('global scope is admin-only; foreign/personal credentials are invisible (404)', async () => {
    const globalByUser = await app.inject({
      method: 'POST',
      url: '/api/llm-providers',
      headers: auth(ownerJwt),
      payload: { name: 'nope', api: 'anthropic', credentialName: 'gw-key', scope: 'global' },
    });
    expect(globalByUser.statusCode).toBe(403);

    const foreignCred = await app.inject({
      method: 'POST',
      url: '/api/llm-providers',
      headers: auth(strangerJwt),
      payload: { name: 'steal', api: 'anthropic', credentialName: 'gw-key' },
    });
    expect(foreignCred.statusCode).toBe(404);
    expect(foreignCred.json().error).toBe('CREDENTIAL_NOT_FOUND');
  });

  it('enforces name uniqueness per (name, scope, owner)', async () => {
    const dup = await app.inject({
      method: 'POST',
      url: '/api/llm-providers',
      headers: auth(ownerJwt),
      payload: { name: 'team-gateway', api: 'anthropic', credentialName: 'gw-key' },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toBe('PROVIDER_NAME_TAKEN');

    // The same NAME in another user's personal scope is fine.
    const other = await app.inject({
      method: 'POST',
      url: '/api/llm-providers',
      headers: auth(strangerJwt),
      payload: { name: 'team-gateway', api: 'anthropic', credentialName: 'stranger-key' },
    });
    expect(other.statusCode).toBe(201);
  });

  it('PATCH mutates fields (baseUrl:null clears) and DELETE 404-hides foreign rows', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/api/llm-providers',
      headers: auth(ownerJwt),
    });
    const mine = list.json().providers.find((p: { name: string }) => p.name === 'team-gateway');

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/llm-providers/${mine.id}`,
      headers: auth(ownerJwt),
      payload: { baseUrl: null, credentialName: 'global-key' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().provider.baseUrl).toBeNull();
    expect(patch.json().provider.credentialName).toBe('global-key');

    const foreign = await app.inject({
      method: 'PATCH',
      url: `/api/llm-providers/${mine.id}`,
      headers: auth(strangerJwt),
      payload: { name: 'hijack' },
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error).toBe('PROVIDER_NOT_FOUND');
  });
});

describe('parseProviderModels + fetchProviderModels (no network)', () => {
  it('maps {data:[…]} and bare arrays; dedupes, skips junk, sorts, caps names', () => {
    const parsed = parseProviderModels(
      JSON.stringify({
        data: [
          { id: 'zeta' },
          { id: 'alpha', display_name: 'Alpha' },
          { id: 'alpha' },
          { id: '' },
          { nope: true },
          { id: 'mid', name: 'Mid' },
        ],
      }),
    );
    expect(parsed).toEqual([
      { id: 'alpha', name: 'Alpha' },
      { id: 'mid', name: 'Mid' },
      { id: 'zeta' },
    ]);

    expect(parseProviderModels(JSON.stringify([{ id: 'bare' }]))).toEqual([{ id: 'bare' }]);
    expect(() => parseProviderModels('not json')).toThrow(ProviderModelsError);
  });

  it('fetches openai shape: bearer header, 404 advances to the second candidate', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      const url = String(input);
      if (url.endsWith('/v1/models')) return jsonResponse(404, {});
      return jsonResponse(200, { data: [{ id: 'm1' }] });
    }) as typeof fetch;

    const models = await fetchProviderModels(
      { api: 'openai-chat', baseUrl: 'https://gw.example.com', apiKey: 'sk-x' },
      { fetch: fake, timeoutMs: 1000 },
    );
    expect(models).toEqual([{ id: 'm1' }]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('https://gw.example.com/v1/models');
    expect(calls[1]!.url).toBe('https://gw.example.com/models');
    expect(calls[0]!.headers.authorization).toBe('Bearer sk-x');
  });

  it('uses x-api-key + anthropic-version for the anthropic kind; maps upstream failures', async () => {
    const fake = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://gw.example.com/v1/models?limit=1000');
      expect((init?.headers as Record<string, string>)['x-api-key']).toBe('sk-x');
      expect((init?.headers as Record<string, string>)['anthropic-version']).toBe('2023-06-01');
      return jsonResponse(200, { data: [{ id: 'claude-x', display_name: 'Claude X' }] });
    }) as typeof fetch;
    const models = await fetchProviderModels(
      { api: 'anthropic', baseUrl: 'https://gw.example.com', apiKey: 'sk-x' },
      { fetch: fake, timeoutMs: 1000 },
    );
    expect(models).toEqual([{ id: 'claude-x', name: 'Claude X' }]);

    const failing = (async () => jsonResponse(500, {})) as typeof fetch;
    await expect(
      fetchProviderModels(
        { api: 'anthropic', apiKey: 'sk-x' },
        { fetch: failing, timeoutMs: 1000 },
      ),
    ).rejects.toMatchObject({ kind: 'failed' });

    const timingOut = (async () => {
      throw Object.assign(new Error('too slow'), { name: 'TimeoutError' });
    }) as unknown as typeof fetch;
    await expect(
      fetchProviderModels({ api: 'anthropic', apiKey: 'sk-x' }, { fetch: timingOut, timeoutMs: 5 }),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });
});

describe('POST /api/llm-providers/query-models', () => {
  it('resolves a stored providerId, decrypts server-side, returns the models', async () => {
    vi.stubGlobal('fetch', (async () =>
      jsonResponse(200, { data: [{ id: 'gpt-5' }, { id: 'gpt-5-mini' }] })) as typeof fetch);
    const list = await app.inject({
      method: 'GET',
      url: '/api/llm-providers',
      headers: auth(ownerJwt),
    });
    const gw = list.json().providers.find((p: { name: string }) => p.name === 'team-gateway');

    const res = await app.inject({
      method: 'POST',
      url: '/api/llm-providers/query-models',
      headers: auth(ownerJwt),
      payload: { providerId: gw.id },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().models).toEqual([{ id: 'gpt-5' }, { id: 'gpt-5-mini' }]);
    expect(JSON.stringify(res.json())).not.toContain('sk-');
  });

  it('serves the explicit arm (pre-save) and hides foreign providers', async () => {
    vi.stubGlobal('fetch', (async () =>
      jsonResponse(200, { data: [{ id: 'm' }] })) as typeof fetch);
    const explicit = await app.inject({
      method: 'POST',
      url: '/api/llm-providers/query-models',
      headers: auth(ownerJwt),
      payload: { api: 'anthropic', credentialName: 'gw-key' },
    });
    expect(explicit.statusCode).toBe(200);
    expect(explicit.json().models).toEqual([{ id: 'm' }]);

    const list = await app.inject({
      method: 'GET',
      url: '/api/llm-providers',
      headers: auth(ownerJwt),
    });
    const gw = list.json().providers.find((p: { name: string }) => p.name === 'team-gateway');
    const foreign = await app.inject({
      method: 'POST',
      url: '/api/llm-providers/query-models',
      headers: auth(strangerJwt),
      payload: { providerId: gw.id },
    });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error).toBe('PROVIDER_NOT_FOUND');
  });

  it('maps an upstream failure to 502 and a missing credential to 404', async () => {
    vi.stubGlobal('fetch', (async () => jsonResponse(503, {})) as typeof fetch);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/llm-providers/query-models',
      headers: auth(ownerJwt),
      payload: { api: 'openai-chat', credentialName: 'gw-key' },
    });
    expect(bad.statusCode).toBe(502);
    expect(bad.json().error).toBe('PROVIDER_MODELS_FAILED');

    const noCred = await app.inject({
      method: 'POST',
      url: '/api/llm-providers/query-models',
      headers: auth(ownerJwt),
      payload: { api: 'openai-chat', credentialName: 'missing' },
    });
    expect(noCred.statusCode).toBe(404);
  });
});

describe('runtime-config PUT — providerId + models arms', () => {
  it('stores providerId, dedupes models against the default, echoes both in the view', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/api/llm-providers',
      headers: auth(ownerJwt),
    });
    const shared = list.json().providers.find((p: { name: string }) => p.name === 'shared-openai');

    const put = await app.inject({
      method: 'PUT',
      url: `/api/machines/${machineId}/runtime-config/codex`,
      headers: auth(ownerJwt),
      payload: {
        providerLabel: 'shared-openai',
        api: 'openai',
        model: 'gpt-5',
        credentialName: 'global-key',
        providerId: shared.id,
        models: ['gpt-5', 'gpt-5-mini'],
      },
    });
    expect(put.statusCode).toBe(201);
    expect(put.json().config).toMatchObject({
      providerId: shared.id,
      models: ['gpt-5-mini'], // the default 'gpt-5' is dropped — extras only
    });

    const view = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/runtime-config/codex`,
      headers: auth(ownerJwt),
    });
    expect(view.json().config.models).toEqual(['gpt-5-mini']);
  });

  it('404s a providerId that is not visible to the caller', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/machines/${machineId}/runtime-config/codex`,
      headers: auth(ownerJwt),
      payload: {
        providerLabel: 'x',
        api: 'openai',
        model: 'gpt-5',
        credentialName: 'global-key',
        providerId: 'does-not-exist',
      },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('PROVIDER_NOT_FOUND');
  });

  it('rejects a provider whose kind the target cannot speak (existing flavor gate)', async () => {
    // claude-code speaks anthropic-messages only; an openai provider's mapped
    // flavor trips RUNTIME_CONFIG_UNSUPPORTED before anything is stored.
    const res = await app.inject({
      method: 'PUT',
      url: `/api/machines/${machineId}/runtime-config/claude-code`,
      headers: auth(ownerJwt),
      payload: {
        providerLabel: 'x',
        api: 'openai',
        model: 'gpt-5',
        credentialName: 'global-key',
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('RUNTIME_CONFIG_UNSUPPORTED');
  });
});

describe('#51 — provider model registry', () => {
  it('creates with models (type defaults), round-trips, and rejects duplicate ids', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/llm-providers',
      headers: auth(ownerJwt),
      payload: {
        name: 'registry-gw',
        api: 'openai-chat',
        baseUrl: 'https://gw2.example.com/v1',
        credentialName: 'gw-key',
        models: [
          {
            id: 'gw-large',
            displayName: 'Gateway Large',
            contextWindow: 256_000,
            maxOutputTokens: 32_000,
          },
          { id: 'gw-embed', type: 'embedding' },
        ],
      },
    });
    expect(created.statusCode).toBe(201);
    const provider = created.json().provider;
    expect(provider.models).toEqual([
      {
        id: 'gw-large',
        type: 'chat',
        displayName: 'Gateway Large',
        contextWindow: 256_000,
        maxOutputTokens: 32_000,
      },
      { id: 'gw-embed', type: 'embedding' },
    ]);

    const dup = await app.inject({
      method: 'POST',
      url: '/api/llm-providers',
      headers: auth(ownerJwt),
      payload: {
        name: 'registry-gw-2',
        api: 'openai-chat',
        credentialName: 'gw-key',
        models: [{ id: 'a' }, { id: 'a' }],
      },
    });
    expect(dup.statusCode).toBe(400);

    const replaced = await app.inject({
      method: 'PATCH',
      url: `/api/llm-providers/${provider.id}`,
      headers: auth(ownerJwt),
      payload: { models: [{ id: 'only-one', temperature: 0.3 }] },
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json().provider.models).toEqual([
      { id: 'only-one', type: 'chat', temperature: 0.3 },
    ]);

    // modelEntries snapshot: the PUT fills metadata for ids the registry
    // knows; unknown ids stay bare. (gw-mini is NOT in the patched registry.)
    const put = await app.inject({
      method: 'PUT',
      url: `/api/machines/${machineId}/runtime-config/pi`,
      headers: auth(ownerJwt),
      payload: {
        providerLabel: 'registry-gw',
        baseUrl: 'https://gw2.example.com/v1',
        api: 'openai',
        model: 'only-one',
        credentialName: 'global-key',
        providerId: provider.id,
        models: ['gw-unknown'],
      },
    });
    expect(put.statusCode).toBe(201);
    // temperature (advanced) never rides the spec — metadata subset only.
    expect(put.json().config.modelEntries).toEqual([{ id: 'only-one' }]);
  });
});
