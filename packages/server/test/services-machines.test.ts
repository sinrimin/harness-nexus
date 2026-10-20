// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import type { Principal, ServiceDeps } from '../src/services/principal.js';
import {
  enrollMachine,
  getMachine,
  listMachines,
  purgeMachineRecords,
  updateMachine,
} from '../src/services/machines.js';
import { getAgentInstance, listMachineAgents } from '../src/services/agent-instances.js';

/**
 * #53 slice 3 — the machine + agent-instance reads, tested DIRECTLY against
 * the memory driver (no HTTP, no sockets). Pins the #36 owner-only rules and
 * the enroll/purge side effects at the door both callers share.
 */

const owner: Principal = { userId: 'u-owner', role: 'user' };
const stranger: Principal = { userId: 'u-stranger', role: 'user' };
const admin: Principal = { userId: 'u-admin', role: 'admin' };

function deps(): ServiceDeps {
  return { uow: createMemoryUnitOfWork() };
}

describe('svc machines — enroll', () => {
  it('creates the machine plus a machine-ctl PAT; the raw token is returned once', async () => {
    const d = deps();
    const { machine, token } = await enrollMachine(d, owner, { name: 'laptop' });
    expect(machine.name).toBe('laptop');
    expect(machine.ownerId).toBe(owner.userId);
    expect(machine.enrollmentPatId).toBeTruthy();
    expect(token).toMatch(/^hnpat_/);
    const pat = await d.uow.tokens.findById(machine.enrollmentPatId);
    expect(pat?.scopes).toEqual(['machine-ctl']);
    expect(pat?.name).toBe('machine: laptop');
    // Only the hash is stored — the raw token is not recoverable.
    expect(pat?.tokenHash).not.toContain(token);
  });
});

describe('svc machines — owner-only visibility (#36)', () => {
  it('strangers AND admins get the same 404 by id; lists are own-only', async () => {
    const d = deps();
    const { machine } = await enrollMachine(d, owner, { name: 'laptop' });
    for (const p of [stranger, admin]) {
      await expect(getMachine(d, p, machine.id)).rejects.toMatchObject({
        statusCode: 404,
        code: 'MACHINE_NOT_FOUND',
      });
    }
    expect((await listMachines(d, owner)).map((m) => m.id)).toEqual([machine.id]);
    expect(await listMachines(d, stranger)).toEqual([]);
    expect((await listMachines(d, admin)).map((m) => m.id)).toEqual([]); // admin ≠ fleet view
  });

  it('update applies replace-semantics fields only when present', async () => {
    const d = deps();
    const { machine } = await enrollMachine(d, owner, { name: 'laptop' });
    const renamed = await updateMachine(d, owner, machine.id, { name: 'desk' });
    expect(renamed.name).toBe('desk');
    expect(renamed.remoteChatEnabled).toBe(false); // untouched
    const toggled = await updateMachine(d, owner, machine.id, {
      remoteChatEnabled: true,
      chatDefaultMode: { 'claude-code': 'default' },
    });
    expect(toggled.remoteChatEnabled).toBe(true);
    expect(toggled.chatDefaultMode).toEqual({ 'claude-code': 'default' });
    await expect(updateMachine(d, stranger, machine.id, { name: 'x' })).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('svc machines — purgeMachineRecords', () => {
  it('removes runtime configs, snapshots, the enrollment PAT, then the row', async () => {
    const d = deps();
    const { machine } = await enrollMachine(d, owner, { name: 'laptop' });
    await d.uow.inventories.save({
      id: 'inv-1',
      machineId: machine.id,
      target: 'claude-code',
      daemonVersion: null,
      reportedAt: 'now',
      scannedAt: 'now',
      agents: [],
      runtime: null,
    });
    await purgeMachineRecords(d, machine);
    expect(await d.uow.machines.findById(machine.id)).toBeNull();
    expect(await d.uow.tokens.findById(machine.enrollmentPatId)).toBeNull();
    expect(await d.uow.inventories.list(machine.id)).toEqual([]);
  });
});

describe('svc agent-instances — reads', () => {
  it('lists an owner machine agents; hides the machine from others', async () => {
    const d = deps();
    const { machine } = await enrollMachine(d, owner, { name: 'laptop' });
    const now = new Date().toISOString();
    await d.uow.agentInstances.save({
      id: 'ag-1',
      machineId: machine.id,
      ownerId: owner.userId,
      target: 'claude-code',
      profileId: null,
      profileVersion: null,
      name: 'claude-code',
      directory: '/home/me/.claude',
      jobId: null,
      source: 'detected',
      createdAt: now,
      updatedAt: now,
    });
    expect((await listMachineAgents(d, owner, machine.id)).map((a) => a.id)).toEqual(['ag-1']);
    await expect(listMachineAgents(d, stranger, machine.id)).rejects.toMatchObject({
      statusCode: 404,
    });

    // Agent by id: owner-only (admin gets the same 404), machine row included.
    const got = await getAgentInstance(d, owner, 'ag-1');
    expect(got.machine.id).toBe(machine.id);
    for (const p of [stranger, admin]) {
      await expect(getAgentInstance(d, p, 'ag-1')).rejects.toMatchObject({
        statusCode: 404,
        code: 'AGENT_INSTANCE_NOT_FOUND',
      });
    }
  });
});
