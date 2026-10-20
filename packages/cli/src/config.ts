// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { InstallError } from './errors.js';

/**
 * Daemon configuration (~/.hnx/config.json, 0600). Written by `hnx enroll`
 * and by `hnx daemon` whenever it holds a complete identity (see #20: the
 * web-UI enrollment flow passes --server/--token/--machine-id as CLI args,
 * and the `hnx mcp serve` shim later reads the token from THIS file). The
 * machine token is a capability-scoped PAT (scopes ['machine-ctl']) —
 * REST-rejected, realtime-only — so this file is the single local secret the
 * client keeps (OS keychain later).
 */
export interface HnxDaemonConfig {
  server: string;
  /** Machine PAT (`hnpat_…`), issued once at enrollment. */
  token: string;
  machineId: string;
  machineName?: string;
}

export function daemonConfigPath(): string {
  return join(homedir(), '.hnx', 'config.json');
}

export function loadDaemonConfig(): HnxDaemonConfig | null {
  const path = daemonConfigPath();
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as HnxDaemonConfig;
  } catch {
    return null;
  }
}

/**
 * Merge explicit CLI args over the stored config into a complete identity.
 * Throws (VALIDATION_FAILED) when the result is still incomplete — the
 * machine name from the stored config is carried over when present.
 */
export function mergeDaemonConfig(
  args: { server?: string; token?: string; machineId?: string },
  existing: HnxDaemonConfig | null,
): HnxDaemonConfig {
  const server = args.server ?? existing?.server;
  const token = args.token ?? existing?.token;
  const machineId = args.machineId ?? existing?.machineId;
  if (!server || !token || !machineId) {
    throw new InstallError(
      'No daemon configuration found. Run "hnx enroll" first, or pass --server/--token/--machine-id.',
      'VALIDATION_FAILED',
    );
  }
  return {
    server,
    token,
    machineId,
    ...(existing?.machineName !== undefined ? { machineName: existing.machineName } : {}),
  };
}

export function saveDaemonConfig(config: HnxDaemonConfig): void {
  mkdirSync(join(homedir(), '.hnx'), { recursive: true, mode: 0o700 });
  const path = daemonConfigPath();
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // best-effort on filesystems that ignore modes
  }
}

/**
 * Absolute path of the running `hnx` executable — baked into the stdio shim
 * entries target adapters emit (GUI-launched Agent tools often lack PATH).
 * `HNX_BIN` overrides (tests / wrapper scripts); dev-mode `tsx` runs resolve
 * to the loader path, which is fine for local experimentation.
 */
export function hnxExecutablePath(): string {
  return process.env.HNX_BIN ?? (process.argv[1] ? resolve(process.argv[1]) : 'hnx');
}
