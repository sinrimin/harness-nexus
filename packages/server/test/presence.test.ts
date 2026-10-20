// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { MachinePresence } from '../src/realtime/presence.js';

describe('MachinePresence', () => {
  it('transitions offline → online on the first socket only', () => {
    const p = new MachinePresence();
    expect(p.connected('m1', 's1')).toBe(true);
    expect(p.connected('m1', 's2')).toBe(false); // second socket, still online
    expect(p.isOnline('m1')).toBe(true);
    expect(p.listOnline()).toEqual(['m1']);
  });

  it('goes offline only when the last socket disconnects', () => {
    const p = new MachinePresence();
    p.connected('m1', 's1');
    p.connected('m1', 's2');
    expect(p.disconnected('s1')).toBeNull(); // s2 still holds it online
    expect(p.isOnline('m1')).toBe(true);
    expect(p.disconnected('s2')).toBe('m1'); // last socket → offline
    expect(p.isOnline('m1')).toBe(false);
  });

  it('ignores unknown socket disconnects', () => {
    const p = new MachinePresence();
    expect(p.disconnected('nope')).toBeNull();
  });

  it('forceOffline clears every socket of the machine (token revoke)', () => {
    const p = new MachinePresence();
    p.connected('m1', 's1');
    p.connected('m1', 's2');
    p.connected('m2', 's3');
    expect(p.forceOffline('m1')).toBe(true);
    expect(p.isOnline('m1')).toBe(false);
    expect(p.isOnline('m2')).toBe(true); // untouched
    // Stale sockets of m1 no longer affect presence.
    expect(p.disconnected('s1')).toBeNull();
    expect(p.forceOffline('m1')).toBe(false); // was already offline
  });
});
