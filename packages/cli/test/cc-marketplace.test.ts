// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMarketplaceDeploy } from '../src/daemon/cc-marketplace.js';
import type { JobView, MarketplaceDeployArm } from '@harness-nexus/shared';

/**
 * claude-code marketplace deploy executor (#6) against a FAKE `claude` CLI on
 * PATH (no network, no real Claude Code): the shim records argv and maintains
 * the same state files CC does (`known_marketplaces.json`,
 * `installed_plugins.json`) — add/remove/update marketplaces, install writes
 * 1.0.0, update writes 2.0.0, HNX_TEST_FAIL forces a subcommand to fail.
 */

const MP = 'harness-nexus-tester';
const PLUGIN = 'cc-kit';

let home: string;
let shimDir: string;
let pluginsDir: string;
let argvLog: string;
let env: NodeJS.ProcessEnv;

const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(process.env.HNX_TEST_HOME, '.claude', 'plugins');
fs.mkdirSync(dir, { recursive: true });
fs.appendFileSync(path.join(dir, 'argv.log'), process.argv.slice(2).join(' ') + '\\n');
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return d; } };
const write = (f, v) => fs.writeFileSync(path.join(dir, f), JSON.stringify(v, null, 2));
const [cmd, sub, ...rest] = process.argv.slice(2);
if (process.env.HNX_TEST_FAIL === sub) { console.error('simulated failure'); process.exit(1); }
if (cmd === 'plugin' && sub === 'marketplace') {
  const [action, arg] = rest;
  if (action === 'add') {
    const k = read('known_marketplaces.json', {});
    k['${MP}'] = { source: { source: 'url', url: arg } };
    write('known_marketplaces.json', k);
    console.log('marketplace added'); process.exit(0);
  }
  if (action === 'update') { console.log('marketplace updated'); process.exit(0); }
  if (action === 'remove') {
    const k = read('known_marketplaces.json', {});
    delete k[arg];
    write('known_marketplaces.json', k);
    console.log('marketplace removed'); process.exit(0);
  }
  console.error('unknown marketplace action'); process.exit(1);
}
if (cmd === 'plugin' && (sub === 'install' || sub === 'update')) {
  const [pluginId] = rest;
  const cur = read('installed_plugins.json', { version: 2, plugins: {} });
  const rows = (cur.plugins[pluginId] = cur.plugins[pluginId] || [{ scope: 'user' }]);
  rows[0].version = sub === 'update' ? '2.0.0' : '1.0.0';
  write('installed_plugins.json', cur);
  console.log(sub + 'ed ' + pluginId); process.exit(0);
}
console.error('unrecognized'); process.exit(1);
`;

/** Minimal socket double capturing emits. */
class FakeSocket extends EventEmitter {
  readonly events: { event: string; payload: unknown }[] = [];
  override emit(event: string, payload: unknown): boolean {
    this.events.push({ event, payload });
    return super.emit(event, payload);
  }
  results(): { ok: boolean; error?: string; data?: unknown }[] {
    return this.events.filter((e) => e.event === 'job:result').map((e) => e.payload);
  }
  progressPhases(): string[] {
    return this.events.filter((e) => e.event === 'job:progress').map((e) => e.payload.phase);
  }
}

const job = (): JobView =>
  ({
    id: 'job-1',
    machineId: 'm1',
    ownerId: 'u1',
    type: 'deploy',
    status: 'dispatched',
    payload: { profileId: 'p1' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }) as JobView;

const arm = (): MarketplaceDeployArm => ({
  baseUrl: 'https://hub.example',
  marketplaceName: MP,
  pluginName: PLUGIN,
});

const argvLines = (): string[] =>
  readFileSync(argvLog, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0);

const run = (sock: FakeSocket, opts: { fail?: string } = {}) =>
  runMarketplaceDeploy(sock, job(), 'p1', arm(), {
    token: 'hnpat_machine_test_token_0000000000',
    homeDir: home,
    env: { ...env, ...(opts.fail ? { HNX_TEST_FAIL: opts.fail } : {}) },
    timeoutMs: 15000,
  });

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'hnx-cc-market-home-'));
  shimDir = mkdtempSync(path.join(tmpdir(), 'hnx-cc-market-shim-'));
  pluginsDir = path.join(home, '.claude', 'plugins');
  argvLog = path.join(pluginsDir, 'argv.log');
  const shim = path.join(shimDir, 'claude');
  writeFileSync(shim, FAKE_CLAUDE, 'utf8');
  chmodSync(shim, 0o755);
  env = { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, HNX_TEST_HOME: home };
});

// The fake home is shared across tests for speed — wipe CC's state between
// cases so argv logs and install state never leak across assertions.
beforeEach(() => {
  rmSync(pluginsDir, { recursive: true, force: true });
  mkdirSync(pluginsDir, { recursive: true });
});

afterAll(() => {
  for (const d of [home, shimDir]) rmSync(d, { recursive: true, force: true });
});

describe('marketplace deploy executor (#6)', () => {
  it('fresh install: add → update → install, result carries method + version', async () => {
    const sock = new FakeSocket();
    await run(sock);
    const lines = argvLines();
    expect(lines).toEqual([
      `plugin marketplace add https://hub.example/api/marketplace/hnpat_machine_test_token_0000000000/marketplace.json`,
      `plugin marketplace update ${MP}`,
      `plugin install ${PLUGIN}@${MP} -y`,
    ]);
    const result = sock.results()[0];
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      name: PLUGIN,
      target: 'claude-code',
      profileId: 'p1',
      method: 'marketplace',
      installedVersion: '1.0.0',
    });
    expect(sock.progressPhases()).toContain('install');
  });

  it('already installed: routes to plugin update and reports the new version', async () => {
    writeFileSync(
      path.join(pluginsDir, 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: { [`${PLUGIN}@${MP}`]: [{ scope: 'user', version: '1.0.0' }] },
      }),
      'utf8',
    );
    const sock = new FakeSocket();
    await run(sock);
    const lines = argvLines();
    expect(lines).toContain(`plugin update ${PLUGIN}@${MP} -y`);
    expect(lines).not.toContain(`plugin install ${PLUGIN}@${MP} -y`);
    expect(sock.results()[0].data).toMatchObject({ installedVersion: '2.0.0' });
  });

  it('a stale marketplace URL (token rotation) is removed before re-add', async () => {
    writeFileSync(
      path.join(pluginsDir, 'known_marketplaces.json'),
      JSON.stringify({ [MP]: { source: { source: 'url', url: 'https://old.example/old.json' } } }),
      'utf8',
    );
    const sock = new FakeSocket();
    await run(sock);
    const lines = argvLines();
    expect(lines.indexOf(`plugin marketplace remove ${MP}`)).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf(`plugin marketplace remove ${MP}`)).toBeLessThan(
      lines.findIndex((l) => l.startsWith('plugin marketplace add')),
    );
    expect(sock.results()[0].ok).toBe(true);
  });

  it('a failing claude subcommand settles the job failed with the tail', async () => {
    const sock = new FakeSocket();
    await run(sock, { fail: 'install' });
    const result = sock.results()[0];
    expect(result.ok).toBe(false);
    expect(result.error).toContain('plugin install failed');
  });
});
