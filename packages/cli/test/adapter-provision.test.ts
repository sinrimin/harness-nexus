// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ADAPTER_PATCHES,
  applyAdapterPatches,
  provisionAdapters,
  type AdapterPatch,
} from '../src/daemon/acp/adapter-provision.js';
import { PINNED_ADAPTER_SPECS, pinnedSpecParts } from '../src/daemon/acp/adapters.js';

/**
 * Issue #2 — pinned adapter provisioning: install once into
 * `~/.hnx/acp-adapters` (staging + atomic rename), then keep an idempotent
 * patch set applied to the installed dist. The production list is EMPTY since
 * #71 (the setModel-skip patch was retired when upstream 0.93.0 landed its
 * own), so these tests drive the mechanism through a SYNTHETIC patch.
 */

const PATCH: AdapterPatch = {
  id: 'test-patch',
  pkg: 'claude-agent-acp',
  file: 'node_modules/@agentclientprotocol/claude-agent-acp/dist/session-model.js',
  anchor: '    const skipSetModel = resolvedFromInput === undefined ||',
  replacement:
    '    const resumedAlreadyRunning = isResumedSession && resumedModelHint !== undefined;\n' +
    '    const skipSetModel = resumedAlreadyRunning || resolvedFromInput === undefined ||',
  marker: 'resumedAlreadyRunning',
  reason: 'synthetic patch exercising the anchor/marker mechanism',
};

const CLAUDE_MODEL_FILE = PATCH.file;

const CLAUDE_PKG = '@agentclientprotocol/claude-agent-acp';

/**
 * Seed a (complete or partial) adapter store with the patch target file. A
 * provisioned package carries its `package.json` at the PINNED version unless
 * `versions` overrides it (#117 drift) — a real npm install always writes one.
 */
function seedStore(
  dir: string,
  opts: { bins?: boolean; patched?: boolean; versions?: Record<string, string> } = {},
): void {
  if (opts.bins !== false) {
    for (const s of PINNED_ADAPTER_SPECS) {
      mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
      writeFileSync(join(dir, 'node_modules', '.bin', s.bin), '#!/bin/sh\n');
      const { name, version } = pinnedSpecParts(s.spec);
      mkdirSync(join(dir, 'node_modules', name), { recursive: true });
      writeFileSync(
        join(dir, 'node_modules', name, 'package.json'),
        JSON.stringify({ name, version: opts.versions?.[name] ?? version }),
      );
    }
  }
  mkdirSync(join(dir, CLAUDE_MODEL_FILE, '..'), { recursive: true });
  writeFileSync(
    join(dir, CLAUDE_MODEL_FILE),
    opts.patched === true
      ? `code();\n${PATCH.replacement}\nmore();\n`
      : `code();\n${PATCH.anchor}\nmore();\n`,
  );
}

/**
 * #92 — the REAL claude-agent-acp 0.93.0 `dist/permissions/effects.js`
 * excerpts (parse head + the plain-reject arm), vendored verbatim from the
 * pinned install so anchor drift is a test failure, not a silent skip. The
 * `**FILE**` separator keeps the path and the content in one constant.
 */
const CLAUDE_EFFECTS_0930 = `node_modules/@agentclientprotocol/claude-agent-acp/dist/permissions/effects.js
**FILE**
export function parseClaudePermissionSelection(response, toolName) {
    if (response.outcome?.outcome !== "selected")
        throw new Error("Tool use aborted");
    const optionId = response.outcome.optionId;
    const contextResetMode = toolName === "ExitPlanMode" ? exitPlanClearContextMode(optionId) : undefined;
    return { optionId, ...(contextResetMode ? { contextResetMode } : {}) };
}
function deny(context, message = "User refused permission to run tool", interrupt = false) {
    return {
        behavior: "deny",
        message,
        ...(interrupt ? { interrupt: true } : {}),
        toolUseID: context.toolUseID,
        decisionClassification: "user_reject",
    };
}
function applyCommonSelection(selection, context) {
    switch (selection.optionId) {
        case PERMISSION_OPTION_ID.allowOnce:
            return allow(context);
        case PERMISSION_OPTION_ID.allowWithUpdates:
            if (!context.durableChangeSet)
                throw new Error("Invalid durable permission selection");
            return allow(context, context.durableChangeSet.updates, true);
        case PERMISSION_OPTION_ID.reject:
            return deny(context);
        default:
            throw new Error(\`Unknown permission option: \${selection.optionId}\`);
    }
}
`;

/**
 * Same doctrine, `dist/acp-agent.js`: the force-cancel floor arming block the
 * stop-during-permission patch anchors on (vendored verbatim from 0.93.0).
 */
const CLAUDE_ACP_AGENT_0930 = `node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js
**FILE**
        if (session.activeTurn &&
            session.cancelController &&
            !session.cancelController.signal.aborted &&
            !session.forceCancelTimer) {
            const cancelController = session.cancelController;
            session.forceCancelTimer = setTimeout(() => {
                this.logger.error(\`Session \${params.sessionId}: cancel floor elapsed without the SDK yielding; forcing "cancelled". The underlying query may still be wedged — a new session may be required.\`);
                cancelController.abort();
            }, this.forceCancelGraceMs);
        }
`;

describe('applyAdapterPatches (issue #2)', () => {
  it('applies the anchor replace and becomes idempotent via the marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hnx-provision-'));
    seedStore(dir);
    const r1 = applyAdapterPatches(dir, [PATCH]);
    expect(r1.applied).toEqual([PATCH.id]);
    const patched = readFileSync(join(dir, CLAUDE_MODEL_FILE), 'utf8');
    expect(patched).toContain(PATCH.marker);
    const r2 = applyAdapterPatches(dir, [PATCH]);
    expect(r2.already).toEqual([PATCH.id]);
    expect(r2.applied).toEqual([]);
  });

  it('counts a hand-patched file (marker, no anchor) as already patched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hnx-provision-'));
    seedStore(dir, { patched: true });
    const r = applyAdapterPatches(dir, [PATCH]);
    expect(r.already).toEqual([PATCH.id]);
    expect(r.failed).toEqual([]);
  });

  it('reports — never throws — when the upstream anchor is gone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hnx-provision-'));
    mkdirSync(join(dir, CLAUDE_MODEL_FILE, '..'), { recursive: true });
    writeFileSync(join(dir, CLAUDE_MODEL_FILE), 'totally reshaped upstream code\n');
    const r = applyAdapterPatches(dir, [PATCH]);
    expect(r.failed).toHaveLength(1);
    expect(r.failed[0]!.reason).toContain('anchor not found');
  });

  // #92 — the denyMessage patches ARE the production set now (the #71
  // setModel patch retired at 0.93.0). What matters is that their anchors
  // match the REAL pinned dist: apply them against the installed 0.93.0
  // excerpts (vendored here so the test never depends on ~/.hnx state).
  it('#92 denyMessage + cancel-floor patches land on the real 0.93.0 dist and are idempotent', () => {
    const home = mkdtempSync(join(tmpdir(), 'hnx-provision-home-'));
    const store = join(home, '.hnx', 'acp-adapters');
    for (const vendored of [CLAUDE_EFFECTS_0930, CLAUDE_ACP_AGENT_0930]) {
      const [path, content] = vendored.split('**FILE**');
      const file = join(store, path!.trim());
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content!.trimStart());
    }
    const first = applyAdapterPatches(store);
    expect(first.applied).toHaveLength(3);
    expect(first.failed).toEqual([]);
    const effects = readFileSync(
      join(store, CLAUDE_EFFECTS_0930.split('**FILE**')[0]!.trim()),
      'utf8',
    );
    expect(effects).toContain('selection.denyMessage ?? "User refused permission to run tool"');
    const agent = readFileSync(
      join(store, CLAUDE_ACP_AGENT_0930.split('**FILE**')[0]!.trim()),
      'utf8',
    );
    expect(agent).toContain('(session.openUserInputs?.size ?? 0) > 0 ? 1500 : 5000');
    const again = applyAdapterPatches(store);
    expect(again.already).toHaveLength(3);
    expect(again.applied).toEqual([]);
  });

  it('the production list is exactly the three claude patches', () => {
    expect(ADAPTER_PATCHES.map((p) => p.id)).toEqual([
      'claude-agent-acp-deny-message-parse',
      'claude-agent-acp-deny-message-use',
      'claude-agent-acp-cancel-floor',
    ]);
  });
});

describe('provisionAdapters (issue #2)', () => {
  it('a complete store only re-checks patches — npm never runs', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hnx-provision-home-'));
    seedStore(join(home, '.hnx', 'acp-adapters'));
    const r = await provisionAdapters(home, {
      patches: [PATCH],
      runNpm: () => {
        throw new Error('npm must not run when the store is complete');
      },
    });
    expect(r.installed).toBe(false);
    expect(r.drift).toEqual([]);
    expect(r.applied).toEqual([PATCH.id]);
  });

  it('a fresh install lands patched and the staging dir is renamed away', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hnx-provision-home-'));
    const r = await provisionAdapters(home, {
      patches: [PATCH],
      runNpm: async (args) => {
        const prefix = args[args.indexOf('--prefix') + 1]!;
        seedStore(prefix);
      },
    });
    expect(r.installed).toBe(true);
    expect(r.applied).toEqual([PATCH.id]);
    const store = join(home, '.hnx', 'acp-adapters');
    for (const s of PINNED_ADAPTER_SPECS) {
      expect(existsSync(join(store, 'node_modules', '.bin', s.bin))).toBe(true);
    }
    expect(readFileSync(join(store, CLAUDE_MODEL_FILE), 'utf8')).toContain(PATCH.marker);
    // No staging leftovers.
    const hnx = join(home, '.hnx');
    expect(readdir(hnx)).toEqual(['acp-adapters']);
  });

  it('an npm failure cleans the staging dir and reports the error', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hnx-provision-home-'));
    const r = await provisionAdapters(home, {
      runNpm: async () => {
        throw new Error('npm install exited 1: network unreachable');
      },
    });
    expect(r.installed).toBe(false);
    expect(r.drift).toEqual([]);
    expect(r.error).toContain('npm install exited 1');
    expect(existsSync(join(home, '.hnx', 'acp-adapters'))).toBe(false);
    expect(existsSync(join(home, '.hnx', 'acp-adapters.staging-' + String(process.pid)))).toBe(
      false,
    );
  });

  // #117 — a pin bump keeps the bin NAME, so bins alone called a store
  // provisioned before the bump "complete" forever (#71: 0.79.0 stayed).
  it('#117 a store that drifted from its pins re-provisions and reports the drift', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hnx-provision-home-'));
    const store = join(home, '.hnx', 'acp-adapters');
    seedStore(store, { versions: { [CLAUDE_PKG]: '0.79.0' } });
    let npmRuns = 0;
    const r = await provisionAdapters(home, {
      patches: [PATCH],
      runNpm: async (args) => {
        npmRuns += 1;
        seedStore(args[args.indexOf('--prefix') + 1]!);
      },
    });
    expect(npmRuns).toBe(1);
    expect(r.installed).toBe(true);
    expect(r.drift).toEqual([`${CLAUDE_PKG} 0.79.0 → ${pinnedVersionOf(CLAUDE_PKG)}`]);
    expect(r.applied).toEqual([PATCH.id]); // the replacement is born patched
    const pkg = JSON.parse(
      readFileSync(join(store, 'node_modules', CLAUDE_PKG, 'package.json'), 'utf8'),
    ) as { version: string };
    expect(pkg.version).toBe(pinnedVersionOf(CLAUDE_PKG));
    expect(readdir(join(home, '.hnx'))).toEqual(['acp-adapters']);
  });

  it('#117 a failed re-provision keeps the drifted store in place (npx stays the path)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hnx-provision-home-'));
    const store = join(home, '.hnx', 'acp-adapters');
    seedStore(store, { versions: { [CLAUDE_PKG]: '0.79.0' } });
    const r = await provisionAdapters(home, {
      runNpm: async () => {
        throw new Error('npm install exited 1: network unreachable');
      },
    });
    expect(r.installed).toBe(false);
    expect(r.error).toContain('npm install exited 1');
    expect(r.drift).toHaveLength(1);
    // The swap only happens after a successful install: the old store stays.
    const pkg = JSON.parse(
      readFileSync(join(store, 'node_modules', CLAUDE_PKG, 'package.json'), 'utf8'),
    ) as { version: string };
    expect(pkg.version).toBe('0.79.0');
  });

  it('#117 bins without package manifests do not count as a current store', async () => {
    const home = mkdtempSync(join(tmpdir(), 'hnx-provision-home-'));
    const store = join(home, '.hnx', 'acp-adapters');
    for (const s of PINNED_ADAPTER_SPECS) {
      mkdirSync(join(store, 'node_modules', '.bin'), { recursive: true });
      writeFileSync(join(store, 'node_modules', '.bin', s.bin), '#!/bin/sh\n');
    }
    let npmRuns = 0;
    const r = await provisionAdapters(home, {
      runNpm: async (args) => {
        npmRuns += 1;
        seedStore(args[args.indexOf('--prefix') + 1]!);
      },
    });
    expect(npmRuns).toBe(1);
    expect(r.installed).toBe(true);
    expect(r.drift).toEqual([]); // absent manifests are incompleteness, not drift
  });

  it('exports the version-pinned specs used for both install and npx fallback', () => {
    expect(PINNED_ADAPTER_SPECS).toContainEqual({
      spec: '@agentclientprotocol/claude-agent-acp@0.93.0',
      bin: 'claude-agent-acp',
    });
    expect(PINNED_ADAPTER_SPECS).toContainEqual({
      spec: '@zed-industries/codex-acp@0.16.0',
      bin: 'codex-acp',
    });
  });
});

function readdir(dir: string): string[] {
  return readdirSync(dir).filter((d) => !d.startsWith('acp-adapters.staging'));
}

function pinnedVersionOf(name: string): string {
  const spec = PINNED_ADAPTER_SPECS.find((s) => pinnedSpecParts(s.spec).name === name)!.spec;
  return pinnedSpecParts(spec).version;
}
