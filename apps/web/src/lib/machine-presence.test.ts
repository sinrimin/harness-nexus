import { describe, expect, it } from 'vitest';
import type { MachineView } from '@harness-nexus/sdk';
import { patchMachine, patchMachineList } from './machine-presence.js';

function machine(over: Partial<MachineView> = {}): MachineView {
  return {
    id: 'm1',
    name: 'dev-laptop',
    hostname: 'dev-laptop',
    os: 'linux',
    arch: 'x64',
    daemonVersion: '0.9.4',
    online: false,
    lastSeenAt: null,
    enrolledAt: '2026-09-01T00:00:00.000Z',
    capabilities: ['chat'],
    baseWorkspace: null,
    remoteChatEnabled: false,
    ...over,
  } as MachineView;
}

describe('patchMachine', () => {
  it('applies presence to the matching machine', () => {
    const next = patchMachine(machine(), {
      machineId: 'm1',
      online: true,
      lastSeenAt: '2026-09-25T10:00:00.000Z',
    });
    expect(next.online).toBe(true);
    expect(next.lastSeenAt).toBe('2026-09-25T10:00:00.000Z');
  });

  it('keeps the version a push leaves out — a blind spread would blank it', () => {
    const next = patchMachine(machine(), {
      machineId: 'm1',
      online: true,
      lastSeenAt: null,
    });
    expect(next.daemonVersion).toBe('0.9.4');
  });

  it('takes the version a push carries', () => {
    const next = patchMachine(machine(), {
      machineId: 'm1',
      online: true,
      lastSeenAt: null,
      daemonVersion: '0.9.5',
    });
    expect(next.daemonVersion).toBe('0.9.5');
  });

  it('leaves another machine untouched — same reference, no wasted render', () => {
    const other = machine({ id: 'm2' });
    expect(patchMachine(other, { machineId: 'm1', online: true, lastSeenAt: null })).toBe(other);
  });

  it('preserves identity and the fields a push does not speak about', () => {
    const before = machine({ name: 'renamed', capabilities: ['chat', 'npm'] });
    const after = patchMachine(before, { machineId: 'm1', online: true, lastSeenAt: null });
    expect(after.name).toBe('renamed');
    expect(after.capabilities).toEqual(['chat', 'npm']);
    expect(after.enrolledAt).toBe(before.enrolledAt);
  });
});

describe('patchMachineList', () => {
  it('patches the row and keeps the list order', () => {
    const list = [machine(), machine({ id: 'm2', name: 'srv' })];
    const next = patchMachineList(list, { machineId: 'm2', online: true, lastSeenAt: null });
    expect(next?.map((m) => [m.id, m.online])).toEqual([
      ['m1', false],
      ['m2', true],
    ]);
  });

  it('passes a not-yet-loaded list through as null', () => {
    expect(patchMachineList(null, { machineId: 'm1', online: true, lastSeenAt: null })).toBeNull();
  });
});
