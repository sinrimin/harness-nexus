// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disableClaudeAutoUpdater, harnessCommand, runHarnessJob } from '../src/daemon/runtime.js';

/**
 * Harness job executor (Phase 9 W2) against a FAKE `npm` shim on PATH
 * (design §10 — no network): the shim records argv, "installs" by writing a
 * bin script into a fixture dir, and prints npm-ish output. The claude-code
 * native-upgrade and DISABLE_AUTOUPDATER paths get their own fixtures.
 */

let home: string;
let shimDir: string;
let binDir: string;

function writeScript(file: string, body: string): string {
  writeFileSync(file, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(file, 0o755);
  return file;
}

/** Fake npm: record argv; when the spec is @pkg@ver, drop a bin that prints ver. */
function writeNpmShim(): void {
  writeScript(
    path.join(shimDir, 'npm'),
    [
      'echo "npm warn using mocked registry"',
      'spec=$3',
      'ver=${spec##*@}',
      'name=${spec%@*}',
      'case "$name" in',
      '  *claude-code) bin=claude ;;',
      '  *codex) bin=codex ;;',
      '  *dsh) bin=dsh ;;',
      '  *) bin=unknown ;;',
      'esac',
      `out='${binDir}/'$bin`,
      '{ echo \'#!/bin/sh\'; echo "echo $ver"; } > "$out"',
      'chmod +x "$out"',
      'echo "added 1 package in 0.1s"',
    ].join('\n'),
  );
}

/** Minimal socket double capturing emits. */
class FakeSocket extends EventEmitter {
  readonly events: { event: string; payload: unknown }[] = [];
  override emit(event: string, payload: unknown): boolean {
    this.events.push({ event, payload });
    return super.emit(event, payload);
  }
  last(event: string): { payload: unknown } | undefined {
    return [...this.events].reverse().find((e) => e.event === event);
  }
}

const job = (payload: unknown): unknown => ({
  id: 'job-1',
  machineId: 'm1',
  ownerId: 'u1',
  type: 'harness',
  status: 'dispatched',
  payload,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

beforeAll(() => {
  home = mkdtempSync(path.join(tmpdir(), 'hnx-harness-home-'));
  shimDir = mkdtempSync(path.join(tmpdir(), 'hnx-harness-shim-'));
  binDir = mkdtempSync(path.join(tmpdir(), 'hnx-harness-bin-'));
  writeNpmShim();
});

afterAll(() => {
  for (const d of [home, shimDir, binDir]) rmSync(d, { recursive: true, force: true });
});

/** Daemon-like env: fixture dirs FIRST (fake npm wins), system PATH kept so
 * the shim's own chmod/sh stay reachable. */
const env = (): NodeJS.ProcessEnv => ({
  ...process.env,
  PATH: `${shimDir}:${binDir}:${process.env.PATH ?? ''}`,
});

describe('harnessCommand', () => {
  it('maps the action × target table', () => {
    expect(harnessCommand({ action: 'install', target: 'codex' }, undefined)).toEqual({
      command: 'npm',
      args: ['install', '-g', '@openai/codex@latest'],
    });
    expect(
      harnessCommand({ action: 'pin', target: 'deepseek', version: '0.1.2-rc.1' }, 'npm'),
    ).toEqual({
      command: 'npm',
      args: ['install', '-g', '@deepseek-ai/dsh@0.1.2-rc.1'],
    });
    // 9 W12 — opencode rides the plain npm arm (package `opencode-ai`).
    expect(harnessCommand({ action: 'install', target: 'opencode' }, undefined)).toEqual({
      command: 'npm',
      args: ['install', '-g', 'opencode-ai@latest'],
    });
    expect(
      harnessCommand({ action: 'pin', target: 'opencode', version: '1.18.31' }, 'npm'),
    ).toEqual({
      command: 'npm',
      args: ['install', '-g', 'opencode-ai@1.18.31'],
    });
    // The one native path: upgrading an already-native claude-code install.
    expect(harnessCommand({ action: 'upgrade', target: 'claude-code' }, 'native')).toEqual({
      command: 'claude',
      args: ['update'],
    });
    // npm-managed claude upgrades stay on npm — on the STABLE dist-tag (the
    // managed-install default, Phase 9 W3); pinning a native install refuses.
    expect(harnessCommand({ action: 'upgrade', target: 'claude-code' }, 'npm')).toEqual({
      command: 'npm',
      args: ['install', '-g', '@anthropic-ai/claude-code@stable'],
    });
    expect(
      harnessCommand({ action: 'pin', target: 'claude-code', version: '2.1.89' }, 'native'),
    ).toEqual({ error: expect.stringContaining('natively installed') });
  });
});

describe('disableClaudeAutoUpdater', () => {
  it('merges env.DISABLE_AUTOUPDATER preserving user keys; creates the file 0600', () => {
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    const file = path.join(home, '.claude', 'settings.json');
    writeFileSync(
      file,
      JSON.stringify({ model: 'opus', env: { ANTHROPIC_BASE_URL: 'https://gw' } }),
      'utf8',
    );
    expect(disableClaudeAutoUpdater(home)).toBeNull();
    const merged = JSON.parse(readFileSync(file, 'utf8')) as {
      model: string;
      env: Record<string, string>;
    };
    expect(merged.model).toBe('opus');
    expect(merged.env.ANTHROPIC_BASE_URL).toBe('https://gw');
    expect(merged.env.DISABLE_AUTOUPDATER).toBe('1');
  });

  it('reports (does not clobber) an unparseable settings file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hnx-harness-bad-'));
    const file = path.join(dir, '.claude', 'settings.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'not json', 'utf8');
    expect(disableClaudeAutoUpdater(dir)).toContain('left untouched');
    expect(readFileSync(file, 'utf8')).toBe('not json');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('runHarnessJob', () => {
  it('installs via the npm shim, re-probes, auto-reports inventory, succeeds', async () => {
    const sock = new FakeSocket();
    await runHarnessJob(
      sock,
      job({ type: 'harness', action: 'pin', target: 'deepseek', version: '0.1.2-rc.1' }) as never,
      {
        env: env(),
        homeDir: home,
        timeoutMs: 15000,
      },
    );

    const result = sock.last('job:result')!.payload as {
      ok: boolean;
      data?: { version?: string };
      error?: string;
    };
    expect(result.ok).toBe(true);
    expect(result.data?.version).toBe('0.1.2-rc.1'); // re-probe read the shim-written bin

    const report = sock.last('inventory:report')!.payload as {
      runtimes: { target: string; installed: boolean }[];
      snapshot: { target: string };
    };
    expect(report.runtimes[0]).toMatchObject({ target: 'deepseek', installed: true });
    expect(report.snapshot.target).toBe('deepseek');

    // Progress reached the install phase with the resolved command line.
    const installProgress = sock.events.find(
      (e) => e.event === 'job:progress' && (e.payload as { phase: string }).phase === 'install',
    );
    expect((installProgress!.payload as { message: string }).message).toContain(
      '@deepseek-ai/dsh@0.1.2-rc.1',
    );
  }, 20000);

  it('a failing installer settles the job with the output tail', async () => {
    const failDir = mkdtempSync(path.join(tmpdir(), 'hnx-harness-fail-'));
    writeScript(path.join(failDir, 'npm'), 'echo "npm ERR! network unreachable" >&2\nexit 1');
    const sock = new FakeSocket();
    await runHarnessJob(
      sock,
      job({ type: 'harness', action: 'install', target: 'codex' }) as never,
      { env: { ...process.env, PATH: `${failDir}:${binDir}` }, homeDir: home, timeoutMs: 15000 },
    );
    const result = sock.last('job:result')!.payload as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toContain('npm ERR! network unreachable');
    rmSync(failDir, { recursive: true, force: true });
  }, 20000);

  it('an invalid payload settles as a failed job (never hangs the daemon)', async () => {
    const sock = new FakeSocket();
    await runHarnessJob(sock, job({ type: 'harness', action: 'pin', target: 'codex' }) as never, {
      env: env(),
      homeDir: home,
    });
    const result = sock.last('job:result')!.payload as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe('harness payload invalid');
  });
});
