// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import type { Credential, Profile } from '@harness-nexus/core';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import type { Principal, ServiceDeps } from '../src/services/principal.js';
import {
  assertServerDialedOwned,
  createMcpServer,
  deleteMcpServer,
  listMcpServers,
  updateMcpServer,
  visibleMcpServerIds,
} from '../src/services/mcp-servers.js';

/**
 * #53 slice 8 — the MCP server domain service, tested DIRECTLY against the
 * memory driver (no HTTP, no Fastify, no registry: the pool interplay is
 * route residue). The route tests keep pinning the wire end-to-end
 * (status-filter.test.ts, registry-resilience.test.ts); these assert the
 * #36 scope rules and the dial-site gates at the door both callers share.
 */

const owner: Principal = { userId: 'u-owner', role: 'user' };
const stranger: Principal = { userId: 'u-stranger', role: 'user' };
const admin: Principal = { userId: 'u-admin', role: 'admin' };

function deps(): ServiceDeps {
  return { uow: createMemoryUnitOfWork() };
}

const now = '2026-10-14T00:00:00.000Z';

/** Seed a credential row (only name/scope/distributable drive the gates). */
async function seedCred(d: ServiceDeps, over: Partial<Credential>): Promise<Credential> {
  const cred: Credential = {
    id: 'cred-' + Math.random().toString(36).slice(2, 8),
    name: 'k',
    secret: 'opaque',
    scope: 'global',
    ownerId: null,
    distributable: false,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
  await d.uow.credentials.save(cred);
  return cred;
}

const serverInput = (over: Record<string, unknown> = {}) =>
  ({
    name: 'up',
    dialSite: 'client',
    scope: 'personal',
    transport: { type: 'streamable-http', url: 'https://x.example.com/mcp' },
    ...over,
  }) as Parameters<typeof createMcpServer>[2];

describe('svc mcp-servers — scope rules (#36, no HTTP)', () => {
  it('personal rows are owner-only: strangers and admins get the same 404', async () => {
    const d = deps();
    const created = await createMcpServer(d, owner, serverInput({ dialSite: 'server' }));

    for (const p of [stranger, admin]) {
      await expect(updateMcpServer(d, p, created.id, { name: 'x' })).rejects.toMatchObject({
        statusCode: 404,
        code: 'MCP_SERVER_NOT_FOUND',
      });
      await expect(deleteMcpServer(d, p, created.id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(assertServerDialedOwned(d, p, created.id)).rejects.toMatchObject({
        statusCode: 404,
      });
    }
    expect((await listMcpServers(d, owner)).map((s) => s.id)).toContain(created.id);
    expect((await listMcpServers(d, stranger)).map((s) => s.id)).not.toContain(created.id);
  });

  it('global create is admin-only; global rows list and stay admin-manageable', async () => {
    const d = deps();
    await expect(createMcpServer(d, owner, serverInput({ scope: 'global' }))).rejects.toMatchObject(
      { statusCode: 403 },
    );
    const global = await createMcpServer(d, admin, serverInput({ scope: 'global' }));
    expect((await listMcpServers(d, stranger)).map((s) => s.id)).toContain(global.id);
    await expect(updateMcpServer(d, stranger, global.id, { name: 'x' })).rejects.toMatchObject({
      statusCode: 404,
    });
    await expect(updateMcpServer(d, admin, global.id, { name: 'renamed' })).resolves.toBeTruthy();
  });
});

describe('svc mcp-servers — dial-site gates (Phase 8 C2)', () => {
  it('stdio can never resolve to server — explicit or via a locked credential', async () => {
    const d = deps();
    // Explicit override.
    await expect(
      createMcpServer(
        d,
        owner,
        serverInput({
          dialSite: 'server',
          transport: { type: 'stdio', command: 'npx', args: ['-y', 'some-mcp'] },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'STDIO_REQUIRES_CLIENT' });
    // auto + non-distributable credential → resolves server → refused.
    const locked = await seedCred(d, { name: 'locked', distributable: false });
    await expect(
      createMcpServer(
        d,
        owner,
        serverInput({
          dialSite: 'auto',
          transport: {
            type: 'stdio',
            command: 'some-mcp',
            env: { KEY: `\${cred:${locked.name}}` },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'STDIO_REQUIRES_CLIENT' });
    // Explicit client is the only home for stdio.
    await expect(
      createMcpServer(
        d,
        owner,
        serverInput({
          transport: { type: 'stdio', command: 'some-mcp' },
        }),
      ),
    ).resolves.toBeTruthy();
  });

  it('explicit client must not ship a stored, non-distributable credential', async () => {
    const d = deps();
    const locked = await seedCred(d, { name: 'locked', distributable: false });
    const open = await seedCred(d, { name: 'open', distributable: true });

    await expect(
      createMcpServer(
        d,
        owner,
        serverInput({
          transport: {
            type: 'streamable-http',
            url: 'https://x.example.com/mcp',
            headers: { authorization: `Bearer \${cred:${locked.name}}` },
          },
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CREDENTIAL_NOT_DISTRIBUTABLE' });

    // A distributable credential ships fine; auto + locked is allowed too
    // (silently routed to `server` — the derived default doing its job).
    await expect(
      createMcpServer(
        d,
        owner,
        serverInput({
          transport: {
            type: 'streamable-http',
            url: 'https://x.example.com/mcp',
            headers: { authorization: `Bearer \${cred:${open.name}}` },
          },
        }),
      ),
    ).resolves.toBeTruthy();
    await expect(
      createMcpServer(
        d,
        owner,
        serverInput({
          dialSite: 'auto',
          transport: {
            type: 'streamable-http',
            url: 'https://x.example.com/mcp',
            headers: { authorization: `Bearer \${cred:${locked.name}}` },
          },
        }),
      ),
    ).resolves.toBeTruthy();
  });

  it('assertServerDialedOwned refuses client-resolved rows with 409 NOT_SERVER_DIALED', async () => {
    const d = deps();
    const locked = await seedCred(d, { name: 'locked', distributable: false });
    const clientRow = await createMcpServer(d, owner, serverInput());
    const autoToServer = await createMcpServer(
      d,
      owner,
      serverInput({
        dialSite: 'auto',
        transport: {
          type: 'streamable-http',
          url: 'https://x.example.com/mcp',
          headers: { authorization: `Bearer \${cred:${locked.name}}` },
        },
      }),
    );
    const serverRow = await createMcpServer(d, owner, serverInput({ dialSite: 'server' }));

    await expect(assertServerDialedOwned(d, owner, clientRow.id)).rejects.toMatchObject({
      statusCode: 409,
      code: 'NOT_SERVER_DIALED',
    });
    await expect(assertServerDialedOwned(d, owner, autoToServer.id)).resolves.toBeUndefined();
    await expect(assertServerDialedOwned(d, owner, serverRow.id)).resolves.toBeUndefined();
  });
});

describe('svc mcp-servers — two-stage delete', () => {
  it('soft hides from lists; hard removal waits until no profile references it', async () => {
    const d = deps();
    const created = await createMcpServer(d, owner, serverInput());
    const profile: Profile = {
      id: 'prof-1',
      name: 'P',
      version: '0.1',
      target: 'claude-code',
      scope: 'personal',
      ownerId: owner.userId,
      entries: [{ resourceId: created.id, kind: 'mcp' }],
      createdAt: now,
      updatedAt: now,
    };
    await d.uow.profiles.save(profile);

    expect((await deleteMcpServer(d, owner, created.id)).mode).toBe('soft');
    expect((await listMcpServers(d, owner)).some((s) => s.id === created.id)).toBe(false);
    expect(
      (await listMcpServers(d, owner, { includeDeleted: true })).some((s) => s.id === created.id),
    ).toBe(true);

    await expect(deleteMcpServer(d, owner, created.id)).rejects.toMatchObject({
      statusCode: 409,
      code: 'ASSET_STILL_REFERENCED',
    });
    await d.uow.profiles.delete(profile.id);
    expect((await deleteMcpServer(d, owner, created.id)).mode).toBe('hard');
  });
});

describe('svc mcp-servers — status visibility set (#21/#36)', () => {
  it('visibleMcpServerIds = own personal + global, for every role', async () => {
    const d = deps();
    const mine = await createMcpServer(d, owner, serverInput());
    const theirs = await createMcpServer(d, stranger, serverInput());
    const global = await createMcpServer(d, admin, serverInput({ scope: 'global' }));

    const ownerIds = await visibleMcpServerIds(d, owner);
    expect(ownerIds.has(mine.id)).toBe(true);
    expect(ownerIds.has(global.id)).toBe(true);
    expect(ownerIds.has(theirs.id)).toBe(false);

    const adminIds = await visibleMcpServerIds(d, admin);
    expect(adminIds.has(theirs.id)).toBe(false); // #36: admins are not overseers
    expect(adminIds.has(global.id)).toBe(true);
  });
});
