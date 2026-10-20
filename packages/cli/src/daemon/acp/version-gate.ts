// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import {
  compareVersions,
  type AgentTarget,
  type RuntimeInfo,
  type RuntimeTarget,
} from '@harness-nexus/shared';
import { probeRuntime } from '../../inventory/runtime.js';
import { HARNESS_PACKAGES } from '../runtime.js';
import { acpMinVersion } from './adapters.js';

/**
 * ACP client version gate (#46). dsh iterates fast and its integration
 * surfaces (session-log format, streaming buses) move with it; the daemon's
 * policy is ONE ground-truth version line per fast-moving target and NO
 * back-compat — an out-of-range client is REFUSED at connect time with an
 * actionable upgrade hint instead of mis-parsing its artifacts mid-chat.
 *
 * The gate runs before every spawn of a gated target (channel open AND the
 * prewarm pool): `<bin> --version` is probed via the W1 runtime probe
 * (bounded, PATH-aware). A missing binary or an unparseable version never
 * blocks — the spawn itself then fails with its own, more specific error;
 * the gate only rules on versions it can read and compare. Override-managed
 * command lines (`HN_ACP_COMMAND_<TARGET>`) skip the gate entirely
 * (`acpMinVersion` returns null).
 */

export type VersionGateResult =
  { ok: true } | { ok: false; version: string; min: string; message: string };

/** A bare semver-ish token: up to four numeric releases plus an optional prerelease. */
const VERSION_TOKEN = /^\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z.+-]+)?$/;

/** The client's display name for gate messages (bins, not target enum values). */
const CLIENT_NAMES: Record<string, string> = { deepseek: 'dsh' };

export interface VersionGateOptions {
  /** Overrides the runtime probe (tests inject a canned result). */
  probe?: () => Promise<RuntimeInfo | null>;
}

export async function checkAcpVersion(
  target: AgentTarget,
  env: NodeJS.ProcessEnv,
  opts: VersionGateOptions = {},
): Promise<VersionGateResult> {
  const min = acpMinVersion(target, env);
  if (min === null) return { ok: true };
  const probe =
    opts.probe ??
    ((): Promise<RuntimeInfo | null> =>
      // The caller's env drives the lookup too: in production it IS
      // process.env, and tests point it at a canned bin dir.
      probeRuntime(target as RuntimeTarget, {
        timeoutMs: 4000,
        ...(env.PATH !== undefined ? { pathEnv: env.PATH } : {}),
      }) as Promise<RuntimeInfo | null>);
  const info = await probe();
  const raw = info?.version;
  const version = typeof raw === 'string' ? (raw.trim().split(/\s+/)[0] ?? '') : '';
  // Absent (not installed / no answer in time) or unparseable (custom build):
  // pass through — the spawn surfaces the real failure.
  if (version === '' || !VERSION_TOKEN.test(version)) return { ok: true };
  if (compareVersions(version, min) >= 0) return { ok: true };
  const name = CLIENT_NAMES[target] ?? target;
  const pkg = HARNESS_PACKAGES[target];
  const upgrade = pkg !== undefined ? ` — upgrade with: npm install -g ${pkg}@latest` : '';
  return {
    ok: false,
    version,
    min,
    message: `${name} ${version} is not supported (minimum ${min})${upgrade}`,
  };
}
