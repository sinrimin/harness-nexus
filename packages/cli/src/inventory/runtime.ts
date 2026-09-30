import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from '../proc.js';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import type { RuntimeInfo, RuntimeTarget } from '@harness-nexus/shared';

/**
 * Harness runtime probe (Phase 9 W1) — is the Agent's own software installed,
 * where, at which version, installed how? Kept in lockstep with
 * `RUNTIME_TARGETS` in shared (hermes is unlisted — runtime management
 * cancelled with the user 2026-09-17).
 *
 * Metadata only: the probe reads paths and `<bin> --version` output; it never
 * opens config files (those are W4's redacted viewer).
 */

interface RuntimeProbe {
  target: RuntimeTarget;
  bin: string;
  /** Locations a PATH walk misses (checked AFTER the PATH, so the user's PATH wins). */
  knownPaths: (homeDir: string) => string[];
}

export const RUNTIME_PROBES: readonly RuntimeProbe[] = [
  {
    target: 'claude-code',
    bin: 'claude',
    // Native install launcher (~/.local/bin) — the documented native location.
    knownPaths: (home) => [join(home, '.local', 'bin', 'claude')],
  },
  { target: 'codex', bin: 'codex', knownPaths: () => [] },
  { target: 'deepseek', bin: 'dsh', knownPaths: () => [] },
  // 9 W12 — npm package `opencode-ai` ships the `opencode` binary.
  { target: 'opencode', bin: 'opencode', knownPaths: () => [] },
  // 9 W16 — npm package `@earendil-works/pi-coding-agent` ships `pi`.
  { target: 'pi', bin: 'pi', knownPaths: () => [] },
];

const IS_WIN = process.platform === 'win32';

/** Windows npm shippers: PATHEXT's executable subset, bare name first. */
const WIN_EXTS = ['', '.cmd', '.bat', '.exe'] as const;

/**
 * #32 — PATH entries, both styles understood. cmd.exe separates with `;`;
 * Git Bash exports a POSIX-style `:`-separated PATH whose entries look like
 * `/c/Users/x/bin` — normalized here to `C:/Users/x/bin` so fs calls work.
 * A PATH containing `;` is read as Windows-style outright (drive letters
 * would otherwise be cut at `C:`).
 */
export function pathEntries(pathEnv: string, isWin = IS_WIN): string[] {
  if (!isWin) return pathEnv.split(':').filter((p) => p.length > 0);
  const sep = pathEnv.includes(';') ? ';' : ':';
  return pathEnv
    .split(sep)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => {
      const m = /^\/([a-zA-Z])\/(.*)$/.exec(p);
      return m !== null && m[1] !== undefined && m[2] !== undefined
        ? `${m[1].toUpperCase()}:/${m[2]}`
        : p;
    });
}

/** #32 — one directory's candidate paths for a bare bin (extensions on Windows). */
export function binCandidates(bin: string, dir: string, isWin = IS_WIN): string[] {
  if (!isWin) return [join(dir, bin)];
  return WIN_EXTS.map((ext) => join(dir, `${bin}${ext}`));
}

/** #32 — the Windows npm-global shim dir (`%APPDATA%\npm`). null elsewhere. */
export function npmGlobalDir(
  homeDir: string,
  isWin = IS_WIN,
  appData = process.env.APPDATA,
): string | null {
  if (!isWin) return null;
  return join(appData ?? join(homeDir, 'AppData', 'Roaming'), 'npm');
}

export interface ProbeOptions {
  /** Override `process.env.PATH` (tests inject fixture bins). */
  pathEnv?: string;
  homeDir?: string;
  /** Per-`<bin> --version` timeout. Default 5s (a hung binary must not stall a scan). */
  timeoutMs?: number;
}

export type ResolveOptions = Pick<ProbeOptions, 'pathEnv' | 'homeDir'>;

/** Resolve a bare bin name to an executable path — PATH walk, then known locations. */
export async function findRuntimeBin(
  bin: string,
  opts: Pick<ProbeOptions, 'pathEnv' | 'homeDir'> = {},
): Promise<string | null> {
  const home = opts.homeDir ?? homedir();
  const pathEnv = opts.pathEnv ?? process.env.PATH ?? '';
  const entries = pathEntries(pathEnv);
  const npmDir = npmGlobalDir(home);
  const candidates = [
    ...entries.flatMap((p) => binCandidates(bin, p)),
    // #32: the npm-global dir when the daemon's PATH misses it (Git Bash PATH
    // does not always carry it) — still AFTER the PATH, so PATH wins.
    ...(npmDir !== null && !entries.some((p) => sameDir(p, npmDir))
      ? binCandidates(bin, npmDir)
      : []),
    ...RUNTIME_PROBES.find((r) => r.bin === bin)!
      .knownPaths(home)
      .flatMap((p) => (IS_WIN ? [p, `${p}.cmd`, `${p}.exe`] : [p])),
  ];
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not there — keep walking
    }
  }
  return null;
}

/** Case-insensitive, slash-normalized compare (dirs arrive in both styles). */
function sameDir(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase();
  return IS_WIN ? norm(a) === norm(b) : a === b;
}

/**
 * Classify the install method from the REAL bin path (research §5.1): prefix
 * sniff on the symlink-resolved path (npm/brew installs are symlinks into
 * their stores). Best effort — anything unrecognized is `unknown`, never a
 * guess. `npm` is checked first: a user npm-prefix of `~/.local` would
 * otherwise masquerade as the native claude launcher location.
 */
export function classifyInstallMethod(
  resolvedPath: string,
  homeDir: string,
  isWin = IS_WIN,
): 'npm' | 'native' | 'brew' | 'unknown' {
  // #32: separator-agnostic — Windows npm installs report `\node_modules\`.
  if (resolvedPath.split(/[\\/]/).includes('node_modules')) return 'npm';
  // #32: the Windows npm-global dir holds `.cmd` shims whose realpath never
  // touches node_modules — anything under it is an npm install. Separators
  // are normalized: the shim path and join() output may mix styles.
  const npmDir = npmGlobalDir(homeDir, isWin);
  const norm = (s: string) => s.replace(/\\/g, '/').toLowerCase();
  if (npmDir !== null && norm(resolvedPath).startsWith(norm(npmDir))) {
    return 'npm';
  }
  if (resolvedPath.includes('/Cellar/') || resolvedPath.startsWith('/opt/homebrew/')) return 'brew';
  // The native claude launcher lives in ~/.local/bin and points into ~/.local/share/claude.
  if (resolvedPath.startsWith(join(homeDir, '.local'))) return 'native';
  return 'unknown';
}

/** Run `<bin> --version`, trimmed to the first meaningful line. null = no answer in time. */
async function probeVersion(binPath: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binPath, ['--version'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true, // #33 — no console window on Windows
      });
    } catch {
      resolve(null);
      return;
    }
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(null);
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const line = out.trim().split('\n')[0]?.trim() ?? '';
      resolve(line.length > 0 ? line.slice(0, 64) : null);
    });
  });
}

/** Probe one target. */
export async function probeRuntime(
  target: RuntimeTarget,
  opts: ProbeOptions = {},
): Promise<RuntimeInfo> {
  const probe = RUNTIME_PROBES.find((r) => r.target === target)!;
  const homeDir = opts.homeDir ?? homedir();
  const binPath = await findRuntimeBin(probe.bin, opts);
  if (binPath === null) return { target, installed: false };

  let resolved = binPath;
  try {
    resolved = await realpath(binPath);
  } catch {
    // keep the PATH-found path — classification falls back to `unknown`
  }
  const version = await probeVersion(binPath, opts.timeoutMs ?? 5000);
  return {
    target,
    installed: true,
    binPath,
    ...(version !== null ? { version } : {}),
    installMethod: classifyInstallMethod(resolved, homeDir),
  };
}

/** Probe every runtime target in parallel — one pass feeds the whole inventory report. */
export async function probeRuntimes(opts: ProbeOptions = {}): Promise<RuntimeInfo[]> {
  return Promise.all(RUNTIME_PROBES.map((r) => probeRuntime(r.target, opts)));
}
