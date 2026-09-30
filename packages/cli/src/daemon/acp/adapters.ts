import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentTarget } from '@harness-nexus/shared';

/**
 * Per-target ACP adapter wiring (Phase 8 C5) — the adapter matrix from
 * wiki research-phase-8-c5-acp-web-demo.md, executable. Every adapter speaks
 * ACP v1 (JSON-RPC 2.0, newline-delimited) over stdio, so the daemon needs
 * only the command line per target.
 *
 * `HN_ACP_COMMAND_<TARGET>` (`-`→`_`, upper) replaces the whole command line
 * (split on whitespace) — the hook for pinned/local installs and for pointing
 * tests at a fixture agent. Target-scoped `env` applies either way: it keys
 * off the TARGET, not the command line.
 */
interface AcpAdapterSpec {
  readonly command: readonly string[];
  /**
   * Issue #2 — the npm identity behind an `npx -y` row: `[spec, bin]` where
   * the spec CARRIES the version (validated on the rig; upgrading = bumping
   * this constant — `npx` used to float `latest`). The daemon provisions a
   * pinned install once (`adapter-provision.ts`: `npm i --prefix
   * ~/.hnx/acp-adapters` + patch set) and `resolveAcpCommand` prefers its
   * absolute bin; npx stays the fallback while/when provisioning has not
   * landed.
   */
  readonly pkg?: readonly [string, string];
  /** Extra spawn env, layered UNDER the daemon's spawn env (9 W14.1). */
  readonly env?: Readonly<Record<string, string>>;
}

const DEFAULT_ACP_COMMANDS: Record<AgentTarget, AcpAdapterSpec | null> = {
  // The ACP project's official wrapper (took over from @zed-industries's
  // 0.23.x, which the daemon shipped until 2026-09). Reason for the swap,
  // rig-verified: the old wrapper never requests thinking on gateway/unknown
  // models (MAX_THINKING_TOKENS on the adapter env didn't help either), so
  // chat showed no thought stream; the official 0.76.0 streams
  // agent_thought_chunk by default, advertises loadSession + list/resume
  // (both caps shapes the daemon already detects), and returns full
  // SessionInfo. Same switch the stable reference CC bridge runs.
  //
  // 9 W14.1 — CLAUDE_CODE_ENABLE_TODO_TOOLS: claude CLI ≥2.1.233 ships the
  // task/todo tools (TaskCreate/…/TaskUpdate) DISABLED by default, and the
  // wrapper's bundled SDK CLI (2.1.270) drops them for every model — without
  // them the agent never emits the ACP plan updates the W14 todo panel feeds
  // on. This documented opt-in revives them (rig-verified: plan snapshots
  // flow end-to-end; ground truth in wiki research-phase-9-w14.1-claude-ground-truth.md).
  'claude-code': {
    command: ['npx', '-y', '@agentclientprotocol/claude-agent-acp@0.79.0'],
    pkg: ['@agentclientprotocol/claude-agent-acp@0.79.0', 'claude-agent-acp'],
    env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' },
  },
  // Official Zed adapter wrapping the OpenAI Codex CLI (needs `codex` on PATH).
  codex: {
    command: ['npx', '-y', '@zed-industries/codex-acp@0.16.0'],
    pkg: ['@zed-industries/codex-acp@0.16.0', 'codex-acp'],
  },
  // DeepSeek Harness ships a native ACP v1 profile (needs `dsh` on PATH and a
  // configured provider route — T1 research § ACP).
  deepseek: { command: ['dsh', '--profile', 'acp'] },
  // Hermes ships a native ACP adapter as an install extra.
  hermes: { command: ['python3', '-m', 'acp_adapter'] },
  // 9 W12 — OpenCode speaks ACP NATIVELY: `opencode acp` (official docs
  // /docs/acp; no wrapper needed, needs `opencode` on PATH).
  opencode: { command: ['opencode', 'acp'] },
  // 9 W16 — pi speaks NO ACP: the chat factory branches to PiRpcConnection
  // (daemon/acp/pi-connection.ts), an in-daemon façade over `pi --mode rpc`.
  // This null row only keeps the record exhaustive — resolveAcpCommand is
  // never consulted for pi (and would answer null anyway).
  pi: null,
  zcode: null, // no adapter exists (also no install adapter — 3.x)
  generic: null,
};

export interface AcpCommand {
  command: string;
  args: string[];
  /** Target-scoped extra env for the spawn (may be undefined). */
  env?: Record<string, string>;
}

/** The pinned-install bin path for an npx-backed row, or null when absent. */
function pinnedAcpCommand(
  def: AcpAdapterSpec,
  home: string,
): { command: string; args: string[] } | null {
  if (def.pkg === undefined) return null;
  const bin = join(home, '.hnx', 'acp-adapters', 'node_modules', '.bin', def.pkg[1]);
  for (const candidate of pinnedBinCandidates(bin)) {
    if (existsSync(candidate)) return { command: candidate, args: [] };
  }
  return null;
}

/**
 * #34 — a pinned bin resolves differently per platform: Windows npm writes
 * an extensionless POSIX sh shim next to `<bin>.cmd`, and only the `.cmd`
 * executes. The sh file exists, so the extensionless candidate would match
 * and then die at spawn ("not a valid Win32 application" → session-start
 * timeout once #32 lets provisioning succeed on Windows).
 */
export function pinnedBinCandidates(bin: string, isWin = process.platform === 'win32'): string[] {
  return isWin ? [`${bin}.cmd`, bin] : [bin];
}

/** The npx-backed rows' npm identities — what `adapter-provision.ts` installs. */
export interface PinnedAdapterSpec {
  spec: string;
  bin: string;
}

export const PINNED_ADAPTER_SPECS: readonly PinnedAdapterSpec[] = Object.values(
  DEFAULT_ACP_COMMANDS,
).flatMap((def) => (def?.pkg !== undefined ? [{ spec: def.pkg[0], bin: def.pkg[1] }] : []));

export function resolveAcpCommand(
  target: AgentTarget,
  env: NodeJS.ProcessEnv,
  opts: { homeDir?: string } = {},
): AcpCommand | null {
  const override = env[`HN_ACP_COMMAND_${target.toUpperCase().replace(/-/g, '_')}`];
  const def = DEFAULT_ACP_COMMANDS[target];
  if (def === null) return null;
  const base =
    override !== undefined && override.trim() !== ''
      ? (() => {
          const parts = override.trim().split(/\s+/);
          return { command: parts[0]!, args: parts.slice(1) };
        })()
      : (pinnedAcpCommand(def, opts.homeDir ?? homedir()) ?? {
          command: def.command[0]!,
          args: def.command.slice(1),
        });
  return { ...base, ...(def.env !== undefined ? { env: { ...def.env } } : {}) };
}
