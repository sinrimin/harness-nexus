import { spawn } from '../../proc.js';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PINNED_ADAPTER_SPECS, type PinnedAdapterSpec } from './adapters.js';

/**
 * Issue #2 — pinned adapter provisioning. `npx -y <pkg>` re-resolves the
 * adapter on EVERY spawn (~1–2s; ~13s in the 2026-09-18 npx-cache incident),
 * and the claude wrapper additionally re-asserts the pinned model on every
 * resume via a `set_model` IPC the CLI does not service until its resume
 * bootstrap completes (upstream issues #886/#880) — ~2.2s of pure queueing
 * per session/load. This module installs the npx-backed adapters ONCE into
 * `~/.hnx/acp-adapters` (staging dir + atomic rename, so a daemon death
 * mid-install never leaves a half-written install) and applies an
 * idempotent patch set to the installed dist — the same pattern the
 * reference claude-acp-bridge uses (`patch-acp-agent.js` at image build).
 *
 * `resolveAcpCommand` already prefers the pinned bin; npx remains the
 * fallback while (or if) provisioning has not landed. Everything here is
 * fire-and-forget from daemon boot: no failure blocks or crashes the
 * daemon — the worst case is simply the previous npx behavior.
 */

/**
 * A string-replacement patch against an installed adapter's dist. Anchored
 * on EXACT text: when the anchor is gone (upstream reshaped the file) the
 * patch is skipped with a warning — correct-but-slow, never broken.
 */
export interface AdapterPatch {
  /** Patch id (logs/tests). */
  id: string;
  /** Package NAME (no version) this patch targets. */
  pkg: string;
  /** File path relative to the package root. */
  file: string;
  /** The exact text to replace (first occurrence). */
  anchor: string;
  /** The replacement (must contain `marker`). */
  replacement: string;
  /** Substring present in the patched output — idempotency detector. */
  marker: string;
  /** Why this patch exists (logged on application). */
  reason: string;
}

const SET_MODEL_SKIP_PATCH: AdapterPatch = {
  id: 'skip-redundant-setmodel-on-resume',
  pkg: 'claude-agent-acp',
  file: 'node_modules/@agentclientprotocol/claude-agent-acp/dist/session-model.js',
  anchor: '    const skipSetModel = resolvedFromInput === undefined ||',
  replacement:
    '    const resumedAlreadyRunning = isResumedSession && resumedModelHint !== undefined &&\n' +
    '        currentModel.value === matchResumedModel(models, resumedModelHint).value;\n' +
    '    const skipSetModel = resumedAlreadyRunning || resolvedFromInput === undefined ||',
  marker: 'resumedAlreadyRunning',
  reason:
    'skip the setModel re-assert on resume when the session already runs the resolved model ' +
    '(the control request queues behind the CLI resume bootstrap; rig: session/load 3.37s → 0.98s)',
};

export const ADAPTER_PATCHES: readonly AdapterPatch[] = [SET_MODEL_SKIP_PATCH];

export interface PatchOutcome {
  applied: string[];
  already: string[];
  failed: { id: string; reason: string }[];
}

/**
 * Apply the patch set to an ALREADY installed adapter store. Idempotent: a
 * file carrying the marker (patched before, or by hand) counts as `already`.
 */
export function applyAdapterPatches(storeDir: string): PatchOutcome {
  const outcome: PatchOutcome = { applied: [], already: [], failed: [] };
  for (const patch of ADAPTER_PATCHES) {
    const file = join(storeDir, patch.file);
    let src: string;
    try {
      src = readFileSync(file, 'utf8');
    } catch (e) {
      outcome.failed.push({ id: patch.id, reason: `unreadable ${patch.file}: ${errText(e)}` });
      continue;
    }
    if (src.includes(patch.marker)) {
      outcome.already.push(patch.id);
      continue;
    }
    if (!src.includes(patch.anchor)) {
      outcome.failed.push({
        id: patch.id,
        reason: `anchor not found in ${patch.file} (upstream shape changed? leaving unpatched)`,
      });
      continue;
    }
    writeFileSync(file, src.replace(patch.anchor, patch.replacement));
    outcome.applied.push(patch.id);
  }
  return outcome;
}

export interface ProvisionOptions {
  /** Env source (kill switch `HN_ACP_NO_AUTO_PROVISION` is read by the caller). */
  env?: NodeJS.ProcessEnv;
  /** Overridable for tests: run `npm install` (defaults to the real spawn). */
  runNpm?: (args: string[]) => Promise<void>;
  /** npm install timeout (default 10 min, mirroring harness jobs). */
  timeoutMs?: number;
}

export interface ProvisionResult extends PatchOutcome {
  /** True when a fresh install landed (false = store already complete). */
  installed: boolean;
  /** Non-empty when provisioning could not complete (npx stays the path). */
  error?: string;
}

function binsAllPresent(storeDir: string): boolean {
  return PINNED_ADAPTER_SPECS.every((s) =>
    existsSync(join(storeDir, 'node_modules', '.bin', s.bin)),
  );
}

/**
 * Ensure the pinned adapter store exists and carries the patch set. Safe to
 * call on every boot: a complete store only re-checks patches; an
 * incomplete/absent one installs into a staging dir and atomically renames.
 */
export async function provisionAdapters(
  home: string,
  opts: ProvisionOptions = {},
): Promise<ProvisionResult> {
  const storeDir = join(home, '.hnx', 'acp-adapters');
  if (binsAllPresent(storeDir)) {
    return { installed: false, ...applyAdapterPatches(storeDir) };
  }

  const specs: readonly string[] = PINNED_ADAPTER_SPECS.map((s: PinnedAdapterSpec) => s.spec);
  const staging = join(home, '.hnx', `acp-adapters.staging-${String(process.pid)}`);
  rmSync(staging, { recursive: true, force: true });
  const runNpm =
    opts.runNpm ??
    ((args: string[]): Promise<void> => {
      const env = { ...process.env, ...(opts.env ?? {}) };
      return new Promise((resolve, reject) => {
        const child = spawn('npm', args, {
          env,
          stdio: ['ignore', 'ignore', 'pipe'],
          windowsHide: true, // #33 — no console window on Windows
        });
        const stderrTail: string[] = [];
        child.stderr?.on('data', (c: Buffer) => {
          for (const l of c.toString('utf8').split('\n')) {
            if (l.trim() !== '') stderrTail.push(l.trimEnd());
            if (stderrTail.length > 10) stderrTail.shift();
          }
        });
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`npm install timed out after ${String(opts.timeoutMs ?? 600_000)}ms`));
        }, opts.timeoutMs ?? 600_000);
        timer.unref();
        child.on('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.on('exit', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`npm install exited ${String(code)}: ${stderrTail.join(' | ')}`));
        });
      });
    });

  try {
    await runNpm(['install', '--prefix', staging, '--no-audit', '--no-fund', ...specs]);
    // Patch INSIDE staging so the store is born patched — a patch failure on
    // a fresh install is reported but never blocks the install itself.
    const patches = applyAdapterPatches(staging);
    rmSync(storeDir, { recursive: true, force: true });
    renameSync(staging, storeDir);
    return { installed: true, ...patches };
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    return {
      installed: false,
      applied: [],
      already: [],
      failed: [],
      error: errText(e),
    };
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
