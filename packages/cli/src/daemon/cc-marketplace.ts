import type { Socket } from 'socket.io-client';
import { spawn } from '../proc.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  deployResultDataSchema,
  type JobView,
  type MarketplaceDeployArm,
} from '@harness-nexus/shared';
import { logOp } from './logbook.js';

/**
 * claude-code marketplace deploy executor (#6).
 * wiki design-cc-marketplace-deploy.md · issue #6.
 *
 * Claude Code owns install/update/uninstall — this executor drives CC's own
 * plugin CLI headless (`-y`: required when stdout is not a TTY) and never
 * writes into ~/.claude itself. Ground truth (CC 2.1.263, rig-verified):
 *
 *   - `plugin marketplace add <url>` is an idempotent no-op when the
 *     marketplace name exists, but it does NOT refresh a changed source URL —
 *     after a token rotation the stale URL wedges `marketplace update` until
 *     the marketplace is removed and re-added. We detect the mismatch by
 *     reading `known_marketplaces.json` (never by parsing CLI text).
 *   - `plugin install p@mp -y` is a no-op success when already installed; it
 *     does NOT pull a newer version — `plugin update p@mp -y` does. Install
 *     vs update is decided from `installed_plugins.json`.
 *   - CC compares VERSIONS: the emitter writes profile.version into
 *     plugin.json, so an update is only visible after the profile's version
 *     was bumped (PATCH /api/profiles now accepts `version`).
 *
 * The URL embeds the daemon's own machine PAT (the emitter accepts
 * machine-ctl tokens) — CC persists it inside ~/.claude, where the token
 * already lives in ~/.hnx/config.json; no secret rides the job payload.
 */

export interface MarketplaceJobOptions {
  /** The daemon's machine PAT — filled into the marketplace URL. */
  token: string;
  /** Per-command timeout (default 10 min — marketplace fetches can be slow). */
  timeoutMs?: number;
  /** Spawn env override (tests inject a fake claude via PATH). Default: process.env. */
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

const TAIL_BYTES = 4096;

interface KnownMarketplaces {
  [name: string]: { source?: { url?: string } } | undefined;
}

interface InstalledPlugins {
  plugins?: Record<string, Array<{ version?: string }> | undefined>;
}

export async function runMarketplaceDeploy(
  socket: Socket,
  job: JobView,
  profileId: string,
  arm: MarketplaceDeployArm,
  opts: MarketplaceJobOptions,
): Promise<void> {
  const homeDir = opts.homeDir ?? homedir();
  const pluginsDir = join(homeDir, '.claude', 'plugins');
  const progress = (phase: string, message?: string): void => {
    socket.emit('job:progress', { jobId: job.id, phase, ...(message ? { message } : {}) });
  };
  const result = (ok: boolean, extra: { error?: string; data?: unknown }): void => {
    socket.emit('job:result', { jobId: job.id, ok, ...extra });
    // #38 — CC plugin deploys ride CC's own CLI; the trail records what ran.
    logOp({
      op: 'cc-marketplace-deploy',
      target: 'claude-code',
      outcome: ok ? 'ok' : 'error',
      ...(extra.error !== undefined ? { detail: extra.error } : {}),
    });
  };

  // No trailing-slash games: PUBLIC_BASE_URL is normalized server-side, but a
  // hand-edited env should still produce a working URL.
  const url = `${arm.baseUrl.replace(/\/$/, '')}/api/marketplace/${opts.token}/marketplace.json`;

  progress('resolve', `marketplace ${arm.marketplaceName} · plugin ${arm.pluginName}`);

  // A marketplace under the same name but a different source URL (token
  // rotation, PUBLIC_BASE_URL change) must be removed first — `add` alone
  // keeps the stale URL and every later update fails on the dead token.
  const known = readJson<KnownMarketplaces>(join(pluginsDir, 'known_marketplaces.json'), {});
  const knownUrl = known[arm.marketplaceName]?.source?.url;
  if (knownUrl !== undefined && knownUrl !== url) {
    progress('marketplace', 'source URL changed — removing stale marketplace');
    const removed = await runClaude(['plugin', 'marketplace', 'remove', arm.marketplaceName], {
      ...opts,
      onProgress: (line) => progress('marketplace', line),
    });
    if (!removed.ok) {
      result(false, {
        error: `claude plugin marketplace remove failed:\n${trimmed(removed.tail)}`,
      });
      return;
    }
  }

  const added = await runClaude(['plugin', 'marketplace', 'add', url], {
    ...opts,
    onProgress: (line) => progress('marketplace', line),
  });
  if (!added.ok) {
    result(false, { error: `claude plugin marketplace add failed:\n${trimmed(added.tail)}` });
    return;
  }
  const refreshed = await runClaude(['plugin', 'marketplace', 'update', arm.marketplaceName], {
    ...opts,
    onProgress: (line) => progress('marketplace', line),
  });
  if (!refreshed.ok) {
    result(false, {
      error: `claude plugin marketplace update failed:\n${trimmed(refreshed.tail)}`,
    });
    return;
  }

  const pluginId = `${arm.pluginName}@${arm.marketplaceName}`;
  const installedBefore = readJson<InstalledPlugins>(join(pluginsDir, 'installed_plugins.json'), {})
    .plugins?.[pluginId]?.[0];
  const action = installedBefore ? 'update' : 'install';
  progress(action, `${action === 'update' ? 'updating' : 'installing'} ${pluginId}`);
  const appliedRun = await runClaude(['plugin', action, pluginId, '-y'], {
    ...opts,
    onProgress: (line) => progress(action, line),
  });
  if (!appliedRun.ok) {
    result(false, { error: `claude plugin ${action} failed:\n${trimmed(appliedRun.tail)}` });
    return;
  }

  // Report the version CC itself recorded — the marketplace catalog may differ
  // from the profile row if someone re-tagged without bumping.
  const installedAfter = readJson<InstalledPlugins>(join(pluginsDir, 'installed_plugins.json'), {})
    .plugins?.[pluginId]?.[0];

  const data = deployResultDataSchema.parse({
    name: arm.pluginName,
    directory: pluginsDir,
    target: 'claude-code',
    profileId,
    method: 'marketplace',
    ...(installedAfter?.version ? { installedVersion: installedAfter.version } : {}),
  });
  result(true, { data });
}

/** Run `claude <args>` headless with tail capture, throttled progress, timeout. */
async function runClaude(
  args: string[],
  opts: MarketplaceJobOptions & { onProgress: (line: string) => void },
): Promise<{ ok: boolean; tail: string }> {
  return new Promise((resolve) => {
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
        if (line.length > 0) opts.onProgress(line.slice(0, 512));
      }
    };
    let child: ReturnType<typeof spawn>;
    try {
      // Inherit the daemon's environment: NODE_EXTRA_CA_CERTS (self-signed
      // marketplace origins) and proxy vars must reach the claude CLI.
      child = spawn('claude', args, {
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
}

function trimmed(tail: string): string {
  return tail.trim().split('\n').slice(-8).join('\n').slice(0, 900);
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}
