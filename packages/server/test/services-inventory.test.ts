// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import type { Machine, MachineInventorySnapshot } from '@harness-nexus/core';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import type { Principal, ServiceDeps } from '../src/services/principal.js';
import { enrollMachine } from '../src/services/machines.js';
import {
  bundleImport,
  diffMachineInventory,
  listMachineInventory,
  resolveCaptureSelection,
  resolveImportSelection,
} from '../src/services/inventory.js';

/**
 * #53 slice 3 — the inventory service, tested DIRECTLY against the memory
 * driver (no HTTP, no /ctl socket). The route keeps the realtime halves (scan
 * waiter, collect round-trip); these pin the decisions and the reuse-or-create
 * pipeline that moved.
 */

const owner: Principal = { userId: 'u-owner', role: 'user' };
const stranger: Principal = { userId: 'u-stranger', role: 'user' };

function deps(): ServiceDeps {
  return { uow: createMemoryUnitOfWork() };
}

const item = (over: Partial<MachineInventorySnapshot['agents'][number]['items'][number]> = {}) => ({
  kind: 'skill' as const,
  name: 'docx',
  origin: 'local' as const,
  path: 'skills/docx',
  importable: true,
  ...over,
});

async function seededMachine(
  d: ServiceDeps,
  items: MachineInventorySnapshot['agents'][number]['items'][number][],
): Promise<Machine> {
  const { machine } = await enrollMachine(d, owner, { name: 'laptop' });
  await d.uow.inventories.save({
    id: 'snap-1',
    machineId: machine.id,
    target: 'claude-code',
    daemonVersion: '0.2.0-test',
    reportedAt: '2026-10-14T00:00:00Z',
    scannedAt: '2026-10-14T00:00:00Z',
    agents: [{ name: '~/.claude', directory: '/home/me/.claude', profileApplied: false, items }],
    runtime: null,
  });
  return machine;
}

describe('svc inventory — visibility & diff', () => {
  it('snapshots are owner-only: stranger gets the machine 404, not the list', async () => {
    const d = deps();
    const machine = await seededMachine(d, [item()]);
    expect((await listMachineInventory(d, owner, machine.id)).map((s) => s.target)).toEqual([
      'claude-code',
    ]);
    await expect(listMachineInventory(d, stranger, machine.id)).rejects.toMatchObject({
      statusCode: 404,
      code: 'MACHINE_NOT_FOUND',
    });
  });

  it('diff requires ?profile=, hides foreign profiles, needs a scanned target', async () => {
    const d = deps();
    const machine = await seededMachine(d, [item()]);
    await expect(diffMachineInventory(d, owner, machine.id, undefined)).rejects.toMatchObject({
      statusCode: 400,
      code: 'PROFILE_REQUIRED',
    });
    // A personal profile of ANOTHER user is existence-hidden (404).
    await d.uow.profiles.save({
      id: 'p-foreign',
      name: 'theirs',
      description: null,
      version: '0.1.0',
      target: 'claude-code',
      scope: 'personal',
      ownerId: stranger.userId,
      entries: [],
      createdAt: 'now',
      updatedAt: 'now',
    });
    await expect(diffMachineInventory(d, owner, machine.id, 'p-foreign')).rejects.toMatchObject({
      statusCode: 404,
      code: 'PROFILE_NOT_FOUND',
    });
    // A visible profile but an unscanned target → 404 INVENTORY_NOT_SCANNED.
    await d.uow.profiles.save({
      id: 'p-mine',
      name: 'mine',
      description: null,
      version: '0.1.0',
      target: 'codex',
      scope: 'personal',
      ownerId: owner.userId,
      entries: [],
      createdAt: 'now',
      updatedAt: 'now',
    });
    await expect(diffMachineInventory(d, owner, machine.id, 'p-mine')).rejects.toMatchObject({
      statusCode: 404,
      code: 'INVENTORY_NOT_SCANNED',
    });
  });
});

describe('svc inventory — resolve selection', () => {
  it('import rejects items missing from the snapshot or not importable', async () => {
    const d = deps();
    const machine = await seededMachine(d, [
      item(),
      item({ kind: 'command', name: 'deploy', path: 'commands/deploy.md' }),
      item({ kind: 'rule', name: 'binary', importable: false, note: 'binary' }),
    ]);
    const input = {
      target: 'claude-code' as const,
      profileName: 'imp',
      items: [{ kind: 'skill' as const, name: 'docx' }],
    };
    await expect(
      resolveImportSelection(d, machine, {
        ...input,
        items: [{ kind: 'skill', name: 'never-scanned' }],
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'INVENTORY_ITEM_MISSING' });
    await expect(
      resolveImportSelection(d, machine, {
        ...input,
        items: [{ kind: 'rule', name: 'binary' }],
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'INVENTORY_ITEM_NOT_IMPORTABLE' });
    await expect(resolveImportSelection(d, machine, input)).resolves.toBeTruthy();

    // Capture: only the importable items are selected.
    const cap = await resolveCaptureSelection(d, machine, {
      target: 'claude-code',
      profileName: 'cap',
    });
    expect(cap.items).toEqual([
      { kind: 'skill', name: 'docx' },
      { kind: 'command', name: 'deploy' },
    ]);
  });
});

describe('svc inventory — bundleImport (reuse-or-create)', () => {
  it('reuses identical bodies, suffixes changed ones, warns on missing credentials', async () => {
    const d = deps();
    const machine = await seededMachine(d, [item({ summary: 'Word documents' })]);
    const payload = [
      {
        kind: 'skill' as const,
        name: 'docx',
        ok: true,
        artifact: {
          kind: 'skill' as const,
          files: { 'SKILL.md': '# docx', 'references/a.md': 'x' },
        },
      },
      {
        kind: 'mcp' as const,
        name: 'github',
        ok: true,
        artifact: {
          kind: 'mcp' as const,
          transport: {
            type: 'stdio' as const,
            command: 'npx',
            args: [],
            env: { GITHUB_TOKEN: '${cred:GITHUB_TOKEN}' },
          },
        },
      },
    ];

    const first = await bundleImport(d, {
      machine,
      snapshot: (await d.uow.inventories.findLatest(machine.id, 'claude-code'))!,
      target: 'claude-code',
      profileName: 'Laptop import',
      payloadItems: payload,
      mode: 'import',
    });
    expect(first.created.map((c) => c.kind).sort()).toEqual(['mcp', 'skill']);
    expect(first.profile.entries).toHaveLength(2);
    expect(first.warnings.some((w) => w.includes('GITHUB_TOKEN'))).toBe(true);

    // Identical bodies → full reuse, nothing new created.
    const again = await bundleImport(d, {
      machine,
      snapshot: (await d.uow.inventories.findLatest(machine.id, 'claude-code'))!,
      target: 'claude-code',
      profileName: 'Again',
      payloadItems: payload,
      mode: 'import',
    });
    expect(again.created).toEqual([]);
    expect(again.reused.map((r) => r.name).sort()).toEqual(['docx', 'github']);

    // A CHANGED body lands under a suffixed key, keeping the original.
    const changed = await bundleImport(d, {
      machine,
      snapshot: (await d.uow.inventories.findLatest(machine.id, 'claude-code'))!,
      target: 'claude-code',
      profileName: 'Changed',
      payloadItems: [
        {
          kind: 'skill',
          name: 'docx',
          ok: true,
          artifact: { kind: 'skill', files: { 'SKILL.md': '# docx v2', 'references/a.md': 'x' } },
        },
      ],
      mode: 'import',
    });
    expect(changed.created.map((c) => c.key)).toEqual(['skill:docx-2']);
    expect(
      (await d.uow.resources.findByKey('skill:docx', 'personal', owner.userId))!.source,
    ).toBeTruthy();
  });

  it('an unsafe daemon-reported bundle path fails the item, stores nothing', async () => {
    const d = deps();
    const machine = await seededMachine(d, [item({ name: 'walker' })]);
    const args = {
      machine,
      snapshot: (await d.uow.inventories.findLatest(machine.id, 'claude-code'))!,
      target: 'claude-code' as const,
      profileName: 'Evil',
      payloadItems: [
        {
          kind: 'skill' as const,
          name: 'walker',
          ok: true,
          artifact: {
            kind: 'skill' as const,
            files: { 'SKILL.md': '# walker', '../../../.ssh/authorized_keys': 'evil' },
          },
        },
      ],
      mode: 'import' as const,
    };
    // The only item failed → INVENTORY_COLLECT_FAILED with the per-item error.
    await expect(bundleImport(d, args)).rejects.toMatchObject({
      statusCode: 409,
      code: 'INVENTORY_COLLECT_FAILED',
    });
    // Nothing was stored — no walker resource exists under any key.
    expect(await d.uow.resources.findByKey('skill:walker', 'personal', owner.userId)).toBeNull();
    expect((await d.uow.profiles.listAll()).some((p) => p.name === 'Evil')).toBe(false);
  });

  it('capture of an empty snapshot is a zero-entry profile', async () => {
    const d = deps();
    const machine = await seededMachine(d, []);
    const result = await bundleImport(d, {
      machine,
      snapshot: (await d.uow.inventories.findLatest(machine.id, 'claude-code'))!,
      target: 'claude-code',
      profileName: 'empty',
      payloadItems: [],
      mode: 'capture',
    });
    expect(result.profile.entries).toEqual([]);
    expect(result.profile.description).toContain('Captured from machine');
  });
});
