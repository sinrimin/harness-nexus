// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import { encryptSecret } from '../src/infra/crypto.js';
import {
  applyResponse,
  executeApiTool,
  getByDotPath,
  ipClassOf,
  matchAllowlist,
  truncateWithMarker,
} from '../src/api-tools/runtime.js';
import type { ApiToolDef, ApiToolService } from '@harness-nexus/core';

/**
 * #80 slice 2 — the runtime's pure shaping functions (the fixed response
 * matrix, truncation, allowlist matching, IP classes) plus the executor
 * against a stubbed fetch + injectable DNS: the network guard's every arm,
 * credential injection, arg coercion.
 */

const KEY = 'test-secret-0123456789abcdef';
const now = '2026-01-01T00:00:00.000Z';

const tool = (over: Partial<ApiToolDef> = {}): ApiToolDef => ({
  name: 'get_forecast',
  method: 'GET',
  path: '/v1/forecast/{city}',
  params: [{ name: 'city', in: 'path', type: 'string', required: true }],
  ...over,
});

describe('shaping (pure)', () => {
  it('truncation carries the true total', () => {
    const out = truncateWithMarker('x'.repeat(50), 10);
    expect(out).toBe(`${'x'.repeat(10)}\n…[truncated, 10/50 chars]`);
    expect(truncateWithMarker('short', 100)).toBe('short');
  });

  it('dot paths walk objects only', () => {
    expect(getByDotPath({ a: { b: 7 } }, 'a.b')).toBe(7);
    expect(getByDotPath({ a: null }, 'a.b')).toBeUndefined();
    expect(getByDotPath([1, 2], '0')).toBe(1);
  });

  it('the allowlist matches exact and *.wildcard hosts', () => {
    const entries = [{ host: 'api.example.com' }, { host: '*.internal.corp', internal: true }];
    expect(matchAllowlist('api.example.com', entries)?.host).toBe('api.example.com');
    expect(matchAllowlist('gateway.internal.corp', entries)?.internal).toBe(true);
    expect(matchAllowlist('internal.corp', entries)?.internal).toBe(true);
    expect(matchAllowlist('evil.com', entries)).toBeNull();
    expect(matchAllowlist('api.example.com.evil.com', entries)).toBeNull();
  });

  it('IP classes', () => {
    expect(ipClassOf('127.0.0.1')).toBe('loopback');
    expect(ipClassOf('169.254.169.254')).toBe('link-local');
    expect(ipClassOf('10.1.2.3')).toBe('private');
    expect(ipClassOf('192.168.0.5')).toBe('private');
    expect(ipClassOf('172.20.0.1')).toBe('private');
    expect(ipClassOf('8.8.8.8')).toBe('public');
    expect(ipClassOf('::1')).toBe('loopback');
    expect(ipClassOf('fe80::1')).toBe('link-local');
    expect(ipClassOf('fd00::5')).toBe('private');
  });

  it('the response matrix — four envelope cases + text + WAF page', () => {
    const env = {
      codeField: 'code',
      success: [0, '0'],
      payloadField: 'body',
      errorFields: ['message', 'desc'],
    };
    // 1: 2xx + success → payload.
    expect(
      applyResponse(
        tool({ envelope: env }),
        200,
        'application/json',
        '{"code":0,"body":{"temp":9}}',
      ),
    ).toEqual({ output: '{\n  "temp": 9\n}', isError: false });
    // 2: 2xx + business fail → errorField text.
    const fail = applyResponse(
      tool({ envelope: env }),
      200,
      'application/json',
      '{"code":401,"desc":"expired"}',
    );
    expect(fail.isError).toBe(true);
    expect(fail.output).toContain('API code 401');
    expect(fail.output).toContain('expired');
    // 3: non-2xx default → status + capped body.
    const non2xx = applyResponse(tool({ envelope: env }), 503, 'text/html', 'busy'.repeat(400));
    expect(non2xx.isError).toBe(true);
    expect(non2xx.output).toContain('HTTP 503');
    expect(non2xx.output.length).toBeLessThan(600);
    // 4: treatBodyOnNon2xx → envelope even on 4xx.
    const treated = applyResponse(
      tool({ envelope: env, treatBodyOnNon2xx: true }),
      404,
      'application/json',
      '{"code":3,"message":"no such city"}',
    );
    expect(treated.isError).toBe(true);
    expect(treated.output).toContain('no such city');
    // Loose compare: '0' === 0.
    expect(
      applyResponse(tool({ envelope: env }), 200, 'application/json', '{"code":"0","body":[]}'),
    ).toEqual({ output: '[]', isError: false });
    // Envelope expects JSON but got the WAF/login page.
    const waf = applyResponse(tool({ envelope: env }), 200, 'text/html', '<html>login</html>');
    expect(waf.isError).toBe(true);
    expect(waf.output).toContain('could not parse');
    expect(waf.output).toContain('<html>login</html>');
    // No envelope, text arm.
    expect(applyResponse(tool(), 200, 'text/plain', 'sunny')).toEqual({
      output: 'sunny',
      isError: false,
    });
    // No envelope, non-2xx.
    expect(applyResponse(tool(), 500, 'text/plain', 'boom').isError).toBe(true);
  });
});

describe('executeApiTool (stubbed fetch + injectable DNS)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function setup(allowlist: { host: string; internal?: boolean }[]) {
    const uow = createMemoryUnitOfWork();
    await uow.settings.save({
      ...(await uow.settings.get()),
      apiToolAllowlist: allowlist,
      updatedAt: now,
    });
    await uow.credentials.save({
      id: 'c1',
      name: 'weather-key',
      secret: encryptSecret('sk-real', KEY),
      scope: 'personal',
      ownerId: 'u1',
      distributable: true,
      createdAt: now,
      updatedAt: now,
    });
    const service: ApiToolService = {
      id: 's1',
      scope: 'personal',
      ownerId: 'u1',
      name: 'weather',
      baseUrl: 'https://api.weather.example.com',
      headers: {},
      tools: [
        {
          name: 'get_forecast',
          method: 'GET',
          path: '/v1/forecast/{city}',
          params: [
            { name: 'city', in: 'path', type: 'string', required: true },
            { name: 'days', in: 'query', type: 'number', required: false },
          ],
          envelope: {
            codeField: 'code',
            success: [0],
            payloadField: 'body',
            errorFields: ['message'],
          },
        },
      ],
      createdAt: now,
      updatedAt: now,
    };
    await uow.apiTools.save(service);
    return { uow, service };
  }

  const okDns = async () => ['93.184.216.34'];

  it('happy path: envelope payload, query + path substitution, truncation off', async () => {
    const { uow, service } = await setup([{ host: 'api.weather.example.com' }]);
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal('fetch', (async (url: unknown, init: RequestInit | undefined) => {
      seen.push({ url: String(url), init });
      return new Response('{"code":0,"body":{"temp":21}}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch);
    const res = await executeApiTool(
      { uow, credentialEncryptionKey: KEY },
      service,
      'get_forecast',
      { city: 'Oslo', days: 3 },
      { resolveDns: okDns },
    );
    expect(res.isError).toBe(false);
    expect(res.output).toContain('"temp": 21');
    expect(seen[0]!.url).toBe('https://api.weather.example.com/v1/forecast/Oslo?days=3');
    expect(seen[0]!.init?.method).toBe('GET');
  });

  it('default-deny: a host not on the allowlist never fetches', async () => {
    const { uow, service } = await setup([]);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await executeApiTool(
      { uow, credentialEncryptionKey: KEY },
      service,
      'get_forecast',
      { city: 'x' },
      { resolveDns: okDns },
    );
    expect(res.isError).toBe(true);
    expect(res.output).toContain('not on the API tool allowlist');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('anti-rebinding: a non-internal entry with a private resolution is refused', async () => {
    const { uow, service } = await setup([{ host: 'api.weather.example.com' }]);
    vi.stubGlobal('fetch', vi.fn());
    const res = await executeApiTool(
      { uow, credentialEncryptionKey: KEY },
      service,
      'get_forecast',
      { city: 'x' },
      { resolveDns: async () => ['10.0.0.9'] },
    );
    expect(res.isError).toBe(true);
    expect(res.output).toContain('only internal-flagged');
  });

  it('internal entries reach private hosts; link-local is hard-denied even then', async () => {
    const { uow, service } = await setup([{ host: 'api.weather.example.com', internal: true }]);
    vi.stubGlobal(
      'fetch',
      (async () =>
        new Response('{"code":0,"body":"intranet ok"}', { status: 200 })) as typeof fetch,
    );
    const ok = await executeApiTool(
      { uow, credentialEncryptionKey: KEY },
      service,
      'get_forecast',
      { city: 'x' },
      { resolveDns: async () => ['10.0.0.9'] },
    );
    expect(ok.isError).toBe(false);

    const denied = await executeApiTool(
      { uow, credentialEncryptionKey: KEY },
      service,
      'get_forecast',
      { city: 'x' },
      { resolveDns: async () => ['169.254.169.254'] },
    );
    expect(denied.isError).toBe(true);
    expect(denied.output).toContain('link-local');
  });

  it('auth injects the decrypted secret; timing/IO failures are tool errors', async () => {
    const { uow } = await setup([{ host: 'api.weather.example.com' }]);
    const authed: ApiToolService = {
      id: 's2',
      scope: 'personal',
      ownerId: 'u1',
      name: 'authed',
      baseUrl: 'https://api.weather.example.com',
      headers: {},
      auth: { style: 'header', header: 'X-API-Key', credentialName: 'weather-key' },
      tools: [{ name: 'ping', method: 'GET', path: '/ping', params: [] }],
      createdAt: now,
      updatedAt: now,
    };
    await uow.apiTools.save(authed);
    const seen: { headers: Record<string, string> }[] = [];
    vi.stubGlobal('fetch', (async (_url: unknown, init: RequestInit | undefined) => {
      seen.push({ headers: init?.headers as Record<string, string> });
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch);
    const ok = await executeApiTool(
      { uow, credentialEncryptionKey: KEY },
      authed,
      'ping',
      {},
      { resolveDns: okDns },
    );
    expect(ok.isError).toBe(false);
    expect(seen[0]!.headers['X-API-Key']).toBe('sk-real');

    vi.stubGlobal('fetch', (async () => {
      throw new Error('network is down');
    }) as typeof fetch);
    const dead = await executeApiTool(
      { uow, credentialEncryptionKey: KEY },
      authed,
      'ping',
      {},
      { resolveDns: okDns },
    );
    expect(dead.isError).toBe(true);
    expect(dead.output).toContain('request failed after');
  });

  it('args: missing required and bad coercion are model-readable errors', async () => {
    const { uow, service } = await setup([{ host: 'api.weather.example.com' }]);
    const miss = await executeApiTool(
      { uow, credentialEncryptionKey: KEY },
      service,
      'get_forecast',
      {},
      { resolveDns: okDns },
    );
    expect(miss.isError).toBe(true);
    expect(miss.output).toContain('missing required param city');
    const bad = await executeApiTool(
      { uow, credentialEncryptionKey: KEY },
      service,
      'get_forecast',
      { city: 'x', days: 'not-a-number' },
      { resolveDns: okDns },
    );
    expect(bad.isError).toBe(true);
    expect(bad.output).toContain('not a number');
  });
});
