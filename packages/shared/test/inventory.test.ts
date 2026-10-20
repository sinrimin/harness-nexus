// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
  captureMachineInventorySchema,
  diffInventory,
  importMachineInventorySchema,
  inventoryItemSchema,
  inventoryReportEventSchema,
  inventorySnapshotSchema,
  inventoryPayloadEventSchema,
  runtimeInfoSchema,
  RUNTIME_TARGETS,
  type InventoryItem,
} from '../src/index.js';

const item = (over: Partial<InventoryItem> & Pick<InventoryItem, 'kind' | 'name'>): InventoryItem =>
  inventoryItemSchema.parse({
    origin: 'local',
    path: `~/${over.name}`,
    importable: true,
    ...over,
  });

describe('inventorySnapshotSchema', () => {
  it('accepts a well-formed snapshot and defaults nothing silently', () => {
    const parsed = inventorySnapshotSchema.parse({
      target: 'claude-code',
      scannedAt: new Date().toISOString(),
      agents: [
        {
          name: '~/.claude',
          directory: '/home/me/.claude',
          profileApplied: null,
          items: [
            {
              kind: 'skill',
              name: 'docx',
              origin: 'platform',
              path: 'skills/docx',
              importable: true,
              summary: 'Work with Word documents',
              meta: { multi: true },
            },
          ],
        },
      ],
    });
    expect(parsed.agents[0]!.items[0]!.meta?.multi).toBe(true);
  });

  it('rejects an empty agents array and non-datetime scannedAt', () => {
    const base = { target: 'codex', scannedAt: new Date().toISOString() };
    expect(inventorySnapshotSchema.safeParse({ ...base, agents: [] }).success).toBe(false);
    expect(
      inventorySnapshotSchema.safeParse({
        target: 'codex',
        scannedAt: 'yesterday',
        agents: [
          { name: '~/.codex', directory: '/home/me/.codex', profileApplied: false, items: [] },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('runtimeInfoSchema (phase 9 W1)', () => {
  it('accepts an installed runtime and a bare not-installed arm', () => {
    expect(
      runtimeInfoSchema.safeParse({
        target: 'claude-code',
        installed: true,
        binPath: '/home/me/.local/bin/claude',
        version: '2.1.211 (Claude Code)',
        installMethod: 'native',
      }).success,
    ).toBe(true);
    expect(runtimeInfoSchema.safeParse({ target: 'codex', installed: false }).success).toBe(true);
  });

  it('rejects non-runtime targets and bad install methods', () => {
    expect(runtimeInfoSchema.safeParse({ target: 'hermes', installed: true }).success).toBe(false);
    expect(
      runtimeInfoSchema.safeParse({ target: 'codex', installed: true, installMethod: 'scoop' })
        .success,
    ).toBe(false);
  });

  it('RUNTIME_TARGETS is the managed subset of scannable targets', () => {
    expect(RUNTIME_TARGETS).toEqual(['claude-code', 'codex', 'deepseek', 'opencode', 'pi']);
  });

  it('accepts opencode as an AgentTarget and RuntimeTarget (9 W12)', () => {
    expect(
      runtimeInfoSchema.safeParse({ target: 'opencode', installed: true, version: '1.18.31' })
        .success,
    ).toBe(true);
  });

  it('accepts pi as an AgentTarget and RuntimeTarget (9 W16)', () => {
    expect(
      runtimeInfoSchema.safeParse({ target: 'pi', installed: true, version: '0.85.1' }).success,
    ).toBe(true);
  });
});

describe('inventory realtime event schemas', () => {
  it('report event validates the nested snapshot', () => {
    const ok = inventoryReportEventSchema.safeParse({
      requestId: 'req-1',
      snapshot: {
        target: 'hermes',
        scannedAt: new Date().toISOString(),
        agents: [
          { name: '~/.hermes', directory: '/home/me/.hermes', profileApplied: false, items: [] },
        ],
      },
    });
    expect(ok.success).toBe(true);
    expect(inventoryReportEventSchema.safeParse({ snapshot: { target: 'nope' } }).success).toBe(
      false,
    );
  });

  it('report event carries the W1 runtimes arm (optional, per-cycle probe)', () => {
    const base = {
      snapshot: {
        target: 'claude-code',
        scannedAt: new Date().toISOString(),
        agents: [
          { name: '~/.claude', directory: '/home/me/.claude', profileApplied: false, items: [] },
        ],
      },
    };
    const ok = inventoryReportEventSchema.safeParse({
      ...base,
      runtimes: [
        { target: 'claude-code', installed: true, version: '2.1.211 (Claude Code)' },
        { target: 'codex', installed: false },
        { target: 'deepseek', installed: false },
      ],
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.runtimes).toHaveLength(3);
    // absent on old daemons — still valid
    expect(inventoryReportEventSchema.safeParse(base).success).toBe(true);
    // hermes is not a runtime target
    expect(
      inventoryReportEventSchema.safeParse({
        ...base,
        runtimes: [{ target: 'hermes', installed: false }],
      }).success,
    ).toBe(false);
  });

  it('payload event carries redacted mcp artifacts', () => {
    const ok = inventoryPayloadEventSchema.safeParse({
      requestId: 'req-2',
      items: [
        {
          kind: 'mcp',
          name: 'github',
          ok: true,
          artifact: {
            kind: 'mcp',
            transport: {
              type: 'stdio',
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-github'],
              env: { GITHUB_TOKEN: '${cred:GITHUB_TOKEN}' },
            },
          },
        },
        { kind: 'command', name: 'deploy', ok: false, error: 'too-large' },
      ],
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.items[0].artifact?.kind).toBe('mcp');
    }
  });
});

describe('importMachineInventorySchema', () => {
  it('requires at least one item and a profile name', () => {
    expect(
      importMachineInventorySchema.safeParse({ target: 'codex', profileName: '', items: [] })
        .success,
    ).toBe(false);
    expect(
      importMachineInventorySchema.safeParse({
        target: 'codex',
        profileName: 'My import',
        items: [{ kind: 'skill', name: 'docx' }],
      }).success,
    ).toBe(true);
  });
});

describe('captureMachineInventorySchema (phase 9 W1)', () => {
  it('takes a target and a profile name — no items (all importables are captured)', () => {
    expect(
      captureMachineInventorySchema.safeParse({ target: 'codex', profileName: 'My capture' })
        .success,
    ).toBe(true);
    expect(
      captureMachineInventorySchema.safeParse({ target: 'codex', profileName: '' }).success,
    ).toBe(false);
  });
});

describe('diffInventory', () => {
  it('matches by (kind, name) and splits missing vs candidates', () => {
    const items = [
      item({ kind: 'skill', name: 'docx', origin: 'platform' }),
      item({ kind: 'command', name: 'deploy' }),
      item({ kind: 'skill', name: 'scratch-notes' }),
      item({ kind: 'sub_agent', name: 'reviewer', origin: 'platform' }),
    ];
    const diff = diffInventory(
      [
        { kind: 'skill', name: 'docx' }, // on machine, platform-written
        { kind: 'command', name: 'deploy' }, // on machine, local origin — matched, not a candidate
        { kind: 'skill', name: 'pdf' }, // profile entry with no artifact
      ],
      items,
    );
    expect(diff.upToDate).toEqual([
      { kind: 'skill', name: 'docx', origin: 'platform' },
      { kind: 'command', name: 'deploy', origin: 'local' },
    ]);
    expect(diff.missingOnMachine).toEqual([{ kind: 'skill', name: 'pdf' }]);
    expect(diff.notInProfile.map((i) => i.name)).toEqual(['scratch-notes']);
    expect(diff.summary).toEqual({ profileEntries: 3, applied: 2, missing: 1, candidates: 1 });
  });

  it('treats the MCP arm coarsely — one platform shim entry applies every mcp entry', () => {
    const withShim = [item({ kind: 'mcp', name: 'harness-nexus-my-profile', origin: 'platform' })];
    const entries = [
      { kind: 'mcp', name: 'github' },
      { kind: 'mcp', name: 'postgres' },
    ];
    expect(diffInventory(entries, withShim).missingOnMachine).toEqual([]);
    expect(diffInventory(entries, withShim).summary.applied).toBe(2);
    expect(diffInventory(entries, []).missingOnMachine.map((e) => e.name)).toEqual([
      'github',
      'postgres',
    ]);
  });

  it('never lists local mcp items or foreign platform items as candidates', () => {
    const items = [
      item({ kind: 'mcp', name: 'my-local-server' }),
      item({ kind: 'skill', name: 'other-profile-skill', origin: 'platform' }),
    ];
    const diff = diffInventory([{ kind: 'skill', name: 'docx' }], items);
    expect(diff.notInProfile).toEqual([]);
    expect(diff.missingOnMachine).toEqual([{ kind: 'skill', name: 'docx' }]);
  });
});
