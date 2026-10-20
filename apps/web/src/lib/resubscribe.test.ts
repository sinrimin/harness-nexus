// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import { createResubscribeGate } from './resubscribe';

/**
 * #66 — the reconnect-only gate: silent socket.io reconnects (weak network,
 * lock screen) are NEW connections with no chan-room membership while the
 * SPA stays mounted; registered recovery actions must fire on
 * connect-after-disconnect and NEVER on the first connect (pages mount after
 * it and run their own open flows).
 */
describe('#66 createResubscribeGate', () => {
  it('the first connect fires nothing; a reconnect fires registered actions', () => {
    const gate = createResubscribeGate();
    const fired: string[] = [];
    gate.subscribe(() => fired.push('a'));
    gate.onConnect();
    expect(fired).toEqual([]);

    gate.onConnect(); // the reconnect
    expect(fired).toEqual(['a']);
  });

  it('unregistered actions stop firing; registrations after a disconnect still arm', () => {
    const gate = createResubscribeGate();
    gate.onConnect(); // first connect
    const fired: string[] = [];
    const off = gate.subscribe(() => fired.push('a'));
    gate.subscribe(() => fired.push('b'));
    off();
    gate.onConnect();
    expect(fired).toEqual(['b']);
  });
});
