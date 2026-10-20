// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import type { Principal, ServiceDeps } from '../src/services/principal.js';
import { enrollMachine } from '../src/services/machines.js';
import { prepareWorkspaceListing } from '../src/services/workspace.js';

/**
 * #53 slice 12 — the workspace listing's PURE half, tested DIRECTLY against
 * the memory driver (no HTTP, no sockets). The daemon round-trip (online
 * check, capability check, ctl emit, waiter) is route residue and stays
 * pinned by test/workspace.test.ts; these assert the owner-only gate and the
 * #33 containment math at the shared door.
 */

const owner: Principal = { userId: 'u-owner', role: 'user' };
const stranger: Principal = { userId: 'u-stranger', role: 'user' };
const admin: Principal = { userId: 'u-admin', role: 'admin' };

function deps(): ServiceDeps {
  return { uow: createMemoryUnitOfWork() };
}

/** Enroll a machine and set its base workspace directly on the row. */
async function machineWithBase(d: ServiceDeps, baseWorkspace: string | null) {
  const { machine } = await enrollMachine(d, owner, { name: 'box' });
  return d.uow.machines.save({ ...machine, baseWorkspace });
}

describe('svc workspace — listing preparation', () => {
  it('is owner-only: strangers and admins get the same 404 (#36)', async () => {
    const d = deps();
    const machine = await machineWithBase(d, '/home/w6/projects');
    for (const p of [stranger, admin]) {
      await expect(prepareWorkspaceListing(d, p, machine.id)).rejects.toMatchObject({
        statusCode: 404,
        code: 'MACHINE_NOT_FOUND',
      });
    }
  });

  it('400s while no base workspace is configured', async () => {
    const d = deps();
    const machine = await machineWithBase(d, null);
    await expect(prepareWorkspaceListing(d, owner, machine.id)).rejects.toMatchObject({
      statusCode: 400,
      code: 'WORKSPACE_ROOT_NOT_SET',
    });
  });

  it('400s for paths outside the root (after resolution)', async () => {
    const d = deps();
    const machine = await machineWithBase(d, '/home/w6/projects');
    for (const path of ['/home/w6/other', '/home/w6/projects/../secret', '/etc']) {
      await expect(prepareWorkspaceListing(d, owner, machine.id, path)).rejects.toMatchObject({
        statusCode: 400,
        code: 'WORKSPACE_OUTSIDE_ROOT',
      });
    }
  });

  it('defaults to the root and resolves contained subpaths', async () => {
    const d = deps();
    const machine = await machineWithBase(d, '/home/w6/projects/');
    const root = await prepareWorkspaceListing(d, owner, machine.id);
    expect(root.requested).toBe('/home/w6/projects');
    expect(root.root).toBe('/home/w6/projects');
    // `..` INSIDE a contained absolute path resolves back under the root.
    // (Relative paths are not a thing the picker sends — resolve() would
    // anchor them to the server's cwd and they 400 as outside-root.)
    const sub = await prepareWorkspaceListing(
      d,
      owner,
      machine.id,
      '/home/w6/projects/alpha/../beta',
    );
    expect(sub.requested).toBe('/home/w6/projects/beta');
  });
});
