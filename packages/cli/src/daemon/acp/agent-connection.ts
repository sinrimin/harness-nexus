import { type ChildProcess } from 'node:child_process';
import { spawn } from '../../proc.js';
import { createInterface } from 'node:readline';
import { groupIsAlive, groupSignalTarget } from '../adapter-ledger.js';

/**
 * Minimal ACP client over a subprocess's stdio (Phase 8 C5) — JSON-RPC 2.0,
 * newline-delimited, exactly the wire the ACP v1 adapters speak. Hand-rolled
 * on purpose (no new dependency): three message shapes cover the whole
 * surface — requests with id correlation + timeouts, notifications, and the
 * one agent→client request (`session/request_permission`). The fixture agent
 * (test/fixtures/acp-agent.mjs) is the compatibility proof.
 */

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export type PermissionOutcome =
  { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };

/**
 * A JSON-RPC request id, echoed VERBATIM when answering an agent-initiated
 * request. Adapters disagree on the shape: the Zed wrappers count ints, but
 * codex-acp sends UUIDs — so a `Number()` coercion turns its id into NaN and
 * the encoded reply carries `"id":null`, which the agent cannot match (the
 * permission then waits forever and the turn hangs).
 */
export type JsonRpcId = string | number | null;

export interface AcpAgentInfo {
  name?: string | undefined;
  version?: string | undefined;
}

/** The resume-relevant slice of `agentCapabilities` (9 W7). */
export interface AcpSessionCaps {
  /** `session/load` — resume WITH history replay (claude/codex adapters). */
  load: boolean;
  /** `session/resume` — resume WITHOUT replay (dsh's native adapter). */
  resume: boolean;
  /** `session/list` exists (the claude/codex listing path). */
  list: boolean;
}

/**
 * Advertised caps decide the resume dialect (9 W7): prefer `session/load`
 * (replay for free), fall back to `session/resume`. `loadSession` is the
 * pre-capability legacy flag — and WHERE it sits differs by adapter family:
 * the Zed adapters set it at the initialize RESULT ROOT, the official
 * `@agentclientprotocol/claude-agent-acp` sets it NESTED inside
 * `agentCapabilities.loadSession` while its `sessionCapabilities` has `resume`
 * but NOT `load`. Reading only the root made the official wrapper look like a
 * resume-only adapter — claude-code channels then resumed with NO replay
 * ("opening a history session shows an empty pane").
 */
export function deriveSessionCaps(result: unknown): AcpSessionCaps {
  const r = (result ?? {}) as {
    loadSession?: boolean;
    agentCapabilities?: { loadSession?: boolean; sessionCapabilities?: Record<string, unknown> };
  };
  const caps = r.agentCapabilities?.sessionCapabilities ?? {};
  return {
    load:
      caps['load'] !== undefined ||
      r.loadSession === true ||
      r.agentCapabilities?.loadSession === true,
    resume: caps['resume'] !== undefined,
    list: caps['list'] !== undefined,
  };
}

/**
 * 9 W9 B — prompt-content capabilities from the initialize result. `image`
 * gates the composer's attach affordance; dsh derives it per model route so
 * a live channel may legitimately advertise false.
 */
export function derivePromptCaps(result: unknown): { image: boolean } {
  const r = (result ?? {}) as {
    agentCapabilities?: { promptCapabilities?: { image?: unknown } };
  };
  return { image: r.agentCapabilities?.promptCapabilities?.image === true };
}

/**
 * 9 W16 — the connection surface `chat.ts` drives. Historically duck-typed
 * against AcpAgentConnection alone; the pi façade (pi-connection.ts, an
 * in-daemon ACP↔pi-RPC translator) implements the SAME surface, so the chat
 * pipeline is shared verbatim across both dialect classes.
 */
export interface AgentConnection {
  readonly pgid: number | null;
  /** ACP-shaped request (the pi façade translates to pi commands). */
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown>;
  /** Answer the agent's `session/request_permission` (optionId verbatim). */
  respondPermission(jsonrpcId: JsonRpcId, outcome: PermissionOutcome): void;
  /** Answer the agent's `elicitation/create`. */
  respondElicitation(
    jsonrpcId: JsonRpcId,
    response:
      | { action: 'accept'; content: Record<string, unknown> }
      | { action: 'decline' }
      | { action: 'cancel' },
  ): void;
  setNotificationHandler(handler: (method: string, params: Record<string, unknown>) => void): void;
  setPermissionHandler(
    handler: (jsonrpcId: JsonRpcId, params: Record<string, unknown>) => void,
  ): void;
  setElicitationHandler(
    handler: (jsonrpcId: JsonRpcId, params: Record<string, unknown>) => void,
  ): void;
  /** Fires when the subprocess exits on its own (crash/quit) — not on kill(). */
  onExit(handler: () => void): void;
  isGroupAlive(): boolean;
  kill(graceMs?: number): void;
}

export class AcpAgentConnection implements AgentConnection {
  private proc: ChildProcess;
  /** The detached leader's pid — which is also its process-group id. */
  readonly pgid: number | null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private stderrTail: string[] = [];
  private onNotification: ((method: string, params: Record<string, unknown>) => void) | null = null;
  private onPermission: ((jsonrpcId: JsonRpcId, params: Record<string, unknown>) => void) | null =
    null;
  private onElicitation: ((jsonrpcId: JsonRpcId, params: Record<string, unknown>) => void) | null =
    null;
  private exited = false;

  private constructor(proc: ChildProcess) {
    this.proc = proc;
    this.pgid = proc.pid ?? null;
    const rl = createInterface({ input: proc.stdout! });
    rl.on('line', (line) => this.handleLine(line));
    proc.stderr?.on('data', (chunk: Buffer) => {
      // Keep a small tail for spawn/initialize failure messages.
      for (const l of chunk.toString('utf8').split('\n')) {
        if (l.trim() !== '') {
          this.stderrTail.push(l.trimEnd());
          if (this.stderrTail.length > 10) this.stderrTail.shift();
        }
      }
    });
    proc.on('exit', () => {
      this.exited = true;
      const err = new Error(`agent process exited unexpectedly${this.stderrTailSuffix()}`);
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
    });
  }

  /**
   * Spawn + `initialize` handshake + `initialized` notification.
   *
   * 9 W11 A — `onSpawned` fires synchronously right after the detached spawn
   * (BEFORE initialize) so the caller can ledger the process group while the
   * hard-death window is still open; a throwing callback kills the spawn and
   * fails the start (an unledgered adapter is worse than a closed channel).
   */
  static async start(
    command: string,
    args: string[],
    opts: {
      cwd: string;
      env?: NodeJS.ProcessEnv | undefined;
      initializeTimeoutMs?: number;
      onSpawned?: (pgid: number) => void;
    },
  ): Promise<{
    conn: AcpAgentConnection;
    agentInfo: AcpAgentInfo;
    sessionCaps: AcpSessionCaps;
    promptCaps: { image: boolean };
  }> {
    const initializeTimeoutMs = opts.initializeTimeoutMs ?? 20000;
    let proc: ChildProcess;
    try {
      proc = spawn(command, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        // #33: no console window per child on Windows (each session spawn
        // otherwise pops one up on the user's desktop).
        windowsHide: true,
        // Own process group: adapters spawn their own trees (npm → sh →
        // wrapper → the vendor binary). Signaling only the direct child
        // orphaned the grandchildren — a bare `claude` binary survived every
        // teardown, parented to init. kill() takes the whole group down.
        // POSIX-only: kill(-pgid) has no Windows equivalent (it just throws
        // into the catch), and detaching there only detaches the console —
        // grandchildren then get auto-allocated VISIBLE consoles (#35).
        // Attached on win32, the tree inherits the daemon's console.
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      throw new Error(`failed to spawn ACP adapter '${command}': ${errText(e)}`);
    }
    const conn = new AcpAgentConnection(proc);
    proc.on('error', (e) => {
      conn.failAll(new Error(`ACP adapter '${command}' failed: ${errText(e)}`));
    });
    if (opts.onSpawned !== undefined && proc.pid !== undefined) {
      try {
        opts.onSpawned(proc.pid);
      } catch (e) {
        conn.kill();
        throw new Error(`failed to ledger ACP adapter '${command}': ${errText(e)}`);
      }
    }
    let result: {
      agentInfo?: AcpAgentInfo;
      loadSession?: boolean;
      agentCapabilities?: { sessionCapabilities?: Record<string, unknown> };
    };
    try {
      result = (await conn.request(
        'initialize',
        // 9 W14.1 — advertise form-elicitation support: claude-agent-acp
        // keeps AskUserQuestion in `disallowedTools` unless the client can
        // render elicitations, and only forwards MCP-server elicitations for
        // advertised modes. Other adapters ignore the capability. url mode is
        // deliberately NOT advertised (no OAuth-jump UI in the portal).
        { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } } },
        initializeTimeoutMs,
      )) as typeof result;
    } catch (e) {
      // The caller never receives this connection (start has not returned),
      // so no one else would kill it — a timed-out/failed initialize must
      // not leak the spawned group. This closes the pre-W11 leak where a
      // hung initialize left a live adapter behind a dead channel.
      conn.kill();
      throw e;
    }
    conn.notify('initialized', {});
    return {
      conn,
      agentInfo: result?.agentInfo ?? {},
      sessionCaps: deriveSessionCaps(result),
      promptCaps: derivePromptCaps(result),
    };
  }

  /** JSON-RPC request with a timeout; rejects on error/exit. */
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.exited || this.proc.stdin === null) {
      return Promise.reject(new Error('agent process is not running'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // initialize timeouts carry the spawn's stderr tail — the wrapper
        // never answered, so npm/npx diagnostics (a corrupted _npx cache
        // dying on ENOTEMPTY, a registry stall) are the ONLY clue. Established
        // sessions keep clean timeout messages (their stderr is stale).
        reject(
          new Error(
            `ACP request '${method}' timed out after ${timeoutMs}ms` +
              (method === 'initialize' ? this.stderrTailSuffix() : ''),
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve,
        reject,
        timer: timer as unknown as NodeJS.Timeout,
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  /** Answer the agent's `session/request_permission` (optionId verbatim). */
  respondPermission(jsonrpcId: JsonRpcId, outcome: PermissionOutcome): void {
    this.send({ jsonrpc: '2.0', id: jsonrpcId, result: { outcome } });
  }

  /**
   * Answer the agent's `elicitation/create`. An accept carries the form
   * values verbatim as the ACP `content` (keyed by property name).
   */
  respondElicitation(
    jsonrpcId: JsonRpcId,
    response:
      | { action: 'accept'; content: Record<string, unknown> }
      | { action: 'decline' }
      | { action: 'cancel' },
  ): void {
    this.send({ jsonrpc: '2.0', id: jsonrpcId, result: response });
  }

  setNotificationHandler(handler: (method: string, params: Record<string, unknown>) => void): void {
    this.onNotification = handler;
  }

  setPermissionHandler(
    handler: (jsonrpcId: JsonRpcId, params: Record<string, unknown>) => void,
  ): void {
    this.onPermission = handler;
  }

  setElicitationHandler(
    handler: (jsonrpcId: JsonRpcId, params: Record<string, unknown>) => void,
  ): void {
    this.onElicitation = handler;
  }

  /** Fires when the subprocess exits on its own (crash/quit) — not on kill(). */
  onExit(handler: () => void): void {
    this.proc.on('exit', handler);
  }

  /**
   * Whether the process GROUP still exists (the audit's backstop — a session
   * whose group died without the exit event reaching teardown).
   */
  isGroupAlive(): boolean {
    return this.pgid !== null && groupIsAlive(this.pgid);
  }

  /**
   * SIGTERM the whole process GROUP, then SIGKILL it after `graceMs`.
   * Idempotent. The group signal is the point: the direct child (npm/npx)
   * dying does NOT take the wrapper and the vendor binary with it — they
   * reparent to init and keep running. The timer is unref'd and NOT cleared
   * on leader exit: grandchildren can outlive the leader, and the follow-up
   * SIGKILL to a dead group is a caught ESRCH.
   */
  kill(graceMs = 3000): void {
    if (this.exited || this.proc.stdin === null) return;
    this.proc.removeAllListeners('exit');
    const pid = this.proc.pid;
    const sigGroup = (sig: NodeJS.Signals): void => {
      if (pid === undefined) return;
      try {
        // Negative pid = the process group on POSIX; the bare leader on
        // win32 (#42 — no process groups there, -pid just throws).
        process.kill(groupSignalTarget(pid), sig);
      } catch {
        // group already gone
      }
    };
    const killTimer = setTimeout(() => sigGroup('SIGKILL'), graceMs);
    killTimer.unref();
    sigGroup('SIGTERM');
    this.proc.kill('SIGTERM'); // the leader too (belt and braces)
    this.failAll(new Error('agent process killed'));
    this.exited = true;
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let msg: {
      id?: number | string | null;
      result?: unknown;
      error?: { message?: string };
      method?: string;
      params?: Record<string, unknown>;
    };
    try {
      msg = JSON.parse(trimmed) as typeof msg;
    } catch {
      return; // agents log noise on stdout sometimes; skip non-JSON lines
    }

    if (msg.method === 'session/request_permission' && msg.id !== undefined) {
      this.onPermission?.(msg.id, msg.params ?? {});
      return;
    }
    // 9 W14.1 — ACP elicitation rides a TOP-LEVEL `elicitation/create`
    // request (not the session/request envelope); probe-captured against
    // claude-agent-acp 0.78.0. Only form-mode requests reach us (we
    // advertise `elicitation.form` alone).
    if (msg.method === 'elicitation/create' && msg.id !== undefined) {
      this.onElicitation?.(msg.id, msg.params ?? {});
      return;
    }
    if (msg.method !== undefined) {
      if (msg.id === undefined || msg.id === null) {
        this.onNotification?.(msg.method, msg.params ?? {});
      }
      return; // agent-side extension requests are not implemented (v1) — dropped
    }
    if (msg.id !== undefined && msg.id !== null) {
      const pending = this.pending.get(Number(msg.id));
      if (!pending) return;
      this.pending.delete(Number(msg.id));
      clearTimeout(pending.timer);
      if (msg.error !== undefined) {
        // Error `data` rides along — the callers key retry/surface logic off
        // it. The detail FIELD differs per adapter dialect: dsh uses
        // `data.details`, codex-acp uses `data.message` (its top-level
        // message is a useless "Internal error").
        const data = (msg.error as { data?: { details?: string; message?: string } }).data;
        const details = [data?.message, data?.details].filter(Boolean).join(': ');
        pending.reject(
          new Error(`${msg.error.message ?? 'ACP request failed'}${details ? `: ${details}` : ''}`),
        );
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  private send(message: unknown): void {
    if (this.proc.stdin === null || this.exited) return;
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private stderrTailSuffix(): string {
    return this.stderrTail.length > 0 ? `: ${this.stderrTail.join(' | ')}` : '';
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
