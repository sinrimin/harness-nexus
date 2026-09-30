import { spawn } from '../proc.js';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Socket } from 'socket.io-client';
import {
  harnessJobPayloadSchema,
  harnessResultDataSchema,
  type JobView,
  type RuntimeInfo,
} from '@harness-nexus/shared';
import { probeRuntime, type ResolveOptions } from '../inventory/runtime.js';
import { scanTarget, scannerFor } from '../inventory/scan.js';
import { emptySnapshot } from './client.js';
import { logOp } from './logbook.js';

/**
 * Harness-runtime job executor (Phase 9 W2). wiki design-phase-9-harness-runtime.md §4.2.
 *
 * `install` / `upgrade` / `pin` map to the per-target command table — npm is
 * the universal channel (every daemon host runs Node ≥20); the ONE native
 * path is a claude-code upgrade on an already-native install (`claude
 * update`, which knows how to self-replace). Managed claude-code machines get
 * `DISABLE_AUTOUPDATER` merged into settings.json so our jobs are the only
 * version movers. A successful job re-probes the runtime and auto-reports the
 * target's inventory (one scan feeds the Agent card + detected-instance sync).
 *
 * Tests drive this with a fake `npm` shim on PATH (design §10) — no network.
 */

/** npm package per runtime target (single source for install/pin/upgrade). */
export const HARNESS_PACKAGES: Record<string, string> = {
  'claude-code': '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  deepseek: '@deepseek-ai/dsh',
  opencode: 'opencode-ai',
  // 9 W16 — the earendil org took over from @mariozechner (deprecated at
  // 0.73.1); pin this name, never the old scope.
  pi: '@earendil-works/pi-coding-agent',
};

/**
 * The dist-tag a version-less install/upgrade tracks. claude-code follows
 * `stable` (a ~week-old channel with regressions skipped — the managed-install
 * default per the Phase 9 research; `latest`/`next` exist but move faster than
 * a managed fleet should).
 */
const CHANNEL_TAG: Record<string, string> = {
  'claude-code': 'stable',
  codex: 'latest',
  deepseek: 'latest',
  opencode: 'latest',
  pi: 'latest',
};

/**
 * The resolved installer invocation for a harness payload. `apply-config` is
 * not an installer — the daemon routes it to the config executor before this
 * table; reaching it here (misrouted dispatch) refuses honestly.
 */
export function harnessCommand(
  payload: {
    action: 'install' | 'upgrade' | 'pin' | 'apply-config';
    target: string;
    version?: string | undefined;
  },
  currentInstallMethod: 'npm' | 'native' | 'brew' | 'unknown' | undefined,
): { command: string; args: string[] } | { error: string } {
  const pkg = HARNESS_PACKAGES[payload.target];
  if (!pkg) return { error: `no harness package for target '${payload.target}'` };
  if (payload.action === 'apply-config') {
    return { error: 'apply-config is executed by the config writer, not the installer table' };
  }
  // The one non-npm path: upgrading a NATIVE claude-code install — the native
  // launcher self-updates; npm -g over it would shadow, not upgrade.
  if (
    payload.target === 'claude-code' &&
    payload.action === 'upgrade' &&
    currentInstallMethod === 'native' &&
    payload.version === undefined
  ) {
    return { command: 'claude', args: ['update'] };
  }
  if (payload.target === 'claude-code' && currentInstallMethod === 'native' && payload.version) {
    return {
      error:
        'claude-code is natively installed and cannot be pinned remotely — run the native installer on the machine, or reinstall it via npm first',
    };
  }
  const tag = CHANNEL_TAG[payload.target] ?? 'latest';
  const spec = payload.version !== undefined ? `${pkg}@${payload.version}` : `${pkg}@${tag}`;
  return { command: 'npm', args: ['install', '-g', spec] };
}

/**
 * Merge `env.DISABLE_AUTOUPDATER = '1'` into ~/.claude/settings.json —
 * merge-preserving (unknown/user keys survive). Never throws into the job
 * path: an unreadable settings file is reported, not fatal.
 */
export function disableClaudeAutoUpdater(homeDir: string): string | null {
  const dir = join(homeDir, '.claude');
  const file = join(dir, 'settings.json');
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
      return `settings.json is not a JSON object — left untouched`;
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      return `settings.json unreadable (${e instanceof Error ? e.message : String(e)}) — left untouched`;
    }
  }
  const env = {
    ...((settings.env as Record<string, string> | undefined) ?? {}),
    DISABLE_AUTOUPDATER: '1',
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...settings, env }, null, 2)}\n`, 'utf8');
  chmodSync(file, 0o600);
  return null; // ok
}

/** dsh ≥0.1.2's plugin tree needs Node APIs absent from 20.x (zlib zstd, Promise.withResolvers). */
export function dshNodeWarning(): string | null {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major === undefined) return null;
  const ok = major > 22 || (major === 22 && (minor ?? 0) >= 15);
  return ok
    ? null
    : `deepseek's ACP profile needs Node >=22.15 (this daemon runs ${process.versions.node}) — chat sessions will fail until Node is upgraded`;
}

/** pi's engine floor (registry manifest 0.85.1) — the highest of our targets. */
export function piNodeWarning(): string | null {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major === undefined) return null;
  const ok = major > 22 || (major === 22 && (minor ?? 0) >= 19);
  return ok
    ? null
    : `pi needs Node >=22.19 (this daemon runs ${process.versions.node}) — its CLI refuses to start until Node is upgraded`;
}

export interface HarnessJobOptions {
  /** Per-command timeout (default 10 min — npm on a slow link is slow). */
  timeoutMs?: number;
  /** Spawn env override (tests inject a fake npm via PATH). Default: process.env. */
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

const TAIL_BYTES = 4096;

export async function runHarnessJob(
  socket: Socket,
  job: JobView,
  opts: HarnessJobOptions = {},
): Promise<void> {
  const parsed = harnessJobPayloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    socket.emit('job:result', { jobId: job.id, ok: false, error: 'harness payload invalid' });
    return;
  }
  const payload = parsed.data;
  // The daemon's real home (tests inject a fixture). Defaulting here (not
  // gating on `homeDir !== undefined`) is a W3 fix: W2 daemons skipped the
  // autoupdater write in production because the executor was called without
  // opts — `os.homedir()` honors the daemon's HOME, which is what the smoke
  // rig always relied on anyway.
  const homeDir = opts.homeDir ?? homedir();
  const probeOpts: ResolveOptions = {};
  if (opts.env?.PATH !== undefined) probeOpts.pathEnv = opts.env.PATH;
  if (homeDir !== undefined) probeOpts.homeDir = homeDir;
  const progress = (phase: string, message?: string): void => {
    socket.emit('job:progress', { jobId: job.id, phase, ...(message ? { message } : {}) });
  };
  const harnessStartedAt = Date.now();
  const result = (ok: boolean, extra: { error?: string; data?: unknown }): void => {
    socket.emit('job:result', { jobId: job.id, ok, ...extra });
    // #38 — installer runs leave a local trail (what was installed, how long,
    // why it failed) even though the result also lives server-side.
    logOp({
      op: `harness.${payload.action}`,
      target: payload.target,
      outcome: ok ? 'ok' : 'error',
      ms: Date.now() - harnessStartedAt,
      ...(extra.error !== undefined ? { detail: extra.error } : {}),
    });
  };

  progress(
    'resolve',
    `${payload.action} ${payload.target}${payload.version ? `@${payload.version}` : ''}`,
  );

  // Current install method decides the claude-code upgrade path.
  const current =
    payload.action === 'upgrade' ? await probeRuntime(payload.target, probeOpts) : null;
  const cmd = harnessCommand(payload, current?.installed ? current.installMethod : undefined);
  if ('error' in cmd) {
    result(false, { error: cmd.error });
    return;
  }

  progress('install', `${cmd.command} ${cmd.args.join(' ')}`.slice(0, 512));

  const spawnOutcome = await new Promise<{ ok: boolean; tail: string }>((resolve) => {
    let tail = '';
    let lastEmit = 0;
    const append = (chunk: Buffer): void => {
      tail = (tail + chunk.toString()).slice(-TAIL_BYTES);
      const now = Date.now();
      if (now - lastEmit >= 1200) {
        lastEmit = now;
        const line =
          tail
            .split('\n')
            .filter((l) => l.trim().length > 0)
            .pop() ?? '';
        if (line.length > 0) progress('install', line.slice(0, 512));
      }
    };
    let child: ReturnType<typeof spawn>;
    try {
      // Inherit the daemon's environment: proxied machines must pass
      // HTTP(S)_PROXY / npm_config_registry through to the installer.
      child = spawn(cmd.command, cmd.args, {
        env: opts.env ?? process.env,
        windowsHide: true, // #33 — no console window on Windows
      });
    } catch (e) {
      resolve({ ok: false, tail: e instanceof Error ? e.message : String(e) });
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref?.();
      resolve({ ok: false, tail: `${tail}\n timed out after ${opts.timeoutMs ?? 600000}ms` });
    }, opts.timeoutMs ?? 600000);
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, tail: `${tail}\n${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, tail });
    });
  });

  if (!spawnOutcome.ok) {
    const trimmed = spawnOutcome.tail.trim().split('\n').slice(-8).join('\n').slice(0, 900);
    result(false, { error: `${cmd.command} ${cmd.args.join(' ')} failed:\n${trimmed}` });
    return;
  }

  // Managed claude-code: our jobs become the only version mover.
  let warning: string | null = null;
  if (payload.target === 'claude-code') {
    warning = disableClaudeAutoUpdater(homeDir);
  }
  if (warning === null && payload.target === 'deepseek') {
    warning = dshNodeWarning();
  }
  if (warning === null && payload.target === 'pi') {
    warning = piNodeWarning();
  }

  // Re-probe so the job RESULT reports what actually landed, then auto-report
  // the target's inventory (runtime arm feeds the Agent card + detected sync).
  progress('verify', 'probing runtime');
  const runtime: RuntimeInfo = await probeRuntime(payload.target, probeOpts);
  const snapshot = scannerFor(payload.target)
    ? scanTarget(payload.target, homeDir)
    : emptySnapshot(payload.target);
  socket.emit('inventory:report', { runtimes: [runtime], snapshot });

  const data = harnessResultDataSchema.parse({
    target: payload.target,
    action: payload.action,
    ...(runtime.installed
      ? {
          version: runtime.version,
          binPath: runtime.binPath,
          installMethod: runtime.installMethod,
        }
      : {}),
    ...(warning !== null ? { warning } : {}),
  });
  result(true, { data });
}
