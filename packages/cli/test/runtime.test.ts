// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  classifyInstallMethod,
  findRuntimeBin,
  probeRuntimes,
  RUNTIME_PROBES,
} from '../src/inventory/runtime.js';

/**
 * Runtime probe (Phase 9 W1) against fixture bins on a fake PATH — no network,
 * no real harness installs. The hanging-bin fixture proves the per-probe
 * timeout keeps a pathological `--version` from stalling a scan cycle.
 */

let binDir: string;
let home: string;

function writeBin(name: string, body: string): string {
  const file = path.join(binDir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(file, 0o755);
  return file;
}

beforeAll(() => {
  binDir = mkdtempSync(path.join(tmpdir(), 'hnx-runtime-bin-'));
  home = mkdtempSync(path.join(tmpdir(), 'hnx-runtime-home-'));
});

afterAll(() => {
  rmSync(binDir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('RUNTIME_PROBES', () => {
  it('covers exactly the managed runtime targets with their bins', () => {
    expect(RUNTIME_PROBES.map((r) => [r.target, r.bin])).toEqual([
      ['claude-code', 'claude'],
      ['codex', 'codex'],
      ['deepseek', 'dsh'],
      ['opencode', 'opencode'],
      ['pi', 'pi'],
    ]);
  });
});

describe('findRuntimeBin', () => {
  it('resolves from the PATH and falls back to known locations', async () => {
    writeBin('claude', 'echo 2.1.211');
    expect(await findRuntimeBin('claude', { pathEnv: binDir, homeDir: home })).toBe(
      path.join(binDir, 'claude'),
    );
    expect(await findRuntimeBin('codex', { pathEnv: binDir, homeDir: home })).toBeNull();

    // claude native fallback: ~/.local/bin/claude when the PATH has none
    const localBin = path.join(home, '.local', 'bin');
    mkdirSync(localBin, { recursive: true });
    const native = path.join(localBin, 'claude');
    writeFileSync(native, '#!/bin/sh\necho native\n', 'utf8');
    chmodSync(native, 0o755);
    expect(await findRuntimeBin('claude', { pathEnv: '', homeDir: home })).toBe(native);
    // but a PATH hit wins over the known location
    expect(await findRuntimeBin('claude', { pathEnv: binDir, homeDir: home })).toBe(
      path.join(binDir, 'claude'),
    );
  });
});

describe('classifyInstallMethod', () => {
  it('classifies by realpath prefixes, npm before the native .local guess', () => {
    expect(
      classifyInstallMethod('/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js', home),
    ).toBe('npm');
    expect(
      classifyInstallMethod('/home/me/.local/share/claude/versions/2.1.211/claude', home),
    ).toBe(
      'unknown', // different home — the .local check is home-relative
    );
    expect(
      classifyInstallMethod(path.join(home, '.local/share/claude/versions/1/claude'), home),
    ).toBe('native');
    // npm-prefix under ~/.local must NOT read as native (node_modules wins)
    expect(
      classifyInstallMethod(
        path.join(home, '.local/lib/node_modules/@openai/codex/bin/codex'),
        home,
      ),
    ).toBe('npm');
    expect(classifyInstallMethod('/opt/homebrew/bin/codex', home)).toBe('brew');
    expect(classifyInstallMethod('/opt/homebrew/Cellar/codex/0.2.0/codex', home)).toBe('brew');
    expect(classifyInstallMethod('/usr/local/bin/mystery', home)).toBe('unknown');
  });
});

describe('probeRuntimes', () => {
  it('reports installed bins with version + method and missing bins as not installed', async () => {
    writeBin('claude', 'echo "2.1.211 (Claude Code)"');
    writeBin('codex', 'echo codex-cli 0.12.1');
    writeBin('pi', 'echo 0.85.1'); // 9 W16
    // deepseek: deliberately absent

    const infos = await probeRuntimes({ pathEnv: binDir, homeDir: home, timeoutMs: 4000 });
    expect(infos).toHaveLength(5); // claude-code, codex, deepseek, opencode (W12), pi (W16)

    const claude = infos.find((r) => r.target === 'claude-code')!;
    expect(claude.installed).toBe(true);
    expect(claude.binPath).toBe(path.join(binDir, 'claude'));
    expect(claude.version).toBe('2.1.211 (Claude Code)');
    expect(claude.installMethod).toBe('unknown'); // fixture dir is not a known store

    const codex = infos.find((r) => r.target === 'codex')!;
    expect(codex.installed).toBe(true);
    expect(codex.version).toBe('codex-cli 0.12.1');

    const dsh = infos.find((r) => r.target === 'deepseek')!;
    expect(dsh.installed).toBe(false);
    expect(dsh.binPath).toBeUndefined();

    const oc = infos.find((r) => r.target === 'opencode')!;
    expect(oc.installed).toBe(false);
  });

  it('times out a hanging --version and still reports installed=true (bin exists)', async () => {
    const dsh = writeBin('dsh', 'sleep 30');
    expect(dsh).toBeTruthy();
    const infos = await probeRuntimes({ pathEnv: binDir, homeDir: home, timeoutMs: 300 });
    const deepseek = infos.find((r) => r.target === 'deepseek')!;
    expect(deepseek.installed).toBe(true);
    expect(deepseek.version).toBeUndefined();
  }, 5000);
});
