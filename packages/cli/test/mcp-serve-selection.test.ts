// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import type { ClientMcpConfig } from '@harness-nexus/shared';
import { selectionFromConfig } from '../src/mcp/serve.js';

/**
 * #113 — the shim's selection map: the config's pinned subsets become the
 * pool's closed-world enforcement on the client-dialed path (the one path
 * that bypasses the platform outlet, so the config is the only carrier).
 * The map's shape is the whole contract: pin → Set, whole-server → 'all',
 * outlet → 'all' when armed — and nothing else (an upstream the map does
 * not know contributes nothing and takes no calls).
 */
const clientServer = (id: string, tools?: string[]) => ({
  id,
  name: `srv-${id}`,
  dialSite: 'client' as const,
  transport: { type: 'stdio' as const, command: 'echo' },
  ...(tools !== undefined ? { tools } : {}),
});

describe('selectionFromConfig (#113)', () => {
  it("pinned entries map to their allow-set; whole-server entries map to 'all'", () => {
    const cfg: ClientMcpConfig = {
      profileId: 'p1',
      platform: null,
      servers: [clientServer('a', ['alpha', 'beta']), clientServer('b')],
    };
    const sel = selectionFromConfig(cfg);
    expect(sel.size).toBe(2);
    expect(sel.get('a')).toEqual(new Set(['alpha', 'beta']));
    expect(sel.get('b')).toBe('all');
  });

  it('the armed outlet maps to all; a null platform contributes nothing', () => {
    const armed = selectionFromConfig({
      profileId: 'p1',
      platform: { baseUrl: 'https://hnx.example.com' },
      servers: [clientServer('a')],
    });
    expect(armed.get('__outlet__')).toBe('all');

    const bare = selectionFromConfig({
      profileId: 'p1',
      platform: null,
      servers: [clientServer('a')],
    });
    expect(bare.has('__outlet__')).toBe(false);
  });

  it('server-dialed entries are not mapped (their tools ride the gated outlet)', () => {
    const sel = selectionFromConfig({
      profileId: 'p1',
      platform: { baseUrl: 'https://hnx.example.com' },
      servers: [
        clientServer('a', ['alpha']),
        { id: 's1', name: 'server-dialed', dialSite: 'server' },
      ],
    });
    expect([...sel.keys()].sort()).toEqual(['__outlet__', 'a']);
  });
});
