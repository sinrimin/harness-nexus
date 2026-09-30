#!/usr/bin/env node
/**
 * `harness-nexus` / `hnx` — install tool (Phase 3.3).
 *
 * Fetches a profile from a Harness Nexus server via the SDK and installs it
 * into a target Agent tool's native layout through a target adapter. Plan and
 * apply are separate: a plain run is a dry-run that prints the plan; `--apply`
 * writes files + an install-state ledger.
 *
 * Usage:
 *   hnx install --profile <id> --server <url> --token <pat> [--target <t>] [--apply] [--out <dir>]
 *   hnx install --profile <id> ...            # dry-run: prints the plan, writes nothing
 *
 * A profile is a reference bundle (its entries point at server-side resources),
 * so the server is required — there is no local-manifest path.
 *
 * Design: `wiki design-phase-3-install.md`. Adapter pattern:
 * `wiki research-phase-3-ecc-install-patterns.md`.
 */
import { hostname } from 'node:os';
import { InstallError } from './errors.js';
import { applyInstall } from './install/installer.js';
import { planInstall } from './install/planner.js';
import { resolveProfile } from './install/resolver.js';
import { supportedTargets } from './install/registry.js';
import { getHermesPlanWarnings } from './install/adapters/hermes.js';
import { getCodexPlanWarnings } from './install/adapters/codex.js';
import { getDeepseekPlanWarnings } from './install/adapters/deepseek.js';
import { getPiPlanWarnings } from './install/adapters/pi.js';
import { applyUninstall, planUninstall } from './install/uninstaller.js';
import {
  daemonConfigPath,
  loadDaemonConfig,
  mergeDaemonConfig,
  saveDaemonConfig,
} from './config.js';
import { runDaemon } from './daemon/client.js';
import { runMcpServe } from './mcp/serve.js';
import { runTuiCommand } from './tui/command.js';
import { cliVersion } from './version.js';
import { runLogsCommand, type LogsArgs } from './logs.js';
import { logOp } from './daemon/logbook.js';
import { HarnessNexusClient } from '@harness-nexus/sdk';
import type { InstallPlan } from './install/types.js';
import type { AgentTarget } from '@harness-nexus/core';

const HELP = `harness-nexus (hnx) — install profiles into Agent tools

Usage:
  hnx install --profile <id> --server <url> --token <pat> [options]
  hnx uninstall --target <t> [--out <dir>] [--apply]
  hnx enroll --server <url> --token <pat> [--name <name>]
  hnx daemon [--server <url>] [--token <machine-pat>] [--machine-id <id>]
  hnx tui [--dump]
  hnx mcp serve --profile <id> [--server <url>] [--token <pat>]
  hnx logs [--tail <n>] [--bundle <file|->]
  hnx --version

Install options:
  --profile <id>     Profile to install (required)
  --server <url>     Harness Nexus server base URL (required)
  --token <pat>      PAT or JWT for authentication (required)
  --target <t>       Override target (default: the profile's own target)
  --apply            Write files (default: dry-run, prints the plan only)
  --out <dir>        Override the install root (default: the target's native home)

Uninstall options:
  --target <t>       Target whose ledger to reverse (required)
  --out <dir>        Same install-root override used at install time
  --apply            Actually remove/restore (default: dry-run, prints steps)
                      Files you edited after install are kept as *.hnx.bak

Enroll options (Phase 8 — machine registration):
  --server <url>     Harness Nexus server base URL (required)
  --token <pat>      A user PAT for the enrollment call (required)
  --name <name>      Machine display name (default: this host's hostname)
                      Creates the machine + its dedicated machine token and
                      saves them to ~/.hnx/config.json (0600).

Daemon options (Phase 8 — bring the machine online):
  (all optional; defaults come from ~/.hnx/config.json written by 'hnx enroll')
  --server <url>     Override the server base URL
  --token <pat>      Override the machine token
  --machine-id <id>  Override the machine id
  The daemon keeps a local logbook under ~/.hnx/logs/ (#38):
  ops.log = operations it performed, comm.log = server traffic metadata
  (chat stream bursts collapse to one line per burst). Env:
  HNX_LOG_COMM=payload  also log full payloads (DEBUG ONLY — includes chat
                        content; never share the file unreviewed)
  HNX_LOG_DIR=<dir>     override the logbook directory

Logs options (#38 — inspect the daemon's local logbook):
  --tail <n>         Lines to print per file (default 20)
  --bundle <file>    Write a shareable single-file support bundle
                     (build header + last 200 lines of each log);
                     '-' writes it to stdout

MCP serve options (Phase 8 C2 — the stdio shim; spawned by Agent tools):
  --profile <id>     Profile to serve (required)
  --server <url>     Server base URL (default: ~/.hnx/config.json)
  --token <pat>      Machine PAT or user PAT (default: ~/.hnx/config.json)

TUI options (#39 — the daemon's live console; replaces 'hnx daemon' for
an interactive session, same identity/lock rules):
  --dump             Print a one-shot text snapshot and exit (also the
                     automatic fallback when stdout is not a terminal)
  Keys: 1 agents · 2 ops · 3 comm · t tokens · m metrics bar · a all ·
        space refresh · q quit (nmon-style pane toggles)

To upgrade an install, run the same 'hnx install --apply' again — the plan
rewrites its own entries (idempotent) and the ledger is refreshed.

Supported targets: ${supportedTargets().join(', ')}
(zcode is in the enum but has no install adapter.)

A plain run is a DRY-RUN — it prints the planned operations without writing.
Add --apply to materialize them.`;

interface InstallArgs {
  profile: string;
  server: string;
  token: string;
  target?: AgentTarget;
  apply: boolean;
  out?: string;
}

/** Minimal hand-written argv parser (zero runtime deps). `loose` skips the
 * install-only required-arg checks (uninstall needs just --target). */
function parseArgs(argv: string[], loose = false): InstallArgs {
  const args: InstallArgs = { profile: '', server: '', token: '', apply: false };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new InstallError(`Missing value for ${a}`, 'VALIDATION_FAILED');
      return v;
    };
    switch (a) {
      case '--profile':
        args.profile = next();
        break;
      case '--server':
        args.server = next();
        break;
      case '--token':
        args.token = next();
        break;
      case '--target':
        args.target = next() as AgentTarget;
        break;
      case '--out':
        args.out = next();
        break;
      case '--apply':
        args.apply = true;
        break;
      default:
        throw new InstallError(`Unknown argument: ${a}`, 'VALIDATION_FAILED');
    }
  }

  if (loose) return args;

  for (const [k, v] of [
    ['--profile', args.profile],
    ['--server', args.server],
    ['--token', args.token],
  ] as const) {
    if (!v) throw new InstallError(`Missing required argument ${k}`, 'VALIDATION_FAILED');
  }
  return args;
}

/** Print target-specific post-install hints the adapters cannot perform themselves. */
function printHermesHints(_plan: InstallPlan): void {
  const w = getHermesPlanWarnings();
  const lines = ['\nHermes post-install steps:'];
  if (w.needsPluginEnable) {
    lines.push(
      `  • Enable the plugin: add '${w.pluginSlug}' to the 'plugins.enabled' list in config.yaml`,
    );
  }
  if (w.needsHnx) {
    lines.push(
      `  • MCP runs through the hnx stdio shim — run 'hnx enroll' on this machine if you haven't`,
    );
  }
  if (w.skipped.length > 0) {
    lines.push(`  • Skipped (Hermes model incompatibility):`);
    for (const s of w.skipped) lines.push(`      - ${s}`);
  }
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
}

/** Print Codex post-install hints. */
function printCodexHints(): void {
  const w = getCodexPlanWarnings();
  const lines = ['\nCodex post-install steps:'];
  if (w.needsHnx) {
    lines.push(
      `  • MCP runs through the hnx stdio shim — run 'hnx enroll' on this machine if you haven't`,
    );
  }
  if (w.skipped.length > 0) {
    lines.push(`  • Skipped (no verified Codex home-install format):`);
    for (const s of w.skipped) lines.push(`      - ${s}`);
  }
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
}

/** Print DeepSeek Harness (dsh) post-install hints. */
function printDeepseekHints(): void {
  const w = getDeepseekPlanWarnings();
  const lines = ['\nDeepSeek Harness post-install steps:'];
  if (w.needsHnx) {
    lines.push(
      `  • MCP runs through the hnx stdio shim (cordis.patch.yml row) — run 'hnx enroll' on this machine if you haven't`,
    );
  }
  if (w.skipped.length > 0) {
    lines.push(`  • Skipped (no verified dsh home-install format):`);
    for (const s of w.skipped) lines.push(`      - ${s}`);
  }
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
}

/** Print pi post-install hints. */
function printPiHints(): void {
  const w = getPiPlanWarnings();
  const lines = ['\npi post-install steps:'];
  if (w.skipped.length > 0) {
    lines.push(`  • Skipped (no declarative pi surface):`);
    for (const s of w.skipped) lines.push(`      - ${s}`);
  }
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
}

/** Render a plan for the dry-run preview. */
function formatPlan(plan: import('./install/types.js').InstallPlan): string {
  const lines = [
    `target:     ${plan.adapter.target} (${plan.adapter.kind})`,
    `root:       ${plan.targetRoot}`,
    `ledger:     ${plan.installStatePath}`,
    `sensitive:  ${plan.sensitive ? 'yes (direct-mode credentials inlined)' : 'no'}`,
    `operations: ${plan.operations.length}`,
    '',
  ];
  for (const [i, op] of plan.operations.entries()) {
    const tag =
      op.kind === 'copy-file'
        ? `copy  ${op.sourcePath}`
        : op.kind === 'write-file'
          ? `write ${op.content.length} bytes`
          : `merge ${JSON.stringify(op.mergePayload).length} bytes`;
    lines.push(`  [${i + 1}] ${op.kind.padEnd(10)} → ${op.destinationPath}`);
    lines.push(`       ${tag}`);
  }
  return lines.join('\n');
}

async function runInstall(args: InstallArgs): Promise<void> {
  const resolved = await resolveProfile({
    server: args.server,
    token: args.token,
    profileId: args.profile,
  });

  // Adapters read the server base from HN_SERVER when emitting `hnx mcp serve`
  // shim entries (they don't receive the resolver's options directly).
  process.env.HN_SERVER = args.server;

  const plan = planInstall(resolved, {
    ...(args.target !== undefined ? { target: args.target } : {}),
    input: args.out ? { outDir: args.out } : {},
  });

  // eslint-disable-next-line no-console
  console.log(formatPlan(plan));

  // Target-specific install hints (manual steps the adapters can't do).
  if (plan.adapter.target === 'hermes') {
    printHermesHints(plan);
  }
  if (plan.adapter.target === 'codex') {
    printCodexHints();
  }
  if (plan.adapter.target === 'deepseek') {
    printDeepseekHints();
  }
  if (plan.adapter.target === 'pi') {
    printPiHints();
  }

  if (!args.apply) {
    // eslint-disable-next-line no-console
    console.log('\n(dry-run — no files written. Add --apply to materialize.)');
    return;
  }

  applyInstall(plan, {
    profileId: resolved.profile.id,
    profileName: resolved.profile.name,
    profileVersion: resolved.profile.version,
  });

  // eslint-disable-next-line no-console
  console.log(`\nInstalled ${plan.operations.length} operation(s) into ${plan.targetRoot}.`);
  if (plan.sensitive) {
    // eslint-disable-next-line no-console
    console.warn(
      'WARNING: this install carries decrypted direct-mode credentials (chmod 0700 applied).',
    );
  }
}

/** Render an uninstall plan for the dry-run preview. */
function formatUninstallPlan(plan: import('./install/uninstaller.js').UninstallPlan): string {
  const lines = [
    `target:     ${plan.profile.name} (installed ${plan.installedAt})`,
    `root:       ${plan.targetRoot}`,
    `steps:      ${plan.steps.length}`,
    '',
  ];
  for (const [i, s] of plan.steps.entries()) {
    const flag = s.conflicts
      ? ' [modified since install → .hnx.bak]'
      : s.exists
        ? ''
        : ' [already gone]';
    lines.push(`  [${i + 1}] ${s.action.padEnd(7)} ${s.destinationPath}${flag}`);
  }
  return lines.join('\n');
}

function runUninstall(args: { target?: string; apply: boolean; out?: string }): number {
  if (!args.target) {
    throw new InstallError('Missing required argument --target', 'VALIDATION_FAILED');
  }
  const plan = planUninstall({
    target: args.target as AgentTarget,
    input: args.out ? { outDir: args.out } : {},
  });
  if (!plan) {
    // eslint-disable-next-line no-console
    console.error(
      `hnx: no install-state ledger found for target '${args.target}' — nothing installed (or already uninstalled).`,
    );
    return 1;
  }

  // eslint-disable-next-line no-console
  console.log(formatUninstallPlan(plan));
  if (!args.apply) {
    // eslint-disable-next-line no-console
    console.log('\n(dry-run — nothing removed. Add --apply to uninstall.)');
    return 0;
  }
  const touched = applyUninstall(plan);
  // eslint-disable-next-line no-console
  console.log(`\nUninstalled: ${touched} file(s) restored or removed.`);
  // eslint-disable-next-line no-console
  console.log(
    'Reminder: manual steps from install (e.g. plugins.enabled, env vars) are yours to undo.',
  );
  return 0;
}

// ---- enroll / daemon (Phase 8 C1) ----

interface EnrollArgs {
  server: string;
  token: string;
  name?: string;
}

function parseEnrollArgs(argv: string[]): EnrollArgs {
  const args: EnrollArgs = { server: '', token: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new InstallError(`Missing value for ${a}`, 'VALIDATION_FAILED');
      return v;
    };
    switch (a) {
      case '--server':
        args.server = next();
        break;
      case '--token':
        args.token = next();
        break;
      case '--name':
        args.name = next();
        break;
      default:
        throw new InstallError(`Unknown argument: ${a}`, 'VALIDATION_FAILED');
    }
  }
  for (const [k, v] of [
    ['--server', args.server],
    ['--token', args.token],
  ] as const) {
    if (!v) throw new InstallError(`Missing required argument ${k}`, 'VALIDATION_FAILED');
  }
  return args;
}

async function runEnroll(args: EnrollArgs): Promise<void> {
  const client = new HarnessNexusClient({ baseUrl: args.server, token: args.token });
  const { machine, token } = await client.createMachine({
    name: args.name ?? hostname(),
  });
  saveDaemonConfig({
    server: args.server,
    token,
    machineId: machine.id,
    ...(machine.name !== undefined ? { machineName: machine.name } : {}),
  });
  // eslint-disable-next-line no-console
  console.log(`Enrolled machine '${machine.name}' (${machine.id}).`);
  // eslint-disable-next-line no-console
  console.log(`Machine token saved to ${daemonConfigPath()} (0600) — never shown again.`);
  // eslint-disable-next-line no-console
  console.log('Bring it online with: hnx daemon');
}

interface DaemonArgs {
  server?: string;
  token?: string;
  machineId?: string;
}

function parseDaemonArgs(argv: string[]): DaemonArgs {
  const args: DaemonArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new InstallError(`Missing value for ${a}`, 'VALIDATION_FAILED');
      return v;
    };
    switch (a) {
      case '--server':
        args.server = next();
        break;
      case '--token':
        args.token = next();
        break;
      case '--machine-id':
        args.machineId = next();
        break;
      default:
        throw new InstallError(`Unknown argument: ${a}`, 'VALIDATION_FAILED');
    }
  }
  return args;
}

async function runDaemonCommand(args: DaemonArgs): Promise<void> {
  const merged = mergeDaemonConfig(args, loadDaemonConfig());
  // #20: the web-UI enrollment flow hands the identity over as CLI args
  // (Machines → Enroll → `hnx daemon --server --token --machine-id`).
  // Persist the merged identity — `hnx mcp serve`, spawned by agent tools
  // from the emitted .mcp.json, reads its token from this file; without the
  // save every MCP session died with a missing-token error.
  saveDaemonConfig(merged);
  await runDaemon({ server: merged.server, token: merged.token, machineId: merged.machineId });
}

interface McpServeArgs {
  profile: string;
  server?: string;
  token?: string;
}

function parseMcpServeArgs(argv: string[]): McpServeArgs {
  const args: McpServeArgs = { profile: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new InstallError(`Missing value for ${a}`, 'VALIDATION_FAILED');
      return v;
    };
    switch (a) {
      case '--profile':
        args.profile = next();
        break;
      case '--server':
        args.server = next();
        break;
      case '--token':
        args.token = next();
        break;
      default:
        throw new InstallError(`Unknown argument: ${a}`, 'VALIDATION_FAILED');
    }
  }
  if (!args.profile) {
    throw new InstallError('Missing required argument --profile', 'VALIDATION_FAILED');
  }
  return args;
}

function parseLogsArgs(argv: string[]): LogsArgs {
  const args: LogsArgs = { tail: 20 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new InstallError(`Missing value for ${a}`, 'VALIDATION_FAILED');
      return v;
    };
    switch (a) {
      case '--tail': {
        const n = Number(next());
        if (!Number.isInteger(n) || n < 1) {
          throw new InstallError('--tail expects a positive integer', 'VALIDATION_FAILED');
        }
        args.tail = n;
        break;
      }
      case '--bundle':
        args.bundle = next();
        break;
      default:
        throw new InstallError(`Unknown argument: ${a}`, 'VALIDATION_FAILED');
    }
  }
  return args;
}

interface TuiArgs {
  dump: boolean;
}

function parseTuiArgs(argv: string[]): TuiArgs {
  const args: TuiArgs = { dump: false };
  for (const a of argv) {
    if (a === '--dump') {
      args.dump = true;
      continue;
    }
    throw new InstallError(`Unknown argument: ${a}`, 'VALIDATION_FAILED');
  }
  return args;
}

async function runMcpServeCommand(args: McpServeArgs): Promise<void> {
  const config = loadDaemonConfig();
  const server = args.server ?? config?.server;
  const token = args.token ?? config?.token;
  if (!server || !token) {
    throw new InstallError(
      'No server/token: run "hnx enroll" first, or pass --server/--token.',
      'VALIDATION_FAILED',
    );
  }
  await runMcpServe({ profileId: args.profile, server, token });
}

async function main(argv: string[]): Promise<number> {
  const [, , subcommand, ...rest] = argv;

  if (subcommand === '--version' || subcommand === '-v') {
    // eslint-disable-next-line no-console
    console.log(cliVersion());
    return 0;
  }

  if (!subcommand || subcommand === '-h' || subcommand === '--help') {
    // eslint-disable-next-line no-console
    console.log(HELP);
    return 0;
  }

  if (subcommand === 'install' || subcommand === 'uninstall') {
    if (rest.includes('-h') || rest.includes('--help')) {
      // eslint-disable-next-line no-console
      console.log(HELP);
      return 0;
    }
    try {
      if (subcommand === 'install') {
        const args = parseArgs(rest);
        const startedAt = Date.now();
        try {
          await runInstall(args);
        } catch (e) {
          // #38 — manual installs share the daemon's operation trail.
          if (args.apply) {
            logOp({
              op: 'install',
              target: args.target ?? 'profile',
              outcome: 'error',
              ms: Date.now() - startedAt,
              detail: `profile ${args.profile} — ${e instanceof Error ? e.message : String(e)}`,
            });
          }
          throw e;
        }
        if (args.apply) {
          logOp({
            op: 'install',
            target: args.target ?? 'profile',
            outcome: 'ok',
            ms: Date.now() - startedAt,
            detail: `profile ${args.profile}`,
          });
        }
        return 0;
      }
      const args = parseArgs(rest, /* loose */ true);
      const code = runUninstall(args);
      if (args.apply) {
        logOp({
          op: 'uninstall',
          target: args.target ?? 'profile',
          outcome: code === 0 ? 'ok' : 'error',
        });
      }
      return code;
    } catch (e) {
      if (e instanceof InstallError) {
        // eslint-disable-next-line no-console
        console.error(`hnx: ${e.code}: ${e.message}`);
        return 1;
      }
      // eslint-disable-next-line no-console
      console.error(`hnx: unexpected error: ${e instanceof Error ? e.message : String(e)}`);
      return 2;
    }
  }

  if (subcommand === 'logs') {
    return runLogsCommand(parseLogsArgs(rest));
  }

  if (
    subcommand === 'enroll' ||
    subcommand === 'daemon' ||
    subcommand === 'tui' ||
    subcommand === 'mcp'
  ) {
    if (rest.includes('-h') || rest.includes('--help')) {
      // eslint-disable-next-line no-console
      console.log(HELP);
      return 0;
    }
    try {
      if (subcommand === 'enroll') {
        await runEnroll(parseEnrollArgs(rest));
        return 0;
      }
      if (subcommand === 'daemon') {
        await runDaemonCommand(parseDaemonArgs(rest));
        return 0;
      }
      if (subcommand === 'tui') {
        const tuiArgs = parseTuiArgs(rest);
        const merged = mergeDaemonConfig({}, loadDaemonConfig());
        saveDaemonConfig(merged);
        return await runTuiCommand({
          server: merged.server,
          token: merged.token,
          machineId: merged.machineId,
          dump: tuiArgs.dump,
        });
      }
      const [serve, ...serveRest] = rest;
      if (serve !== 'serve') {
        throw new InstallError(
          `Unknown 'mcp' subcommand '${String(serve)}' — expected 'hnx mcp serve'.`,
          'VALIDATION_FAILED',
        );
      }
      await runMcpServeCommand(parseMcpServeArgs(serveRest));
      return 0;
    } catch (e) {
      if (e instanceof InstallError) {
        // eslint-disable-next-line no-console
        console.error(`hnx: ${e.code}: ${e.message}`);
        return 1;
      }
      // eslint-disable-next-line no-console
      console.error(`hnx: unexpected error: ${e instanceof Error ? e.message : String(e)}`);
      return 2;
    }
  }

  // eslint-disable-next-line no-console
  console.error(`hnx: unknown subcommand '${subcommand}'. Run 'hnx --help'.`);
  return 2;
}

main(process.argv).then((code) => process.exit(code));
