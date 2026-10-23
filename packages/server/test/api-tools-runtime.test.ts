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
  hostMatchesEntry,
  ipClassOf,
  ipMatchesEntry,
  outboundAllowed,
  truncateWithMarker,
} from '../src/api-tools/runtime.js';
import type { ApiToolDef, ApiToolOutboundRules, ApiToolService } from '@harness-nexus/core';

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
  description: 'Forecast for one city',
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

  it('name rules match exact and *.wildcard hosts only', () => {
    expect(hostMatchesEntry('api.example.com', 'api.example.com')).toBe(true);
    expect(hostMatchesEntry('*.internal.corp', 'gateway.internal.corp')).toBe(true);
    expect(hostMatchesEntry('*.internal.corp', 'internal.corp')).toBe(true);
    expect(hostMatchesEntry('api.example.com', 'evil.com')).toBe(false);
    expect(hostMatchesEntry('api.example.com', 'api.example.com.evil.com')).toBe(false);
  });

  it('IP rules match literals and CIDR ranges (v4 + v6)', () => {
    expect(ipMatchesEntry('10.0.0.9', '10.0.0.9')).toBe(true);
    expect(ipMatchesEntry('10.0.0.0/8', '10.5.1.2')).toBe(true);
    expect(ipMatchesEntry('10.0.0.0/16', '10.5.0.1')).toBe(false);
    expect(ipMatchesEntry('203.0.113.0/24', '203.0.113.77')).toBe(true);
    expect(ipMatchesEntry('fd00::/8', 'fd12::abc')).toBe(true);
    expect(ipMatchesEntry('fd00::/8', 'fe80::1')).toBe(false);
  });

  it('outboundAllowed: the list flips the default action, split by network side', () => {
    const rules: ApiToolOutboundRules = { external: ['api.weather.example.com'], internal: [] };
    // deny-mode: the list is a whitelist.
    expect(outboundAllowed('deny', rules, 'api.weather.example.com', ['93.1.1.1'], ipClassOf)).toBe(
      true,
    );
    expect(outboundAllowed('deny', rules, 'evil.com', ['93.1.1.1'], ipClassOf)).toBe(false);
    // allow-mode: the same list is a blacklist.
    expect(
      outboundAllowed('allow', rules, 'api.weather.example.com', ['93.1.1.1'], ipClassOf),
    ).toBe(false);
    expect(outboundAllowed('allow', rules, 'other.com', ['93.1.1.1'], ipClassOf)).toBe(true);
    // A private resolution consults the INTERNAL list, not the external one.
    expect(outboundAllowed('deny', rules, 'api.weather.example.com', ['10.0.0.9'], ipClassOf)).toBe(
      false,
    );
    expect(
      outboundAllowed(
        'deny',
        { external: [], internal: ['10.0.0.0/8'] },
        'api.weather.example.com',
        ['10.0.0.9'],
        ipClassOf,
      ),
    ).toBe(true);
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

  async function setup(
    rules: ApiToolOutboundRules = { external: ['api.weather.example.com'], internal: [] },
    mode: 'allow' | 'deny' = 'deny',
  ) {
    const uow = createMemoryUnitOfWork();
    await uow.settings.save({
      ...(await uow.settings.get()),
      apiToolOutbound: mode,
      apiToolOutboundRules: rules,
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
          description: 'Forecast for one city',
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
    const { uow, service } = await setup();
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

  it('deny-mode: an unlisted host never fetches (empty whitelist)', async () => {
    const { uow, service } = await setup({ external: [], internal: [] });
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
    expect(res.output).toContain('blocked by the API tool outbound policy');
    expect(res.output).toContain('whitelist');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allow-mode: the external list is a BLACKLIST (listed host denied, others dial)', async () => {
    const { uow, service } = await setup({ external: [], internal: [] }, 'allow');
    const fetchSpy = vi.fn(
      async () =>
        new Response('{"code":0,"body":"ok"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const ok = await executeApiTool(
      { uow, credentialEncryptionKey: KEY },
      service,
      'get_forecast',
      { city: 'x' },
      { resolveDns: okDns },
    );
    expect(ok.isError).toBe(false);
    expect(fetchSpy).toHaveBeenCalledOnce();

    const { uow: uowB, service: serviceB } = await setup(undefined, 'allow');
    const blocked = await executeApiTool(
      { uow: uowB, credentialEncryptionKey: KEY },
      serviceB,
      'get_forecast',
      { city: 'x' },
      { resolveDns: okDns },
    );
    expect(blocked.isError).toBe(true);
    expect(blocked.output).toContain('blacklist');
  });

  it('CIDR whitelists bless address ranges (v4 and v6)', async () => {
    const { uow, service } = await setup({ external: ['93.184.0.0/16'], internal: [] });
    vi.stubGlobal(
      'fetch',
      (async () =>
        new Response('{"code":0,"body":"in range"}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
    );
    const ok = await executeApiTool(
      { uow, credentialEncryptionKey: KEY },
      service,
      'get_forecast',
      { city: 'x' },
      { resolveDns: async () => ['93.184.216.34'] },
    );
    expect(ok.isError).toBe(false);

    const { uow: uowB, service: serviceB } = await setup({
      external: ['93.184.0.0/24'],
      internal: [],
    });
    const out = await executeApiTool(
      { uow: uowB, credentialEncryptionKey: KEY },
      serviceB,
      'get_forecast',
      { city: 'x' },
      { resolveDns: async () => ['93.184.216.34'] },
    );
    expect(out.isError).toBe(true);
    expect(out.output).toContain('blocked by the API tool outbound policy');
  });

  it('anti-rebinding: an external-listed name does not bless a private resolution', async () => {
    const { uow, service } = await setup();
    vi.stubGlobal('fetch', vi.fn());
    const res = await executeApiTool(
      { uow, credentialEncryptionKey: KEY },
      service,
      'get_forecast',
      { city: 'x' },
      { resolveDns: async () => ['10.0.0.9'] },
    );
    expect(res.isError).toBe(true);
    expect(res.output).toContain('internal');
    expect(res.output).toContain('whitelist');
  });

  it('internal-listed names reach private hosts; link-local is hard-denied even then', async () => {
    const { uow, service } = await setup({ external: [], internal: ['api.weather.example.com'] });
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
    const { uow } = await setup();
    const authed: ApiToolService = {
      id: 's2',
      scope: 'personal',
      ownerId: 'u1',
      name: 'authed',
      baseUrl: 'https://api.weather.example.com',
      headers: {},
      auth: { style: 'header', header: 'X-API-Key', credentialName: 'weather-key' },
      tools: [{ name: 'ping', description: 'Ping', method: 'GET', path: '/ping', params: [] }],
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
    const { uow, service } = await setup();
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
