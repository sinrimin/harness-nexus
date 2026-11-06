// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PINNED_ADAPTER_SPECS,
  pinnedSpecParts,
  resolveAcpCommand,
} from '../src/daemon/acp/adapters.js';

/**
 * Issue #2 — pinned adapter resolution: an npx-backed row prefers a pinned
 * install under `~/.hnx/acp-adapters/node_modules/.bin/<bin>` (absolute bin,
 * no per-spawn npx re-resolution); without it the npx fallback is unchanged;
 * `HN_ACP_COMMAND_*` overrides keep winning over both. #117 — the pinned bin
 * only counts while the store holds the PINNED version.
 */

const ENV: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '' };

/**
 * A tmp home with (optionally) a pinned bin provisioned for one adapter —
 * bin + the package's `package.json`, at the pinned version unless `version`
 * says otherwise (a store provisioned before a pin bump).
 */
function pinnedHome(bin?: string, version?: string): string {
  const home = mkdtempSync(join(tmpdir(), 'hnx-adapters-home-'));
  if (bin !== undefined) {
    const store = join(home, '.hnx', 'acp-adapters', 'node_modules');
    mkdirSync(join(store, '.bin'), { recursive: true });
    writeFileSync(join(store, '.bin', bin), '#!/bin/sh\n');
    const spec = PINNED_ADAPTER_SPECS.find((s) => s.bin === bin);
    if (spec !== undefined) {
      const parts = pinnedSpecParts(spec.spec);
      mkdirSync(join(store, parts.name), { recursive: true });
      writeFileSync(
        join(store, parts.name, 'package.json'),
        JSON.stringify({ name: parts.name, version: version ?? parts.version }),
      );
    }
  }
  return home;
}

describe('resolveAcpCommand pinned installs (issue #2)', () => {
  it('falls back to npx (version-pinned) when nothing is provisioned', () => {
    const cmd = resolveAcpCommand('claude-code', ENV, { homeDir: pinnedHome() });
    expect(cmd).toEqual({
      command: 'npx',
      args: ['-y', '@agentclientprotocol/claude-agent-acp@0.93.0'],
      env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' },
    });
  });

  it('uses the pinned absolute bin when provisioned', () => {
    const home = pinnedHome('claude-agent-acp');
    const cmd = resolveAcpCommand('claude-code', ENV, { homeDir: home });
    expect(cmd).toEqual({
      command: join(home, '.hnx', 'acp-adapters', 'node_modules', '.bin', 'claude-agent-acp'),
      args: [],
      env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' },
    });
  });

  it('pins codex independently of claude-code', () => {
    const home = pinnedHome('codex-acp');
    expect(resolveAcpCommand('codex', ENV, { homeDir: home })?.command).toBe(
      join(home, '.hnx', 'acp-adapters', 'node_modules', '.bin', 'codex-acp'),
    );
    // claude-code has no pinned bin in that home → npx fallback.
    expect(resolveAcpCommand('claude-code', ENV, { homeDir: home })?.command).toBe('npx');
  });

  it('#117 a store that drifted from the pin is never spawned — npx with the pinned spec', () => {
    const home = pinnedHome('claude-agent-acp', '0.79.0');
    expect(resolveAcpCommand('claude-code', ENV, { homeDir: home })).toEqual({
      command: 'npx',
      args: ['-y', '@agentclientprotocol/claude-agent-acp@0.93.0'],
      env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' },
    });
  });

  it('#117 a bin without its package manifest is not a provisioned install', () => {
    const home = mkdtempSync(join(tmpdir(), 'hnx-adapters-home-'));
    const bins = join(home, '.hnx', 'acp-adapters', 'node_modules', '.bin');
    mkdirSync(bins, { recursive: true });
    writeFileSync(join(bins, 'codex-acp'), '#!/bin/sh\n');
    expect(resolveAcpCommand('codex', ENV, { homeDir: home })?.command).toBe('npx');
  });

  it('HN_ACP_COMMAND_* overrides win over a pinned install', () => {
    const home = pinnedHome('claude-agent-acp');
    const cmd = resolveAcpCommand(
      'claude-code',
      {
        ...ENV,
        HN_ACP_COMMAND_CLAUDE_CODE: 'node /opt/my-wrapper.mjs --flag',
      },
      { homeDir: home },
    );
    expect(cmd).toEqual({
      command: 'node',
      args: ['/opt/my-wrapper.mjs', '--flag'],
      env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' },
    });
  });

  it('non-npx rows are untouched by the pinned dir', () => {
    const home = pinnedHome('claude-agent-acp');
    expect(resolveAcpCommand('opencode', ENV, { homeDir: home })).toEqual({
      command: 'opencode',
      args: ['acp'],
    });
    expect(resolveAcpCommand('deepseek', ENV, { homeDir: home })).toEqual({
      command: 'dsh',
      args: ['--profile', 'acp'],
    });
    expect(resolveAcpCommand('pi', ENV, { homeDir: home })).toBeNull();
  });
});
