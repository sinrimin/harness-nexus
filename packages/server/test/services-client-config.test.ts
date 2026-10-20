// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import type { Profile } from '@harness-nexus/core';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import { createCredential, updateCredential } from '../src/services/credentials.js';
import { createMcpServer, deleteMcpServer } from '../src/services/mcp-servers.js';
import { enrollMachine } from '../src/services/machines.js';
import type { Principal } from '../src/services/principal.js';
import { createProfile } from '../src/services/profiles.js';
import { createResource } from '../src/services/resources.js';
import {
  buildClientMcpConfig,
  buildDeployBundle,
  buildRuntimeConfigBundle,
  type ClientCaller,
  type ClientConfigDeps,
} from '../src/services/client-config.js';
import { planRuntimeConfigUpsert, saveRuntimeConfig } from '../src/services/runtime-config.js';

/**
 * #53 slice 15 — the client-config service (the machine-PAT surface's
 * decision + resolution half), tested DIRECTLY against the memory driver (no
 * HTTP, no sockets, no network). Caller AUTHENTICATION (the machine-ctl →
 * owner mapping) is route residue, pinned by test/client-config.test.ts and
 * test/runtime-config.test.ts; these assert visibility, dial-site filtering,
 * decryption-into-the-bundle, and the never-a-locked-plaintext invariant at
 * the shared door.
 */

const KEY = 'test-secret-0123456789abcdef';
const BASE = 'https://nexus.example.com';

const alice: Principal = { userId: 'u-alice', role: 'user' };
const bob: Principal = { userId: 'u-bob', role: 'user' };
const admin: Principal = { userId: 'u-admin', role: 'admin' };

function deps(): ClientConfigDeps {
  return { uow: createMemoryUnitOfWork(), credentialEncryptionKey: KEY, publicBaseUrl: BASE };
}

const asCaller = (p: Principal, machineId?: string): ClientCaller =>
  machineId === undefined ? { userId: p.userId, role: p.role } : { ...asCaller(p), machineId };

/** The mixed dial-site world of client-config.test.ts, seeded via services. */
async function seedWorld(d: ClientConfigDeps) {
  await createCredential(d, alice, {
    name: 'mine',
    secret: 'my-personal-secret',
    scope: 'personal',
  });
  await createCredential(d, admin, { name: 'corp', secret: 'CORP-LOCKED-SECRET', scope: 'global' });

  const stdio = await createMcpServer(d, alice, {
    name: 'local echo',
    transport: { type: 'stdio', command: 'echo-bin', args: ['${cred:mine}'] },
    dialSite: 'auto',
    scope: 'personal',
  });
  const corpHttp = await createMcpServer(d, alice, {
    name: 'corp api',
    transport: {
      type: 'streamable-http',
      url: 'https://corp.example/mcp',
      headers: { Authorization: 'Bearer ${cred:corp}' },
    },
    dialSite: 'auto',
    scope: 'personal',
  });
  const profile = await createProfile(d, alice, {
    name: 'mixed',
    target: 'claude-code',
    scope: 'personal',
    entries: [{ mcpServerId: stdio.id }, { mcpServerId: corpHttp.id }],
  });
  return { stdio, corpHttp, profile };
}

describe('svc client-config — mcp-config shape + dial-site filtering', () => {
  it('resolves client-dialed transports to plaintext; server-dialed stay name-only with the outlet arm', async () => {
    const d = deps();
    const { profile } = await seedWorld(d);

    const config = await buildClientMcpConfig(d, asCaller(alice), profile.id);
    const byName = new Map(config.servers.map((s) => [s.name, s]));
    expect(byName.get('local echo')).toMatchObject({
      dialSite: 'client',
      transport: { type: 'stdio', command: 'echo-bin', args: ['my-personal-secret'] },
    });
    const corp = byName.get('corp api')!;
    expect(corp.dialSite).toBe('server');
    expect('transport' in corp).toBe(false);
    expect(config.platform).toEqual({ baseUrl: BASE });
    // THE invariant: a locked secret never enters any built result.
    expect(JSON.stringify(config)).not.toContain('CORP-LOCKED-SECRET');
  });

  it('no outlet arm when every entry is client-dialed', async () => {
    const d = deps();
    const { stdio } = await seedWorld(d);
    const profile = await createProfile(d, alice, {
      name: 'client-only',
      target: 'claude-code',
      scope: 'personal',
      entries: [{ mcpServerId: stdio.id }],
    });
    const config = await buildClientMcpConfig(d, asCaller(alice), profile.id);
    expect(config.platform).toBeNull();
  });

  it('400s a missing profile param; hides foreign personal profiles as 404', async () => {
    const d = deps();
    const { profile } = await seedWorld(d);
    await expect(buildClientMcpConfig(d, asCaller(alice), undefined)).rejects.toMatchObject({
      statusCode: 400,
      code: 'PROFILE_REQUIRED',
    });
    for (const p of [bob, admin]) {
      await expect(buildClientMcpConfig(d, asCaller(p), profile.id)).rejects.toMatchObject({
        statusCode: 404,
        code: 'PROFILE_NOT_FOUND',
      });
    }
  });

  it('403s when a visible profile references an invisible server', async () => {
    const d = deps();
    const { stdio } = await seedWorld(d);
    // A GLOBAL profile carrying alice's PERSONAL server — visible profile,
    // invisible entry for bob (achievable state; entry visibility is checked
    // per-fetch, not just at profile-create time).
    const global: Profile = {
      id: 'prof-global',
      name: 'shared',
      version: '0.1',
      target: 'claude-code',
      scope: 'global',
      ownerId: null,
      entries: [{ resourceId: stdio.id, kind: 'mcp' }],
      createdAt: '2026-10-14T00:00:00.000Z',
      updatedAt: '2026-10-14T00:00:00.000Z',
    };
    await d.uow.profiles.save(global);
    await expect(buildClientMcpConfig(d, asCaller(bob), global.id)).rejects.toMatchObject({
      statusCode: 403,
      code: 'PROFILE_ENTRY_NOT_ACCESSIBLE',
    });
    // The owner still resolves it fine.
    await expect(buildClientMcpConfig(d, asCaller(alice), global.id)).resolves.toBeTruthy();
  });

  it('skips soft-deleted entries instead of failing (two-stage delete)', async () => {
    const d = deps();
    const { stdio, corpHttp } = await seedWorld(d);
    const profile = await createProfile(d, alice, {
      name: 'before-delete',
      target: 'claude-code',
      scope: 'personal',
      entries: [{ mcpServerId: stdio.id }, { mcpServerId: corpHttp.id }],
    });
    expect((await deleteMcpServer(d, alice, corpHttp.id)).mode).toBe('soft');
    const config = await buildClientMcpConfig(d, asCaller(alice), profile.id);
    expect(config.servers.map((s) => s.name)).toEqual(['local echo']);
    expect(config.platform).toBeNull();
  });
});

describe('svc client-config — deploy bundle', () => {
  it('assembles mcp + resource artifacts for the visible caller', async () => {
    const d = deps();
    const { stdio } = await seedWorld(d);
    const skill = await createResource(d, alice, {
      key: 'greeter',
      kind: 'skill',
      name: 'Greeter',
      version: '1.0.0',
      scope: 'personal',
      targets: ['claude-code'],
      source: { type: 'inline', content: '# hi' },
    });
    const profile = await createProfile(d, alice, {
      name: 'bundle-me',
      target: 'claude-code',
      scope: 'personal',
      entries: [{ mcpServerId: stdio.id }, { resourceId: skill.id, kind: 'skill' }],
    });
    const bundle = await buildDeployBundle(d, asCaller(alice), profile.id);
    expect(bundle.profile.id).toBe(profile.id);
    expect(bundle.artifacts).toEqual([
      { entryId: stdio.id, kind: 'mcp', mcpServer: expect.objectContaining({ id: stdio.id }) },
      { entryId: skill.id, kind: 'skill', resource: expect.objectContaining({ id: skill.id }) },
    ]);
    // Foreign callers do not even see the profile.
    await expect(buildDeployBundle(d, asCaller(bob), profile.id)).rejects.toMatchObject({
      statusCode: 404,
      code: 'PROFILE_NOT_FOUND',
    });
  });
});

describe('svc client-config — runtime-config bundle (machine PAT exception #3)', () => {
  async function machineWorld(d: ClientConfigDeps) {
    const { machine } = await enrollMachine(d, alice, { name: 'box' });
    await createCredential(d, alice, {
      name: 'gw-key',
      secret: 'sk-first',
      scope: 'personal',
    });
    const plan = await planRuntimeConfigUpsert(d, alice, machine.id, 'codex', {
      providerLabel: 'gw',
      baseUrl: 'https://gw.example.com/v1',
      api: 'openai',
      model: 'm1',
      credentialName: 'gw-key',
    });
    await saveRuntimeConfig(d, plan);
    return machine;
  }

  it('flat-404s every non-machine caller (no existence leak)', async () => {
    const d = deps();
    await machineWorld(d);
    for (const p of [alice, admin]) {
      await expect(buildRuntimeConfigBundle(d, asCaller(p), 'codex')).rejects.toMatchObject({
        statusCode: 404,
        code: 'RUNTIME_CONFIG_NOT_FOUND',
      });
    }
  });

  it('resolves {target, spec, secret} for the machine caller, with the DECRYPTED key', async () => {
    const d = deps();
    const machine = await machineWorld(d);
    const bundle = await buildRuntimeConfigBundle(d, asCaller(alice, machine.id), 'codex');
    expect(bundle).toMatchObject({
      target: 'codex',
      secret: 'sk-first',
      spec: { credentialName: 'gw-key', model: 'm1' },
    });
  });

  it('400s a missing target; 404s an unconfigured one', async () => {
    const d = deps();
    const machine = await machineWorld(d);
    const caller = asCaller(alice, machine.id);
    await expect(buildRuntimeConfigBundle(d, caller, undefined)).rejects.toMatchObject({
      statusCode: 400,
      code: 'TARGET_REQUIRED',
    });
    await expect(buildRuntimeConfigBundle(d, caller, 'deepseek')).rejects.toMatchObject({
      statusCode: 404,
      code: 'RUNTIME_CONFIG_NOT_FOUND',
    });
  });

  it('follows credential rotation (fresh resolution per fetch)', async () => {
    const d = deps();
    const machine = await machineWorld(d);
    const caller = asCaller(alice, machine.id);
    const cred = (await d.uow.credentials.findByName('gw-key', 'personal', alice.userId))!;
    await updateCredential(d, alice, cred.id, { secret: 'sk-rotated' });
    const bundle = await buildRuntimeConfigBundle(d, caller, 'codex');
    expect(bundle.secret).toBe('sk-rotated');
  });
});
