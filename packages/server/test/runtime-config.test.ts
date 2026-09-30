import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { testConfig } from './helpers.js';

/**
 * Runtime provider-config routes (Phase 9 W3): the owner/distributable gates,
 * the apply-config job queueing, the spec-only GET (never a secret), and the
 * daemon's machine-PAT bundle surface — the ONLY place the plaintext appears.
 */

let app: FastifyInstance;
let rootToken: string; // bootstrap admin
let ownerJwt: string; // machine owner (regular user)
let strangerJwt: string;
let machineId: string;
let machineToken: string;
let credId: string;

const auth = (t: string): { authorization: string } => ({ authorization: `Bearer ${t}` });

const codexSpec = {
  providerLabel: 'team gateway',
  baseUrl: 'https://gw.example.com/v1',
  api: 'openai',
  model: 'gw-large',
  credentialName: 'gw-key',
};

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

  const cred = await app.inject({
    method: 'POST',
    url: '/api/credentials',
    headers: auth(ownerJwt),
    payload: { name: 'gw-key', secret: 'sk-plaintext-value', scope: 'personal' },
  });
  if (cred.statusCode !== 201) throw new Error(`credential seed failed: ${cred.body}`);
  credId = cred.json().credential.id;

  const enroll = await app.inject({
    method: 'POST',
    url: '/api/machines',
    headers: auth(ownerJwt),
    payload: { name: 'w3-box' },
  });
  machineId = enroll.json().machine.id;
  machineToken = enroll.json().token;
});

afterAll(async () => {
  await app.close();
});

describe('PUT /api/machines/:id/runtime-config/:target', () => {
  it('upserts the spec and queues an apply-config harness job (owner)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/machines/${machineId}/runtime-config/codex`,
      headers: auth(ownerJwt),
      payload: codexSpec,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().config).toMatchObject({
      target: 'codex',
      credentialName: 'gw-key',
      model: 'gw-large',
    });
    expect(JSON.stringify(res.json())).not.toContain('sk-plaintext-value');
    const job = res.json().job;
    expect(job.type).toBe('harness');
    expect(job.payload).toEqual({ type: 'harness', action: 'apply-config', target: 'codex' });
    expect(job.status).toBe('queued'); // daemon offline — queues

    const again = await app.inject({
      method: 'PUT',
      url: `/api/machines/${machineId}/runtime-config/codex`,
      headers: auth(ownerJwt),
      payload: { ...codexSpec, model: 'gw-large-2' },
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().job.type).toBe('harness');
  });

  it('is owner-only — even an admin is 404-hidden from a foreign machine (#36)', async () => {
    const asAdmin = await app.inject({
      method: 'PUT',
      url: `/api/machines/${machineId}/runtime-config/codex`,
      headers: auth(rootToken),
      payload: codexSpec,
    });
    expect(asAdmin.statusCode).toBe(404);
    expect(asAdmin.json().error).toBe('MACHINE_NOT_FOUND');
    const view = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/runtime-config/codex`,
      headers: auth(rootToken),
    });
    expect(view.statusCode).toBe(404);
  });

  it('hides foreign machines (404, not 403) and missing rows', async () => {
    const stranger = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/runtime-config/codex`,
      headers: auth(strangerJwt),
    });
    expect(stranger.statusCode).toBe(404);
    const none = await app.inject({
      method: 'GET',
      url: `/api/machines/${machineId}/runtime-config/deepseek`,
      headers: auth(ownerJwt),
    });
    expect(none.statusCode).toBe(404);
    expect(none.json().error).toBe('RUNTIME_CONFIG_NOT_FOUND');
  });

  it('rejects api-flavor mismatches and a baseUrl-less deepseek spec', async () => {
    const flavor = await app.inject({
      method: 'PUT',
      url: `/api/machines/${machineId}/runtime-config/claude-code`,
      headers: auth(ownerJwt),
      payload: { ...codexSpec, api: 'openai' },
    });
    expect(flavor.statusCode).toBe(409);
    expect(flavor.json().error).toBe('RUNTIME_CONFIG_UNSUPPORTED');
    const noUrl = await app.inject({
      method: 'PUT',
      url: `/api/machines/${machineId}/runtime-config/deepseek`,
      headers: auth(ownerJwt),
      payload: { ...codexSpec, baseUrl: undefined },
    });
    expect(noUrl.statusCode).toBe(409);
  });

  it('gates on credential existence and distributability', async () => {
    const missing = await app.inject({
      method: 'PUT',
      url: `/api/machines/${machineId}/runtime-config/codex`,
      headers: auth(ownerJwt),
      payload: { ...codexSpec, credentialName: 'nope' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe('CREDENTIAL_NOT_FOUND');

    // A global LOCKED credential (admin default) may not leave the server.
    await app.inject({
      method: 'POST',
      url: '/api/credentials',
      headers: auth(rootToken),
      payload: { name: 'locked-global', secret: 'sk-locked', scope: 'global' },
    });
    const locked = await app.inject({
      method: 'PUT',
      url: `/api/machines/${machineId}/runtime-config/codex`,
      headers: auth(ownerJwt),
      payload: { ...codexSpec, credentialName: 'locked-global' },
    });
    expect(locked.statusCode).toBe(409);
    expect(locked.json().error).toBe('CREDENTIAL_NOT_DISTRIBUTABLE');
  });

  it('refuses a bare apply-config job body (the spec surface owns it)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/machines/${machineId}/jobs`,
      headers: auth(ownerJwt),
      payload: { type: 'harness', action: 'apply-config', target: 'codex' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('USE_RUNTIME_CONFIG_ENDPOINT');
  });
});

describe('GET /api/client/runtime-config (machine PAT exception #3)', () => {
  it('resolves the bundle for the machine PAT — the ONLY surface with the secret', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/client/runtime-config?target=codex',
      headers: auth(machineToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      target: 'codex',
      secret: 'sk-plaintext-value',
      spec: { credentialName: 'gw-key', model: 'gw-large-2' },
    });
  });

  it('rejects every non-machine caller with a flat 404 (no existence leak)', async () => {
    for (const token of [ownerJwt, rootToken]) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/client/runtime-config?target=codex',
        headers: auth(token),
      });
      expect(res.statusCode).toBe(404);
    }
  });

  it('404s an unconfigured target and 400s a missing one', async () => {
    const none = await app.inject({
      method: 'GET',
      url: '/api/client/runtime-config?target=deepseek',
      headers: auth(machineToken),
    });
    expect(none.statusCode).toBe(404);
    const missing = await app.inject({
      method: 'GET',
      url: '/api/client/runtime-config',
      headers: auth(machineToken),
    });
    expect(missing.statusCode).toBe(400);
  });

  it('follows credential rotation (fresh resolution per fetch)', async () => {
    await app.inject({
      method: 'PATCH',
      url: `/api/credentials/${credId}`,
      headers: auth(ownerJwt),
      payload: { secret: 'sk-rotated' },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/client/runtime-config?target=codex',
      headers: auth(machineToken),
    });
    expect(res.json().secret).toBe('sk-rotated');
  });
});

describe('machine deletion cascades runtime configs', () => {
  it('drops the row with the machine', async () => {
    const enroll = await app.inject({
      method: 'POST',
      url: '/api/machines',
      headers: auth(ownerJwt),
      payload: { name: 'w3-cascade' },
    });
    const id = enroll.json().machine.id;
    await app.inject({
      method: 'PUT',
      url: `/api/machines/${id}/runtime-config/codex`,
      headers: auth(ownerJwt),
      payload: codexSpec,
    });
    await app.inject({ method: 'DELETE', url: `/api/machines/${id}`, headers: auth(ownerJwt) });
    const gone = await app.inject({
      method: 'GET',
      url: `/api/machines/${id}/runtime-config/codex`,
      headers: auth(ownerJwt),
    });
    expect(gone.statusCode).toBe(404);
  });
});
