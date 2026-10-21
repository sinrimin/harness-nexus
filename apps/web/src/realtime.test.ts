// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * #77 — the app socket singleton must not outlive its user: the auth
 * callback only runs at CONNECT time, so a live connection never
 * re-authenticates. logout/login drop the singleton; the next appSocket()
 * builds a fresh connection carrying the then-stored token.
 */

const created: { disconnect: ReturnType<typeof vi.fn> }[] = [];

vi.mock('socket.io-client', () => ({
  io: (_url: string, _opts: unknown) => {
    const s = { disconnect: vi.fn(), on: vi.fn(), emit: vi.fn(), off: vi.fn() };
    created.push(s);
    return s;
  },
}));

const { appSocket, dropAppSocket } = await import('./realtime.js');

afterEach(() => {
  dropAppSocket();
  created.length = 0;
});

describe('#77 — dropAppSocket', () => {
  it('disconnects the singleton; the next appSocket() is a fresh connection', () => {
    const first = appSocket();
    expect(created).toHaveLength(1);

    dropAppSocket();
    expect(first.disconnect).toHaveBeenCalledTimes(1);

    const second = appSocket();
    expect(second).not.toBe(first);
    expect(created).toHaveLength(2);
  });

  it('dropping without a live socket is a no-op', () => {
    expect(() => dropAppSocket()).not.toThrow();
    expect(created).toHaveLength(0);
  });
});
