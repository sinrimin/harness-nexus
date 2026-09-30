import { type ChildProcess } from 'node:child_process';
import { spawn } from '../../proc.js';
import { readdirSync, readFileSync } from 'node:fs';
import { groupIsAlive, groupSignalTarget } from '../adapter-ledger.js';
import { piFindSessionFile, piSessionReplay, type PiReplayUpdate } from '../pi-sessions.js';
import { hasTokenCounts, normalizeUsage } from '../usage.js';
import type {
  AgentConnection,
  AcpSessionCaps,
  JsonRpcId,
  PermissionOutcome,
} from './agent-connection.js';

/**
 * PiRpcConnection (Phase 9 W16) — the SELF-DEVELOPED ACP façade over pi's
 * `--mode rpc` JSONL dialect. pi speaks NO Agent Client Protocol (verified:
 * the pi.dev docs tree has no ACP page), but `chat.ts` drives every
 * connection through the narrow `AgentConnection` surface speaking pure ACP
 * method names — so this class TRANSLATES in-process instead of spawning a
 * third-party bridge: ACP requests in → pi commands out, pi events in →
 * `session/update` notifications out (design
 * wiki design-phase-9-w16-pi-agent.md §2; svkozak/pi-acp is the reference
 * for the dialect, not a dependency).
 *
 * The load-bearing dialect fact: pi's `prompt` command ACKNOWLEDGES
 * immediately (`{success:true}` = accepted/queued) while ACP semantics
 * resolve the `session/prompt` request at TURN END — so the façade HOLDS the
 * ACP response until pi's `agent_settled` (or an abort settling), the same
 * class of wait as the W7 dsh `turn_result` handling.
 *
 * Line codec: split on `\n` ONLY — pi's docs explicitly warn that Node's
 * `readline` also splits on U+2028/U+2029, which are legal inside JSON
 * strings. A hand-rolled buffer, not `createInterface`.
 */

/** Resolve the pi spawn command (override: `HN_ACP_COMMAND_PI`, fixtures/pins). */
export function resolvePiCommand(env: NodeJS.ProcessEnv): {
  command: string;
  args: string[];
  env?: Record<string, string>;
} {
  const override = env['HN_ACP_COMMAND_PI'];
  if (override !== undefined && override.trim() !== '') {
    const parts = override.trim().split(/\s+/);
    return { command: parts[0]!, args: parts.slice(1) };
  }
  return { command: 'pi', args: ['--mode', 'rpc'] };
}

type UnknownRecord = Record<string, unknown>;

interface PiPending {
  resolve: (result: UnknownRecord) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface HeldPrompt {
  settled: boolean;
  timer: NodeJS.Timeout;
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
}

// ---- pure dialect mappers (exported for unit tests) ----

function pickString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** pi model refs are `provider/id`-shaped; entries may be strings or objects. */
export function piModelRef(entry: unknown): string | null {
  if (typeof entry === 'string') return entry.length > 0 ? entry : null;
  if (typeof entry !== 'object' || entry === null) return null;
  const e = entry as UnknownRecord;
  const id = pickString(e['id']) ?? pickString(e['modelId']) ?? pickString(e['model']);
  if (id === null) return null;
  const provider = pickString(e['provider']);
  return id.includes('/') || provider === null ? id : `${provider}/${id}`;
}

/** Map ONE pi model-list entry to a picker option row. */
function piModelOption(entry: unknown): { value: string; name: string } | null {
  const value = piModelRef(entry);
  if (value === null) return null;
  const name =
    (typeof entry === 'object' && entry !== null
      ? pickString((entry as UnknownRecord)['name'])
      : null) ??
    value.split('/').pop() ??
    value;
  return { value, name };
}

/** Flatten ACP prompt blocks onto pi's `prompt` command inputs. */
export function flattenPiPrompt(prompt: unknown): { message: string; images: string[] } {
  const blocks = Array.isArray(prompt) ? prompt : [];
  let message = '';
  const images: string[] = [];
  for (const b of blocks) {
    const block = (b ?? {}) as UnknownRecord;
    switch (block['type']) {
      case 'text': {
        const text = pickString(block['text']);
        if (text !== null) message += text;
        break;
      }
      case 'resource_link': {
        // dsh-like marker — pi has no link blocks; the agent reads the target
        // with its own tools when the path is visible.
        message += `[@${String(block['name'] ?? '')}](${String(block['uri'] ?? '')})`;
        break;
      }
      case 'image': {
        const data = pickString(block['data']);
        if (data !== null) images.push(data);
        break;
      }
      default:
        break;
    }
  }
  return { message, images };
}

function textifyResult(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result !== null && typeof result === 'object') {
    const r = result as UnknownRecord;
    // pi tool results are commonly {output: [{type:'text',text}]} shaped
    if (Array.isArray(r['output'])) {
      const parts: string[] = [];
      for (const o of r['output']) {
        const block = (o ?? {}) as UnknownRecord;
        if (block['type'] === 'text' && typeof block['text'] === 'string')
          parts.push(block['text']);
      }
      if (parts.length > 0) return parts.join('\n');
    }
  }
  try {
    return JSON.stringify(result) ?? '';
  } catch {
    return String(result);
  }
}

/**
 * Map ONE pi RPC event to an ACP `session/update` UPDATE object (the
 * `sessionUpdate` arm). Null = not a chat-stream event (lifecycle, acks,
 * unrenderable). Pure; the connection wraps the result in the envelope.
 */
export function piEventToAcpUpdate(event: unknown): UnknownRecord | null {
  const e = (event ?? {}) as UnknownRecord;
  switch (e['type']) {
    case 'message_update': {
      // rig-verified (pi 0.85.1): the delta rides `assistantMessageEvent`
      // ({type:'text_delta'|'thinking_delta', contentIndex, delta}); the
      // `update` spelling stays as a pre-verification cushion.
      const u = (e['assistantMessageEvent'] ?? e['update'] ?? e) as UnknownRecord;
      const delta = pickString(u['delta']) ?? pickString(u['text']) ?? pickString(u['thinking']);
      if (delta === null) return null;
      const kind = pickString(u['type']) ?? '';
      if (kind.startsWith('thinking')) {
        return { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: delta } };
      }
      return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: delta } };
    }
    case 'tool_execution_start': {
      const callId = pickString(e['toolCallId']);
      const tool = pickString(e['tool']);
      if (callId === null || tool === null) return null;
      return {
        sessionUpdate: 'tool_call',
        toolCallId: callId,
        title: tool,
        ...(e['arguments'] !== undefined ? { rawInput: JSON.stringify(e['arguments']) } : {}),
      };
    }
    case 'tool_execution_update':
    case 'tool_execution_end': {
      const callId = pickString(e['toolCallId']);
      if (callId === null) return null;
      const payload = e['type'] === 'tool_execution_end' ? e['result'] : e['partialResult'];
      const text = payload === undefined ? '' : textifyResult(payload);
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: callId,
        ...(text !== '' ? { content: [{ type: 'text', text }] } : {}),
        ...(e['type'] === 'tool_execution_end' ? { status: 'completed' } : {}),
      };
    }
    case 'bash_execution_update': {
      // pi keys bash by a plain `id` and streams deltas; the fold upserts the
      // row by callId, so an update-shaped arm is enough.
      const callId = pickString(e['id']);
      if (callId === null) return null;
      const delta = pickString(e['delta']) ?? pickString(e['output']);
      return {
        sessionUpdate: 'tool_call_update',
        toolCallId: callId,
        ...(delta !== null ? { content: [{ type: 'text', text: delta }] } : {}),
      };
    }
    case 'message_end': {
      // Deltas already streamed the content; message_end is authoritative
      // CONTENT (ignored here) + USAGE (kept — feeds the turn tail). The
      // dialect pick (inputTokens/input, cache spellings) lives in one place.
      const message = (e['message'] ?? {}) as UnknownRecord;
      const usage = (message['usage'] ?? e['usage']) as UnknownRecord | undefined;
      if (usage === undefined || typeof usage !== 'object' || usage === null) return null;
      const fields = normalizeUsage(usage);
      if (!hasTokenCounts(fields)) return null;
      return { sessionUpdate: 'usage_update', usage: fields };
    }
    default:
      return null; // agent_start/end/settled, turn_*, queue_*, compaction_*, extension_error…
  }
}

// ---- the connection ----

export interface PiStartResult {
  conn: PiRpcConnection;
  agentInfo: { name: string; version?: string };
  sessionCaps: AcpSessionCaps;
  promptCaps: { image: boolean };
}

export class PiRpcConnection implements AgentConnection {
  readonly pgid: number | null;
  private proc: ChildProcess;
  private readonly sessionsDir: string;
  private nextId = 1;
  private pending = new Map<number, PiPending>();
  private lineBuf = '';
  private stderrTail: string[] = [];
  private exited = false;
  private onNotification: ((method: string, params: Record<string, unknown>) => void) | null = null;
  /** pi has neither permissions nor elicitations — the setters are no-ops. */
  private heldPrompt: HeldPrompt | null = null;
  private abortRequested = false;
  private sessionId: string | null = null;

  private constructor(proc: ChildProcess, sessionsDir: string) {
    this.proc = proc;
    this.pgid = proc.pid ?? null;
    this.sessionsDir = sessionsDir;
    // \n ONLY (never readline — it splits U+2028/U+2029 inside JSON strings).
    proc.stdout!.on('data', (chunk: Buffer) => {
      this.lineBuf += chunk.toString('utf8');
      let nl = this.lineBuf.indexOf('\n');
      while (nl !== -1) {
        const line = this.lineBuf.slice(0, nl).replace(/\r$/, '');
        this.lineBuf = this.lineBuf.slice(nl + 1);
        if (line.trim() !== '') this.handleLine(line);
        nl = this.lineBuf.indexOf('\n');
      }
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      for (const l of chunk.toString('utf8').split('\n')) {
        if (l.trim() !== '') {
          this.stderrTail.push(l.trimEnd());
          if (this.stderrTail.length > 10) this.stderrTail.shift();
        }
      }
    });
    proc.on('exit', () => {
      this.exited = true;
      const err = new Error(`pi process exited unexpectedly${this.stderrTailSuffix()}`);
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      if (this.heldPrompt !== null && !this.heldPrompt.settled) {
        clearTimeout(this.heldPrompt.timer);
        this.heldPrompt.settled = true;
        this.heldPrompt.reject(err);
        this.heldPrompt = null;
      }
    });
  }

  /**
   * Spawn `pi --mode rpc` + a `get_state` startup probe. pi has NO handshake;
   * the probe is the initialize-failure gate (a spawn that never answers is
   * killed — same rule as AcpAgentConnection, no leak behind a dead channel).
   */
  static async start(
    command: string,
    args: string[],
    opts: {
      cwd: string;
      env?: NodeJS.ProcessEnv | undefined;
      /** `~/.pi/agent/sessions` — the replay + id-resolution source. */
      sessionsDir: string;
      onSpawned?: (pgid: number) => void;
      probeTimeoutMs?: number;
    },
  ): Promise<PiStartResult> {
    let proc: ChildProcess;
    try {
      proc = spawn(command, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true, // #33 — no console window per child on Windows
        // #35 — process groups are POSIX-only (see agent-connection.ts);
        // attached on win32 so the tree inherits the daemon's console.
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      throw new Error(`failed to spawn pi '${command}': ${errText(e)}`);
    }
    const conn = new PiRpcConnection(proc, opts.sessionsDir);
    proc.on('error', (e) => {
      conn.failAll(new Error(`pi '${command}' failed: ${errText(e)}`));
    });
    if (opts.onSpawned !== undefined && proc.pid !== undefined) {
      try {
        opts.onSpawned(proc.pid);
      } catch (e) {
        conn.kill();
        throw new Error(`failed to ledger pi '${command}': ${errText(e)}`);
      }
    }
    try {
      await conn.piCommand('get_state', {}, opts.probeTimeoutMs ?? 20000);
    } catch (e) {
      conn.kill();
      throw e;
    }
    return {
      conn,
      agentInfo: { name: 'pi' },
      // The façade itself implements load-with-replay (file parse + synthetic
      // updates), so it advertises exactly that — chat.ts's deriveSessionCaps
      // equivalent, decided here instead of parsed from a handshake.
      sessionCaps: { load: true, resume: false, list: false },
      promptCaps: { image: true },
    };
  }

  // ---- the ACP façade (what chat.ts calls) ----

  async request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    if (this.exited || this.proc.stdin === null) {
      throw new Error('pi process is not running');
    }
    const p = (params ?? {}) as UnknownRecord;
    switch (method) {
      case 'session/new':
        return await this.establishNew(timeoutMs);
      case 'session/load':
        return await this.establishLoad(pickString(p['sessionId']) ?? '', timeoutMs);
      case 'session/prompt':
        return await this.sendPrompt(p, timeoutMs);
      case 'session/cancel': {
        this.abortRequested = true;
        // The turn stops asynchronously; agent_settled then settles the held
        // prompt with stopReason 'cancelled'. This ack mirrors pi's abort
        // (responds once idle) — callers fire-and-forget it.
        return await this.piCommand('abort', {}, Math.min(timeoutMs, 120000));
      }
      case 'session/set_config_option': {
        const optionId = pickString(p['optionId']);
        const value = p['value'];
        if (optionId === 'model') {
          return await this.piCommand('set_model', { model: value }, Math.min(timeoutMs, 20000));
        }
        if (optionId === 'thought_level') {
          return await this.piCommand(
            'set_thinking_level',
            { level: value },
            Math.min(timeoutMs, 20000),
          );
        }
        return {};
      }
      case 'session/set_mode':
        // pi has no modes (modes: [] in every establishment response) — the
        // web never renders the selector, and this arm is unreachable.
        return {};
      case 'session/close': {
        // chat.ts kills the group right after; a best-effort idle stop is
        // enough (never await a turn mid-flight here).
        void this.piCommand('abort', {}, 2000).catch(() => {});
        return {};
      }
      default:
        throw new Error(`pi façade does not implement '${method}'`);
    }
  }

  /** pi has no agent→client requests — the responders are inert no-ops. */
  respondPermission(_jsonrpcId: JsonRpcId, _outcome: PermissionOutcome): void {
    /* pi has no permission surface */
  }

  respondElicitation(
    _jsonrpcId: JsonRpcId,
    _response:
      | { action: 'accept'; content: Record<string, unknown> }
      | { action: 'decline' }
      | { action: 'cancel' },
  ): void {
    /* pi has no elicitation surface */
  }

  setNotificationHandler(handler: (method: string, params: Record<string, unknown>) => void): void {
    this.onNotification = handler;
  }

  setPermissionHandler(
    _handler: (jsonrpcId: JsonRpcId, params: Record<string, unknown>) => void,
  ): void {
    /* pi has no permission surface */
  }

  setElicitationHandler(
    _handler: (jsonrpcId: JsonRpcId, params: Record<string, unknown>) => void,
  ): void {
    /* pi has no elicitation surface */
  }

  onExit(handler: () => void): void {
    this.proc.on('exit', handler);
  }

  isGroupAlive(): boolean {
    return this.pgid !== null && groupIsAlive(this.pgid);
  }

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
    this.proc.kill('SIGTERM');
    this.failAll(new Error('pi process killed'));
    if (this.heldPrompt !== null && !this.heldPrompt.settled) {
      clearTimeout(this.heldPrompt.timer);
      this.heldPrompt.settled = true;
      this.heldPrompt.reject(new Error('pi process killed'));
      this.heldPrompt = null;
    }
    this.exited = true;
  }

  // ---- establishment arms ----

  private async establishNew(timeoutMs: number): Promise<UnknownRecord> {
    // pi created a session at spawn; adopt it. The id rides the stats/state
    // payloads (field name verified on the rig; multi-key read is the
    // pre-verification cushion).
    const [stats, config] = await Promise.all([
      this.piCommand('get_session_stats', {}, Math.min(timeoutMs, 15000)).catch(() => null),
      this.configSnapshot(),
    ]);
    const sessionId = this.adoptSessionId(stats);
    this.sessionId = sessionId;
    // The slash-command catalog (W15 palette) — pushed like any adapter.
    void this.piCommand('get_commands', {}, 15000)
      .then((res) => {
        const commands = takePiCommands(res['commands']);
        if (commands !== null && this.onNotification !== null) {
          this.onNotification('session/update', {
            sessionId: this.sessionId ?? '',
            update: { sessionUpdate: 'available_commands_update', availableCommands: commands },
          });
        }
      })
      .catch(() => {});
    return {
      sessionId,
      modes: [],
      configOptions: config,
      loadSession: true,
      promptCapabilities: { image: true },
    };
  }

  private async establishLoad(sessionId: string, timeoutMs: number): Promise<UnknownRecord> {
    if (sessionId === '') throw new Error('pi session/load requires a sessionId');
    // rig-found (pi 0.85.1): switch_session takes `sessionPath` — the session
    // FILE's absolute path, not an id (docs "RPC mode"; an id-shaped param
    // dies with "Cannot read properties of undefined (reading 'startsWith')").
    // Resolve id → path ourselves, exactly like the rail's file scan.
    const file = piFindSessionFile(this.sessionsDir, piConnFs, sessionId);
    if (file === null) {
      throw new Error(`pi session '${sessionId}' not found under the sessions store`);
    }
    const switched = await this.piCommand(
      'switch_session',
      { sessionPath: file },
      Math.min(timeoutMs, 20000),
    );
    if (switched['cancelled'] === true) {
      throw new Error('pi extension cancelled the session switch');
    }
    this.sessionId = sessionId;
    // Replay history from the transcript file (pi switch_session does NOT
    // replay): emit BEFORE resolving — the daemon's wireCapture path folds
    // these exactly like claude's native replay. Best-effort by design.
    if (file !== null) {
      try {
        for (const update of piSessionReplay(readFileSync(file, 'utf8'))) {
          this.emitReplayUpdate(update);
        }
      } catch {
        // unreadable transcript — resume without history, not a failed channel
      }
    }
    const [stats, config] = await Promise.all([
      this.piCommand('get_session_stats', {}, Math.min(timeoutMs, 15000)).catch(() => null),
      this.configSnapshot(),
    ]);
    return { sessionId: this.adoptSessionId(stats) ?? sessionId, modes: [], configOptions: config };
  }

  /** Pick the session id out of a stats payload (multi-key, rig-pending). */
  private adoptSessionId(stats: UnknownRecord | null): string {
    if (stats !== null) {
      const direct = pickString(stats['sessionId']) ?? pickString(stats['session_id']);
      if (direct !== null) return direct;
      const nested = stats['session'] as UnknownRecord | undefined;
      const nestedId =
        typeof nested === 'object' && nested !== null
          ? (pickString(nested['id']) ?? pickString(nested['sessionId']))
          : null;
      if (nestedId !== null) return nestedId;
      const file = pickString(stats['sessionFile']) ?? pickString(stats['session_file']);
      if (file !== null) {
        const base = file.split('/').pop() ?? '';
        const id = base.replace(/\.jsonl$/, '');
        const cut = id.indexOf('_');
        if (cut !== -1) return id.slice(cut + 1);
        return id;
      }
    }
    return '';
  }

  /** The session-config snapshot (model + thinking-level select rows). */
  private async configSnapshot(): Promise<UnknownRecord[]> {
    const rows: UnknownRecord[] = [];
    const [modelsRes, levelsRes, stateRes] = await Promise.allSettled([
      this.piCommand('get_available_models', {}, 10000),
      this.piCommand('get_available_thinking_levels', {}, 10000),
      this.piCommand('get_state', {}, 10000),
    ]);
    if (modelsRes.status === 'fulfilled') {
      const list = modelsRes.value['models'] ?? modelsRes.value['available'] ?? modelsRes.value;
      if (Array.isArray(list)) {
        const options: UnknownRecord[] = [];
        for (const m of list) {
          const opt = piModelOption(m);
          if (opt === null) continue;
          options.push({ value: opt.value, ...(opt.name !== opt.value ? { name: opt.name } : {}) });
        }
        if (options.length > 0) {
          rows.push({
            id: 'model',
            name: 'Model',
            category: 'model',
            options,
            ...(this.currentStateModel(stateRes) !== null
              ? { currentValue: this.currentStateModel(stateRes) }
              : {}),
          });
        }
      }
    }
    if (levelsRes.status === 'fulfilled') {
      const raw = levelsRes.value['levels'] ?? levelsRes.value['available'];
      if (Array.isArray(raw)) {
        const options: UnknownRecord[] = [];
        for (const v of raw) {
          if (typeof v === 'string' && v.length > 0) options.push({ value: v });
        }
        if (options.length > 0) {
          const level = this.currentStateThinkingLevel(stateRes);
          rows.push({
            id: 'thought_level',
            name: 'Thinking',
            category: 'thought_level',
            options,
            ...(level !== null ? { currentValue: level } : {}),
          });
        }
      }
    }
    return rows;
  }

  private currentStateModel(stateRes: PromiseSettledResult<UnknownRecord>): string | null {
    if (stateRes.status !== 'fulfilled') return null;
    const state = (stateRes.value['state'] ?? stateRes.value) as UnknownRecord;
    return piModelRef(state['model']);
  }

  private currentStateThinkingLevel(stateRes: PromiseSettledResult<UnknownRecord>): string | null {
    if (stateRes.status !== 'fulfilled') return null;
    const state = (stateRes.value['state'] ?? stateRes.value) as UnknownRecord;
    return pickString(state['thinkingLevel']);
  }

  // ---- prompt (the held-response turn) ----

  private async sendPrompt(p: UnknownRecord, timeoutMs: number): Promise<unknown> {
    if (this.heldPrompt !== null && !this.heldPrompt.settled) {
      throw new Error('pi turn already in flight');
    }
    const { message, images } = flattenPiPrompt(p['prompt']);
    this.abortRequested = false;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.heldPrompt !== null) this.heldPrompt.settled = true;
        this.heldPrompt = null;
        reject(new Error(`pi turn did not settle within ${timeoutMs}ms`));
      }, timeoutMs);
      this.heldPrompt = { settled: false, timer, resolve, reject };
      this.piCommand('prompt', { message, ...(images.length > 0 ? { images } : {}) }, 15000).catch(
        (e: Error) => {
          // pi NACKed the prompt (validation/auth failure) — a TURN error, the
          // process stays alive.
          if (this.heldPrompt !== null && !this.heldPrompt.settled) {
            clearTimeout(this.heldPrompt.timer);
            this.heldPrompt.settled = true;
            this.heldPrompt.reject(e);
            this.heldPrompt = null;
          }
        },
      );
    });
  }

  private settleHeld(stopReason: string): void {
    if (this.heldPrompt === null || this.heldPrompt.settled) return;
    clearTimeout(this.heldPrompt.timer);
    this.heldPrompt.settled = true;
    const resolve = this.heldPrompt.resolve;
    this.heldPrompt = null;
    resolve({ stopReason });
  }

  // ---- wire plumbing ----

  private emitReplayUpdate(update: PiReplayUpdate): void {
    this.onNotification?.('session/update', {
      sessionId: this.sessionId ?? '',
      update,
    });
  }

  /** Raw pi command with id correlation + timeout. */
  private piCommand(
    type: string,
    params: UnknownRecord,
    timeoutMs: number,
  ): Promise<UnknownRecord> {
    if (this.exited || this.proc.stdin === null) {
      return Promise.reject(new Error('pi process is not running'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi command '${type}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve,
        reject,
        timer: timer as unknown as NodeJS.Timeout,
      });
      this.send({ type, id, ...params });
    });
  }

  private handleLine(line: string): void {
    let msg: UnknownRecord;
    try {
      msg = JSON.parse(line) as UnknownRecord;
    } catch {
      return; // startup banners / log noise on stdout — skip non-JSON lines
    }
    const id = typeof msg['id'] === 'number' || typeof msg['id'] === 'string' ? msg['id'] : null;
    if (id !== null) {
      const key = typeof id === 'number' ? id : Number(id);
      const pending = this.pending.get(key);
      if (pending !== undefined) {
        this.pending.delete(key);
        clearTimeout(pending.timer);
        if (msg['success'] === false) {
          const error = msg['error'];
          const text =
            typeof error === 'string'
              ? error
              : (pickString((error as UnknownRecord | undefined)?.['message']) ??
                `pi command failed: ${JSON.stringify(error)}`);
          pending.reject(new Error(text));
        } else {
          // rig-verified (pi 0.85.1): responses are {id, type:'response',
          // command, success, data} — the payload lives under `data` (absent
          // on bare acks like prompt/abort).
          const data = msg['data'];
          pending.resolve(
            data !== null && typeof data === 'object' && !Array.isArray(data)
              ? (data as UnknownRecord)
              : msg,
          );
        }
        return;
      }
    }
    // Everything else is an EVENT (or an ack we no longer hold) — map it.
    if (msg['type'] === 'agent_settled') {
      this.settleHeld(this.abortRequested ? 'cancelled' : 'end_turn');
      return;
    }
    const update = piEventToAcpUpdate(msg);
    if (update !== null) {
      this.onNotification?.('session/update', {
        sessionId: this.sessionId ?? '',
        update,
      });
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

/** pi's get_commands payload → the W15 catalog rows (name + description). */
function takePiCommands(raw: unknown): UnknownRecord[] | null {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as UnknownRecord | undefined)?.['commands'])
      ? ((raw as UnknownRecord)['commands'] as unknown[])
      : null;
  if (list === null) return null;
  const out: UnknownRecord[] = [];
  for (const row of list) {
    if (typeof row === 'string') {
      if (row.length > 0) out.push({ name: row });
      continue;
    }
    const r = (row ?? {}) as UnknownRecord;
    const name = pickString(r['name']) ?? pickString(r['command']);
    if (name === null) continue;
    out.push({
      name,
      ...(pickString(r['description']) !== null ? { description: r['description'] } : {}),
    });
  }
  return out;
}

const piConnFs = {
  readdir: (p: string) => readdirSync(p),
  readFile: (p: string) => readFileSync(p),
};

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
