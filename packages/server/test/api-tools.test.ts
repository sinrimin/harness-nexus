// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { testConfig } from './helpers.js';

/**
 * #80 slice 1 — API tool services over REST: the JSON bundle IS the
 * interface (LLM-authored upload/download). The shared zod schema is the
 * shape gate (errors reach the authoring loop verbatim), the service is the
 * single authorization point (#36: personal owner-only, global admin-owned
 * and visible to all), storage round-trips the bundle (sqlite in-memory —
 * migration v25 runs in buildApp).
 */

let app: FastifyInstance;
let ownerJwt: string;
let strangerJwt: string;
let adminJwt: string;
let credJwt: string;

const auth = (t: string): { authorization: string } => ({ authorization: `Bearer ${t}` });

const BUNDLE = {
  version: 1,
  name: 'weather',
  description: 'The demo weather API',
  baseUrl: 'https://api.weather.example.com',
  headers: { 'X-Client': 'harness-nexus' },
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
      timeoutMs: 5000,
      envelope: {
        codeField: 'code',
        success: [0, '0'],
        payloadField: 'body',
        errorFields: ['message', 'desc'],
      },
    },
  ],
};

beforeAll(async () => {
  app = await buildApp(testConfig({}));
  const register = async (username: string, role?: 'admin') => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { username, password: 'hunter2hunter2' },
    });
    const { token, user } = res.json();
    if (role === 'admin') {
      await app.uow.users.save({ ...(await app.uow.users.findById(user.id))!, role: 'admin' });
    }
    return token;
  };
  // The FIRST registration becomes the instance admin — burn it on a
  // throwaway so atowner stays a plain user.
  await register('atfirst');
  ownerJwt = await register('atowner');
  strangerJwt = await register('atstranger');
  adminJwt = await register('atadmin', 'admin');
  credJwt = ownerJwt;

  // A visible credential for the auth-block checks.
  await app.inject({
    method: 'POST',
    url: '/api/credentials',
    headers: auth(credJwt),
    payload: { name: 'weather-key', secret: 'sk-xyz', scope: 'personal' },
  });
});

afterAll(async () => {
  await app.close();
});

describe('API tool services (#80 slice 1)', () => {
  it('creates a personal service (default scope) and round-trips the bundle', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/api-tools',
      headers: auth(ownerJwt),
      payload: { bundle: BUNDLE },
    });
    expect(res.statusCode).toBe(201);
    const { service } = res.json();
    expect(service.scope).toBe('personal');
    expect(service.bundle.tools[0].name).toBe('get_forecast');
    expect(service.bundle.tools[0].params).toHaveLength(2); // defaulted

    // Download == upload (modulo zod defaults).
    const got = await app.inject({
      method: 'GET',
      url: `/api/api-tools/${service.id}`,
      headers: auth(ownerJwt),
    });
    expect(got.statusCode).toBe(200);
    expect(got.json().service.bundle.baseUrl).toBe(BUNDLE.baseUrl);
    expect(got.json().service.bundle.headers).toEqual(BUNDLE.headers);
  });

  it('#36: strangers 404 and never list foreign personal rows; global is admin-owned', async () => {
    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/api-tools',
        headers: auth(ownerJwt),
        payload: { bundle: { ...BUNDLE, name: 'private-one' } },
      })
    ).json().service;

    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/api-tools/${created.id}`,
          headers: auth(strangerJwt),
        })
      ).statusCode,
    ).toBe(404);
    const strangerList = (
      await app.inject({ method: 'GET', url: '/api/api-tools', headers: auth(strangerJwt) })
    ).json().services as { id: string }[];
    expect(strangerList.some((s) => s.id === created.id)).toBe(false);

    // Non-admin cannot create global; admin can, and everyone sees it.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/api-tools',
          headers: auth(ownerJwt),
          payload: { scope: 'global', bundle: { ...BUNDLE, name: 'shared-weather' } },
        })
      ).statusCode,
    ).toBe(403);
    const global = await app.inject({
      method: 'POST',
      url: '/api/api-tools',
      headers: auth(adminJwt),
      payload: { scope: 'global', bundle: { ...BUNDLE, name: 'shared-weather' } },
    });
    expect(global.statusCode).toBe(201);
    const strangerSees = (
      await app.inject({ method: 'GET', url: '/api/api-tools', headers: auth(strangerJwt) })
    ).json().services as { id: string }[];
    expect(strangerSees.some((s) => s.id === global.json().service.id)).toBe(true);
  });

  it('the zod gate feeds the LLM loop: shape errors are readable 400s', async () => {
    const cases: [unknown, RegExp][] = [
      // Path slot without a matching path param.
      [
        { ...BUNDLE, name: 'bad1', tools: [{ ...BUNDLE.tools[0], path: '/v1/x/{city}/{unit}' }] },
        /unit.*path param|\{unit\}/,
      ],
      // Body param without bodyType.
      [
        {
          ...BUNDLE,
          name: 'bad2',
          tools: [
            {
              ...BUNDLE.tools[0],
              path: '/v1/x',
              params: [{ name: 'payload', in: 'body', type: 'string', required: true }],
            },
          ],
        },
        /bodyType/,
      ],
      // Secrets never ride headers.
      [
        { ...BUNDLE, name: 'bad3', headers: { Authorization: 'Bearer x' } },
        /auth block|secrets belong/,
      ],
      // Duplicate tool names.
      [
        { ...BUNDLE, name: 'bad4', tools: [BUNDLE.tools[0], { ...BUNDLE.tools[0] }] },
        /duplicate tool name/,
      ],
      // Unknown format version.
      [{ ...BUNDLE, name: 'bad5', version: 2 }, /version/],
    ];
    for (const [bundle, pattern] of cases) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/api-tools',
        headers: auth(ownerJwt),
        payload: { bundle },
      });
      expect(res.statusCode, JSON.stringify(bundle)).toBe(400);
      expect(JSON.stringify(res.json())).toMatch(pattern);
    }
  });

  it('the auth block names a credential that must exist and be visible', async () => {
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/api-tools',
      headers: auth(ownerJwt),
      payload: {
        bundle: {
          ...BUNDLE,
          name: 'authed-weather',
          auth: { style: 'bearer', credentialName: 'nope' },
        },
      },
    });
    expect(unknown.statusCode).toBe(422);
    expect(unknown.json().error).toBe('API_TOOL_CREDENTIAL_NOT_VISIBLE');

    const ok = await app.inject({
      method: 'POST',
      url: '/api/api-tools',
      headers: auth(ownerJwt),
      payload: {
        bundle: {
          ...BUNDLE,
          name: 'authed-weather',
          auth: { style: 'header', header: 'X-API-Key', credentialName: 'weather-key' },
        },
      },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().service.bundle.auth.style).toBe('header');
  });

  it('names are unique per scope; PUT replaces the bundle; DELETE soft-hides', async () => {
    const dup = await app.inject({
      method: 'POST',
      url: '/api/api-tools',
      headers: auth(ownerJwt),
      payload: { bundle: BUNDLE },
    });
    expect(dup.statusCode).toBe(409);

    const created =
      dup.json().service ??
      (await app.inject({ method: 'GET', url: '/api/api-tools', headers: auth(ownerJwt) }))
        .json()
        .services.find((s: { bundle: { name: string } }) => s.bundle.name === 'weather');
    const replaced = await app.inject({
      method: 'PUT',
      url: `/api/api-tools/${created.id}`,
      headers: auth(ownerJwt),
      payload: {
        bundle: {
          ...BUNDLE,
          description: undefined,
          tools: [{ ...BUNDLE.tools[0], timeoutMs: 9000 }],
        },
      },
    });
    expect(replaced.statusCode).toBe(200);
    expect(replaced.json().service.bundle.tools[0].timeoutMs).toBe(9000);
    expect(replaced.json().service.bundle.description).toBeUndefined();

    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/api-tools/${created.id}`,
          headers: auth(ownerJwt),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/api/api-tools/${created.id}`,
          headers: auth(ownerJwt),
        })
      ).statusCode,
    ).toBe(404);
    const listed = (
      await app.inject({ method: 'GET', url: '/api/api-tools', headers: auth(ownerJwt) })
    ).json().services as { id: string }[];
    expect(listed.some((s) => s.id === created.id)).toBe(false);
  });

  it('the allowlist is admin-managed (default-deny: empty until set)', async () => {
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/settings/api-tool-allowlist',
          headers: auth(ownerJwt),
          payload: { entries: [{ host: 'api.weather.example.com' }] },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: '/api/settings/api-tool-allowlist',
          headers: auth(adminJwt),
          payload: { entries: [{ host: 'bad host name' }] },
        })
      ).statusCode,
    ).toBe(400);

    const put = await app.inject({
      method: 'PUT',
      url: '/api/settings/api-tool-allowlist',
      headers: auth(adminJwt),
      payload: {
        entries: [{ host: 'api.weather.example.com' }, { host: '*.internal.corp', internal: true }],
      },
    });
    expect(put.statusCode).toBe(200);
    const got = (
      await app.inject({
        method: 'GET',
        url: '/api/settings/api-tool-allowlist',
        headers: auth(adminJwt),
      })
    ).json().entries as { host: string; internal?: boolean }[];
    expect(got).toHaveLength(2);
    expect(got[1]).toEqual({ host: '*.internal.corp', internal: true });
  });

  it('probe: what the model would see — success, and the deny arm', async () => {
    // A REAL loopback server (internal-flagged allowlist entry reaches it);
    // no fetch stubs — this exercises the full runtime path.
    const { createServer } = await import('node:http');
    const server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(
        req.url !== null && req.url.includes('city=Oslo')
          ? '{"code":0,"body":{"temp":21}}'
          : '{"code":0,"body":{"temp":15}}',
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as { port: number }).port;
    try {
      await app.inject({
        method: 'PUT',
        url: '/api/settings/api-tool-allowlist',
        headers: auth(adminJwt),
        payload: { entries: [{ host: '127.0.0.1', internal: true }] },
      });
      const created = (
        await app.inject({
          method: 'POST',
          url: '/api/api-tools',
          headers: auth(ownerJwt),
          payload: {
            bundle: {
              ...BUNDLE,
              baseUrl: `http://127.0.0.1:${port}`,
              tools: [
                {
                  ...BUNDLE.tools[0],
                  path: '/v1/forecast',
                  params: [{ name: 'city', in: 'query', type: 'string', required: true }],
                },
              ],
            },
          },
        })
      ).json().service;

      const probe = await app.inject({
        method: 'POST',
        url: `/api/api-tools/${created.id}/probe`,
        headers: auth(ownerJwt),
        payload: { tool: 'get_forecast', args: { city: 'Oslo' } },
      });
      expect(probe.statusCode).toBe(200);
      const body = probe.json();
      expect(body.result.isError).toBe(false);
      expect(body.result.output).toContain('"temp": 21');
      expect(body.debug.method).toBe('GET');
      expect(body.debug.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // Deny arm: a host NOT on the allowlist surfaces as a tool error.
    const deniedService = (
      await app.inject({
        method: 'POST',
        url: '/api/api-tools',
        headers: auth(ownerJwt),
        payload: {
          bundle: { ...BUNDLE, name: 'unlisted', baseUrl: 'https://api.other.example.com' },
        },
      })
    ).json().service;
    const denied = await app.inject({
      method: 'POST',
      url: `/api/api-tools/${deniedService.id}/probe`,
      headers: auth(ownerJwt),
      payload: { tool: 'get_forecast', args: { city: 'Oslo' } },
    });
    expect(denied.json().result.isError).toBe(true);
    expect(denied.json().result.output).toContain('not on the API tool allowlist');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
