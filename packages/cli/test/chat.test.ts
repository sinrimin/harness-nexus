import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachChatHandlers, mapAcpUpdate } from '../src/daemon/chat.js';
import { AcpAgentConnection, deriveSessionCaps } from '../src/daemon/acp/agent-connection.js';
import { resolveAcpCommand } from '../src/daemon/acp/adapters.js';
import { readAdapterLedger } from '../src/daemon/adapter-ledger.js';
import type { ChatStreamEvent } from '@harness-nexus/shared';

/**
 * Chat session manager tests (Phase 8 C5): the pure ACP→semantic mapping, the
 * adapter command table, and a full round-trip against the fixture ACP agent
 * (test/fixtures/acp-agent.mjs) through a fake socket — the same path the
 * daemon takes in production.
 */

const FIXTURE = new URL('./fixtures/acp-agent.mjs', import.meta.url).pathname;

/** W11 A — spawned adapters are ledgered under <homeDir>/.hnx; never the real home. */
const LEDGER_HOME = mkdtempSync(join(tmpdir(), 'hnx-chat-ledger-'));

/** Minimal socket.io-client stand-in: records emits, lets tests deliver. */
class FakeSocket {
  emitted: { event: string; payload: unknown; ack?: (res: unknown) => void }[] = [];
  handlers = new Map<string, (payload: unknown, ack?: (res: unknown) => void) => void>();
  disconnected = false;

  emit(event: string, payload: unknown, ack?: (res: unknown) => void): boolean {
    if (ack !== undefined) this.emitted.push({ event, payload, ack });
    else this.emitted.push({ event, payload });
    return true;
  }

  on(event: string, handler: (payload: unknown, ack?: (res: unknown) => void) => void): this {
    this.handlers.set(event, handler);
    return this;
  }

  /** Test-side: deliver a server→daemon event. */
  receive(event: string, payload: unknown, ack?: (res: unknown) => void): void {
    this.handlers.get(event)?.(payload, ack);
  }

  eventsOf(kind: string): { payload: unknown }[] {
    return this.emitted.filter((e) => e.event === kind);
  }

  chatEvents(): ChatStreamEvent[] {
    return this.emitted
      .filter((e) => e.event === 'chat:event')
      .map((e) => (e.payload as { event: ChatStreamEvent }).event);
  }
}

describe('mapAcpUpdate', () => {
  // The daemon maps `session/update` params: { sessionId, update }.
  const map = (update: Record<string, unknown>): ChatStreamEvent | null => mapAcpUpdate({ update });

  it('maps message/thought chunks and tool calls', () => {
    expect(
      map({
        sessionUpdate: 'agent_message_chunk',
        contentBlock: { type: 'text', text: 'hello' },
      }),
    ).toEqual({ kind: 'message_delta', delta: 'hello' });
    expect(
      map({
        sessionUpdate: 'agent_thought_chunk',
        contentBlock: { type: 'text', text: 'hm' },
      }),
    ).toEqual({ kind: 'thought_delta', delta: 'hm' });
    expect(
      map({
        sessionUpdate: 'tool_call_update',
        toolCallUpdate: { toolCallId: 't1', kind: 'edit', status: 'completed' },
      }),
    ).toEqual({ kind: 'tool_call', call: { toolCallId: 't1', kind: 'edit', status: 'completed' } });
  });

  it('drops live user echo and wraps unknown updates as raw', () => {
    expect(
      map({ sessionUpdate: 'user_message_chunk', contentBlock: { type: 'text', text: 'x' } }),
    ).toBeNull();
    const raw = map({ sessionUpdate: 'plan', plan: [] });
    expect(raw).toEqual({
      kind: 'raw',
      method: 'session/update',
      params: { sessionUpdate: 'plan', plan: [] },
    });
  });

  it('maps plan snapshots (9 W14): clamp, malformed-row drop, empty clears, draft shape stays raw', () => {
    expect(
      map({
        sessionUpdate: 'plan',
        entries: [
          { content: 'Step one', status: 'pending', priority: 'high' },
          { content: 'Working…', status: 'in_progress' },
        ],
      }),
    ).toEqual({
      kind: 'plan',
      entries: [
        { content: 'Step one', status: 'pending', priority: 'high' },
        { content: 'Working…', status: 'in_progress' },
      ],
    });
    // Over-long content is CLAMPED (dropping the row would misrepresent the plan).
    expect(
      map({
        sessionUpdate: 'plan',
        entries: [{ content: 'x'.repeat(900), status: 'pending' }],
      }),
    ).toEqual({ kind: 'plan', entries: [{ content: 'x'.repeat(512), status: 'pending' }] });
    // Malformed rows skip; a legal empty snapshot passes (plan cleared).
    expect(
      map({ sessionUpdate: 'plan', entries: [{ content: 'ok', status: 'nope' }, null, 42] }),
    ).toEqual({ kind: 'plan', entries: [] });
    expect(map({ sessionUpdate: 'plan', entries: [] })).toEqual({ kind: 'plan', entries: [] });
    // The pre-1.0 draft shape (plan.steps) keeps the raw fallback.
    expect(map({ sessionUpdate: 'plan', plan: { steps: [] } })).toMatchObject({ kind: 'raw' });
    expect(map({ sessionUpdate: 'plan' })).toMatchObject({ kind: 'raw' });
  });

  it('maps available_commands_update catalogs (9 W15): verbatim names, hint, clamp, drop', () => {
    expect(
      map({
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'review', description: 'Review my changes', input: { hint: 'focus areas' } },
          { name: 'mcp:deploy', description: 'Deploy via MCP' },
        ],
      }),
    ).toEqual({
      kind: 'commands',
      commands: [
        { name: 'review', description: 'Review my changes', hint: 'focus areas' },
        { name: 'mcp:deploy', description: 'Deploy via MCP' },
      ],
    });
    // Description clamps, malformed rows skip, empty catalog passes as cleared.
    expect(
      map({
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'x', description: 'd'.repeat(900) },
          null,
          { description: 'y' },
        ],
      }),
    ).toEqual({ kind: 'commands', commands: [{ name: 'x', description: 'd'.repeat(512) }] });
    expect(map({ sessionUpdate: 'available_commands_update', availableCommands: [] })).toEqual({
      kind: 'commands',
      commands: [],
    });
    expect(map({ sessionUpdate: 'available_commands_update', availableCommands: 'nope' })).toEqual({
      kind: 'commands',
      commands: [],
    });
  });

  it('maps usage defensively', () => {
    expect(
      map({ sessionUpdate: 'usage_update', usage: { inputTokens: 3, outputTokens: 4 } }),
    ).toEqual({ kind: 'usage', inputTokens: 3, outputTokens: 4 });
    expect(map({ sessionUpdate: 'usage_update' })).toEqual({ kind: 'usage' });
    // #39 — cache fields ride the dialect pick (usage.ts owns the spellings).
    expect(
      map({
        sessionUpdate: 'usage_update',
        usage: {
          inputTokens: 3,
          outputTokens: 4,
          cacheCreationInputTokens: 50,
          cacheReadInputTokens: 600,
        },
      }),
    ).toEqual({
      kind: 'usage',
      inputTokens: 3,
      outputTokens: 4,
      cacheWriteTokens: 50,
      cacheReadTokens: 600,
    });
  });

  it('takeElicitationView reduces the claude AskUserQuestion shape (9 W14.1)', async () => {
    const { takeElicitationView } = await import('../src/daemon/chat.js');
    // The probe-captured claude dialect: oneOf consts + a custom free-text
    // property + required list.
    const view = takeElicitationView({
      mode: 'form',
      sessionId: 'fx-session',
      toolCallId: 'call_abc',
      message: 'Which color do you prefer?',
      requestedSchema: {
        type: 'object',
        required: ['question_0'],
        properties: {
          question_0: {
            type: 'string',
            title: 'Color',
            oneOf: [
              { const: 'Red', title: 'Red', description: 'The color red' },
              { const: 'Blue', title: 'Blue' },
            ],
          },
          question_0_custom: { type: 'string', title: 'Other', description: 'Your own answer' },
        },
      },
    });
    expect(view).toEqual({
      message: 'Which color do you prefer?',
      toolCallId: 'call_abc',
      fields: [
        {
          name: 'question_0',
          type: 'enum',
          title: 'Color',
          options: [
            { value: 'Red', label: 'Red', description: 'The color red' },
            { value: 'Blue', label: 'Blue' },
          ],
          required: true,
        },
        { name: 'question_0_custom', type: 'text', title: 'Other', description: 'Your own answer' },
      ],
    });
  });

  it('takeElicitationView covers the other field kinds and degrades safely (9 W14.1)', async () => {
    const { takeElicitationView } = await import('../src/daemon/chat.js');
    const view = takeElicitationView({
      message: 'Pick',
      requestedSchema: {
        type: 'object',
        properties: {
          plainEnum: { type: 'string', enum: ['a', 'b'] },
          multi: { type: 'array', items: { enum: ['x', 'y'] } },
          flag: { type: 'boolean', title: 'Verbose' },
          num: { type: 'number' },
          count: { type: 'integer' },
          nested: { type: 'object', properties: { deep: { type: 'string' } } },
          typeless: { title: 'Nothing renderable' },
          longTitle: { type: 'string', title: 't'.repeat(900) },
        },
      },
    });
    expect(view.message).toBe('Pick');
    expect(view.toolCallId).toBeUndefined();
    const byName = new Map(view.fields.map((f: { name: string }) => [f.name, f]));
    expect(byName.get('plainEnum')).toEqual({
      name: 'plainEnum',
      type: 'enum',
      options: [{ value: 'a' }, { value: 'b' }],
    });
    expect(byName.get('multi')).toEqual({
      name: 'multi',
      type: 'multi',
      options: [{ value: 'x' }, { value: 'y' }],
    });
    expect(byName.get('flag')).toEqual({ name: 'flag', type: 'boolean', title: 'Verbose' });
    expect(byName.get('num')).toEqual({ name: 'num', type: 'number' });
    expect(byName.get('count')).toEqual({ name: 'count', type: 'integer' });
    // Structurally unusable properties drop; long strings clamp.
    expect(byName.has('nested')).toBe(false);
    expect(byName.has('typeless')).toBe(false);
    expect((byName.get('longTitle') as { title?: string }).title).toBe('t'.repeat(256));
    // No schema at all → message-only card (empty fields is VALID).
    expect(takeElicitationView({ message: 'm' })).toEqual({ message: 'm', fields: [] });
    expect(takeElicitationView({ message: 'm'.repeat(3000) }).message).toBe('m'.repeat(2048));
  });

  it('speaks the dsh native dialect too (content object, flat tool_call, used/size)', () => {
    // dsh's ACP adapter: chunks carry `content` (not `contentBlock`)…
    expect(
      map({
        sessionUpdate: 'agent_message_chunk',
        messageId: 'm1',
        content: { type: 'text', text: '收到' },
      }),
    ).toEqual({ kind: 'message_delta', delta: '收到' });
    expect(
      map({
        sessionUpdate: 'agent_thought_chunk',
        messageId: 'm1',
        content: { type: 'text', text: 'hm' },
      }),
    ).toEqual({ kind: 'thought_delta', delta: 'hm' });
    // …tool calls spread the fields FLAT on the update (no toolCallUpdate)…
    expect(
      map({
        sessionUpdate: 'tool_call',
        toolCallId: 'dsh-1',
        title: 'bash(npm test)',
        kind: 'other',
        status: 'in_progress',
        rawInput: { command: 'npm test' },
      }),
    ).toEqual({
      kind: 'tool_call',
      call: {
        toolCallId: 'dsh-1',
        title: 'bash(npm test)',
        kind: 'other',
        status: 'in_progress',
        rawInput: { command: 'npm test' },
      },
    });
    expect(
      map({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'dsh-1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
      }),
    ).toEqual({
      kind: 'tool_call',
      call: {
        toolCallId: 'dsh-1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
      },
    });
    // …and usage reports context occupancy (`used` of `size`).
    expect(map({ sessionUpdate: 'usage_update', used: 8469, size: 262144 })).toEqual({
      kind: 'usage',
      contextUsed: 8469,
      contextSize: 262144,
    });
  });
});

describe('deriveSessionCaps (resume dialect per adapter family)', () => {
  it('zed shape: sessionCapabilities caps + the ROOT legacy loadSession flag', () => {
    expect(
      deriveSessionCaps({
        loadSession: true,
        agentCapabilities: { sessionCapabilities: { load: {}, resume: {}, list: {} } },
      }),
    ).toEqual({ load: true, resume: true, list: true });
  });

  it('official @agentclientprotocol shape: loadSession NESTED in agentCapabilities, caps say resume but NOT load', () => {
    // Reading only the root flag made this wrapper look resume-only —
    // claude-code channels then resumed with NO replay (empty history pane).
    expect(
      deriveSessionCaps({
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: { resume: {}, list: {}, close: {} },
        },
      }),
    ).toEqual({ load: true, resume: true, list: true });
  });

  it('dsh shape: resume only — a native resume without replay', () => {
    expect(
      deriveSessionCaps({ agentCapabilities: { sessionCapabilities: { resume: {} } } }),
    ).toEqual({ load: false, resume: true, list: false });
  });

  it('no caps at all: nothing offered', () => {
    expect(deriveSessionCaps({})).toEqual({ load: false, resume: false, list: false });
    expect(deriveSessionCaps(undefined)).toEqual({ load: false, resume: false, list: false });
  });
});

describe('toolCallView enrichment (9 W6)', () => {
  const map = (update: Record<string, unknown>): ChatStreamEvent | null => mapAcpUpdate({ update });

  it('carries toolName from the Claude _meta envelope', () => {
    const ev = mapAcpUpdate({
      update: {
        sessionUpdate: 'tool_call',
        toolCallUpdate: { toolCallId: 't1', title: 'src/app.ts', status: 'in_progress' },
      },
      _meta: { claudeCode: { toolName: 'Edit' } },
    });
    expect(ev).toEqual({
      kind: 'tool_call',
      call: {
        toolCallId: 't1',
        title: 'src/app.ts',
        toolName: 'Edit',
        status: 'in_progress',
      },
    });
  });

  it('normalizes readTool-style kinds and filters unknown statuses', () => {
    const ev = map({
      sessionUpdate: 'tool_call_update',
      toolCallUpdate: {
        toolCallId: 't2',
        kind: 'executeTool',
        status: 'weird-status',
        rawOutput: 'done',
      },
    });
    expect(ev).toEqual({
      kind: 'tool_call',
      call: { toolCallId: 't2', kind: 'execute', output: 'done' },
    });
  });

  it('passes structured diff content through', () => {
    const ev = map({
      sessionUpdate: 'tool_call',
      toolCallUpdate: {
        toolCallId: 't3',
        content: [{ type: 'diff', path: 'a.ts', oldText: 'x', newText: 'y' }],
      },
    });
    expect(ev).toMatchObject({
      kind: 'tool_call',
      call: {
        toolCallId: 't3',
        content: [{ type: 'diff', path: 'a.ts', oldText: 'x', newText: 'y' }],
      },
    });
  });

  it('drops oversized rawInput (Write-style payloads) but keeps the rest', () => {
    const ev = map({
      sessionUpdate: 'tool_call',
      toolCallUpdate: {
        toolCallId: 't4',
        toolName: 'Write',
        rawInput: { content: 'x'.repeat(40 * 1024) },
      },
    });
    expect(ev).toEqual({ kind: 'tool_call', call: { toolCallId: 't4', toolName: 'Write' } });
  });

  it('keeps bounded rawInput and truncates oversized output', () => {
    const ok = map({
      sessionUpdate: 'tool_call',
      toolCallUpdate: {
        toolCallId: 't5',
        rawInput: { file_path: '/tmp/a.ts' },
        rawOutput: 'y'.repeat(100010),
      },
    });
    expect(ok).toMatchObject({
      kind: 'tool_call',
      call: {
        toolCallId: 't5',
        rawInput: { file_path: '/tmp/a.ts' },
        output: 'y'.repeat(100000),
      },
    });
  });
});

describe('resolveAcpCommand', () => {
  it('defaults per target and honors env overrides', () => {
    expect(resolveAcpCommand('hermes', {})).toEqual({
      command: 'python3',
      args: ['-m', 'acp_adapter'],
    });
    // The official ACP-project wrapper (thinking streams on gateway models —
    // the pre-2026-09 @zed-industries 0.23.x never requested it). 9 W14.1 —
    // the claude row additionally carries the todo-tool opt-in env. Issue #2
    // — the spec is VERSION-PINNED and an empty tmp home forces the npx
    // fallback (a provisioned machine would resolve the pinned bin).
    expect(
      resolveAcpCommand('claude-code', {}, { homeDir: mkdtempSync(join(tmpdir(), 'hnx-home-')) }),
    ).toEqual({
      command: 'npx',
      args: ['-y', '@agentclientprotocol/claude-agent-acp@0.79.0'],
      env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' },
    });
    // 9 W12 — opencode speaks ACP NATIVELY (`opencode acp`).
    expect(resolveAcpCommand('opencode', {})).toEqual({
      command: 'opencode',
      args: ['acp'],
    });
    expect(resolveAcpCommand('zcode', {})).toBeNull();
    expect(
      resolveAcpCommand('claude-code', {
        HN_ACP_COMMAND_CLAUDE_CODE: 'node /tmp/adapter.js --flag',
      }),
    ).toEqual({
      command: 'node',
      args: ['/tmp/adapter.js', '--flag'],
      // env keys off the TARGET, so a pinned wrapper still gets the opt-in.
      env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' },
    });
    expect(resolveAcpCommand('hermes', { HN_ACP_COMMAND_HERMES: `node ${FIXTURE}` })).toEqual({
      command: 'node',
      args: [FIXTURE],
    });
  });
});

describe('session round-trip vs the fixture agent', () => {
  const timers: NodeJS.Timeout[] = [];
  afterEach(() => {
    for (const t of timers) clearTimeout(t);
    timers.length = 0;
  });

  function waitFor<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = (): void => {
        const v = fn();
        if (v !== undefined) return resolve(v);
        if (Date.now() - started > ms) return reject(new Error('waitFor: timeout'));
        setTimeout(tick, 20);
      };
      tick();
    });
  }

  it('start → ready → prompt → echo turn → permission turn → close', async () => {
    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_HERMES: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
      homeDir: LEDGER_HOME,
    });

    socket.receive('chat:session.start', {
      sessionId: 'sess-1',
      agentInstanceId: 'ag-1',
      target: 'hermes',
      cwd: '/tmp',
    });

    const ready = await waitFor(
      () =>
        socket.emitted.find((e) => e.event === 'chat:session.ready')?.payload as
          { agentName?: string; error?: string } | undefined,
    );
    expect(ready.error).toBeUndefined();
    expect(ready.agentName).toBe('fixture-agent');

    // Plain echo turn.
    const promptAck = vi.fn();
    socket.receive(
      'chat:message.send',
      { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'hi' }] },
      promptAck,
    );
    expect(promptAck).toHaveBeenCalledWith({ accepted: true });
    const turn1 = await waitFor(() => socket.chatEvents().find((e) => e.kind === 'turn_result'));
    expect(turn1).toEqual({ kind: 'turn_result', stopReason: 'end_turn' });
    const deltas = socket.chatEvents().filter((e) => e.kind === 'message_delta');
    expect(deltas).toContainEqual({ kind: 'message_delta', delta: 'echo: hi' });
    expect(socket.chatEvents()).toContainEqual({ kind: 'session_status', state: 'idle' });

    // Permission turn: request surfaced, respond allow, verbatim optionId back.
    socket.receive('chat:message.send', {
      sessionId: 'sess-1',
      prompt: [{ type: 'text', text: 'please ask-permission now' }],
    });
    const perm = await waitFor(() =>
      socket.chatEvents().find((e) => e.kind === 'permission_request'),
    );
    if (perm.kind !== 'permission_request') throw new Error('not a permission event');
    expect(perm.options.map((o) => o.optionId)).toEqual(['allow_always', 'reject_once']);
    const respondAck = vi.fn();
    socket.receive(
      'chat:permission.respond',
      { sessionId: 'sess-1', requestId: perm.requestId, optionId: 'allow_always' },
      respondAck,
    );
    expect(respondAck).toHaveBeenCalledWith({ accepted: true });
    await waitFor(() =>
      socket
        .chatEvents()
        .find((e) => e.kind === 'message_delta' && e.delta === 'permission granted: allow_always'),
    );

    // Close tears down (best-effort session/close + kill + closed event).
    const closeAck = vi.fn();
    socket.receive('chat:session.close', { sessionId: 'sess-1', reason: 'user' }, closeAck);
    expect(closeAck).toHaveBeenCalledWith({ closed: true });
    await waitFor(() => (socket.eventsOf('chat:session.closed').length > 0 ? true : undefined));
    expect((socket.eventsOf('chat:session.closed')[0]!.payload as { reason: string }).reason).toBe(
      'user',
    );

    // A prompt for a closed session is unknown.
    const lateAck = vi.fn();
    socket.receive(
      'chat:message.send',
      { sessionId: 'sess-1', prompt: [{ type: 'text', text: 'x' }] },
      lateAck,
    );
    expect(lateAck).toHaveBeenCalledWith({ error: 'unknown-session' });
  }, 15000);

  it('an answered permission rides the ring as RESOLVED; turn.cancel settles pending cards (#7)', async () => {
    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_HERMES: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
      homeDir: LEDGER_HOME,
    });

    socket.receive('chat:session.start', {
      sessionId: 'sess-perm',
      agentInstanceId: 'ag-1',
      target: 'hermes',
      cwd: '/tmp',
    });
    await waitFor(
      () =>
        socket.emitted.find((e) => e.event === 'chat:session.ready')?.payload as
          { error?: string } | undefined,
    );

    // Answer a permission, let the turn finish…
    socket.receive('chat:message.send', {
      sessionId: 'sess-perm',
      prompt: [{ type: 'text', text: 'please ask-permission now' }],
    });
    const perm = await waitFor(() =>
      socket.chatEvents().find((e) => e.kind === 'permission_request'),
    );
    if (perm.kind !== 'permission_request') throw new Error('not a permission event');
    socket.receive('chat:permission.respond', {
      sessionId: 'sess-perm',
      requestId: perm.requestId,
      optionId: 'allow_always',
    });
    await waitFor(() =>
      socket
        .chatEvents()
        .find((e) => e.kind === 'message_delta' && e.delta === 'permission granted: allow_always'),
    );

    // …then a resync (session switch back) must replay BOTH halves — the
    // request AND its resolution. Before #7 the ring only held the request,
    // so every rejoin re-showed the answered card as unsettled.
    socket.receive('chat:session.resync', { sessionId: 'sess-perm' });
    const history = await waitFor(
      () =>
        socket.emitted.find((e) => e.event === 'chat:history')?.payload as
          { items: { type: string; event?: { kind: string; requestId?: string } }[] } | undefined,
    );
    const ringKinds = history.items
      .filter((i) => i.type === 'event' && i.event?.requestId === perm.requestId)
      .map((i) => i.event?.kind);
    expect(ringKinds).toContain('permission_request');
    expect(ringKinds).toContain('permission_resolved');

    // A NEW pending permission must settle immediately on turn.cancel — not
    // linger for the 75s backstop ("cannot stop while a permission is up").
    socket.receive('chat:message.send', {
      sessionId: 'sess-perm',
      prompt: [{ type: 'text', text: 'please ask-permission now' }],
    });
    const perm2 = await waitFor(() =>
      socket
        .chatEvents()
        .find((e) => e.kind === 'permission_request' && e.requestId !== perm.requestId),
    );
    if (perm2.kind !== 'permission_request') throw new Error('not a permission event');
    socket.receive('chat:turn.cancel', { sessionId: 'sess-perm' });
    await waitFor(() =>
      socket
        .chatEvents()
        .find((e) => e.kind === 'permission_resolved' && e.requestId === perm2.requestId),
    );
    // The cancel-settled request is gone from the pending map.
    const staleAck = vi.fn();
    socket.receive(
      'chat:permission.respond',
      { sessionId: 'sess-perm', requestId: perm2.requestId, optionId: 'reject_once' },
      staleAck,
    );
    expect(staleAck).toHaveBeenCalledWith({ error: 'unknown-permission' });

    socket.receive('chat:session.close', { sessionId: 'sess-perm', reason: 'user' });
  }, 15000);

  it('prewarm → start ADOPTS the pooled adapter, re-arms, and tears down on disconnect (issue #3)', async () => {
    const socket = new FakeSocket();
    const handle = attachChatHandlers(socket as never, {
      env: {
        HN_ACP_COMMAND_CODEX: `node ${FIXTURE}`,
        PATH: process.env.PATH ?? '',
      },
      homeDir: LEDGER_HOME,
    });

    // Unsupported target → declined without spawning.
    const badAck = vi.fn();
    socket.receive('chat:adapter.prewarm', { target: 'hermes' }, badAck);
    expect(badAck).toHaveBeenCalledWith({ accepted: false });

    // Supported target → pooled spawn ledgered under the pseudo id, ready
    // (initialized) shortly after.
    const ack = vi.fn();
    socket.receive('chat:adapter.prewarm', { target: 'codex' }, ack);
    expect(ack).toHaveBeenCalledWith({ accepted: true });
    await waitFor(() => (handle.prewarmReady('codex') ? true : undefined));
    const prewarmed = readAdapterLedger(LEDGER_HOME).find(
      (e) => e.wireSessionId === 'prewarm-codex',
    );
    expect(prewarmed).toBeDefined();

    // The channel ADOPTS the pooled process — same pgid, pseudo file replaced
    // by the channel's own entry. No second spawn happened.
    socket.receive('chat:session.start', {
      sessionId: 'pw-1',
      agentInstanceId: 'ag-1',
      target: 'codex',
      cwd: '/tmp',
      prewarm: true,
    });
    const ready = await waitFor(
      () =>
        socket.emitted.find((e) => e.event === 'chat:session.ready')?.payload as
          { error?: string } | undefined,
    );
    expect(ready.error).toBeUndefined();
    const adopted = await waitFor(() =>
      readAdapterLedger(LEDGER_HOME).find((e) => e.wireSessionId === 'pw-1'),
    );
    expect(adopted.pgid).toBe(prewarmed!.pgid);
    // The adopted process's pseudo entry is gone (a re-armed entry with a NEW
    // pgid may already exist by now — the re-arm fires right after registration).
    expect(
      readAdapterLedger(LEDGER_HOME).find(
        (e) => e.wireSessionId === 'prewarm-codex' && e.pgid === prewarmed!.pgid,
      ),
    ).toBeUndefined();

    // prewarm:true on the start event → the pool re-armed with a FRESH process.
    await waitFor(() => (handle.prewarmReady('codex') ? true : undefined));
    const reArmed = readAdapterLedger(LEDGER_HOME).find(
      (e) => e.wireSessionId === 'prewarm-codex' && e.pgid !== prewarmed!.pgid,
    );
    expect(reArmed).toBeDefined();

    // A deliberate /ctl stop tears the channel AND the pooled adapter down.
    socket.receive('chat:session.close', { sessionId: 'pw-1', reason: 'user' });
    await waitFor(() => (socket.eventsOf('chat:session.closed').length > 0 ? true : undefined));
    socket.receive('disconnect', 'io client disconnect');
    await waitFor(() => (handle.prewarmReady('codex') ? undefined : true));
  }, 20000);

  it('claude dialect: response usage + cumulative cost feed the ledger (#44)', async () => {
    const socket = new FakeSocket();
    const handle = attachChatHandlers(socket as never, {
      env: {
        HN_ACP_COMMAND_CLAUDE_CODE: `node ${FIXTURE}`,
        PATH: process.env.PATH ?? '',
      },
      spawnEnv: { FIXTURE_RESPONSE_USAGE: '1' },
      homeDir: LEDGER_HOME,
    });
    socket.receive('chat:session.start', {
      sessionId: 'sess-cc',
      agentInstanceId: 'ag-1',
      target: 'claude-code',
      cwd: '/tmp',
    });
    const ready = await waitFor(
      () =>
        socket.emitted.find(
          (e) =>
            e.event === 'chat:session.ready' &&
            (e.payload as { sessionId?: string }).sessionId === 'sess-cc',
        )?.payload,
    );
    expect((ready as { error?: string }).error).toBeUndefined();

    // Two turns of the claude dialect: usage_update carries occupancy+cost
    // only; tokens ride the session/prompt RESPONSE as cumulative totals.
    for (const n of [1, 2]) {
      socket.receive('chat:message.send', {
        sessionId: 'sess-cc',
        prompt: [{ type: 'text', text: `turn ${String(n)}` }],
      });
      await waitFor(() => {
        const results = socket.chatEvents().filter((e) => e.kind === 'turn_result');
        return results.length >= n ? true : undefined;
      });
    }
    const turns = socket.chatEvents().filter((e) => e.kind === 'turn_result');
    // The response usage rides each turn_result (cumulative per the wrapper).
    expect(turns[0]).toMatchObject({
      kind: 'turn_result',
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 500, cacheWriteTokens: 50 },
    });
    expect(turns[1]).toMatchObject({
      kind: 'turn_result',
      usage: { inputTokens: 200, cacheReadTokens: 1000 },
    });
    // usage_update carried cost (cumulative), no tokens.
    const usages = socket.chatEvents().filter((e) => e.kind === 'usage');
    expect(
      usages.some((e) => 'costUsd' in (e as object) && !('inputTokens' in (e as object))),
    ).toBe(true);

    // Ledger: delta-accounted — 2 turns credit each per-turn amount once.
    const [row] = handle.usage.rows();
    expect(row).toMatchObject({
      target: 'claude-code',
      turns: 2,
      inputTokens: 200,
      outputTokens: 40,
      cacheReadTokens: 1000,
      cacheWriteTokens: 100,
    });
    expect(row.costUsd).toBeCloseTo(0.024, 9);
  }, 15000);

  it('sessionsSnapshot + usage ledger track the live channel and its tokens (#39)', async () => {
    const socket = new FakeSocket();
    const handle = attachChatHandlers(socket as never, {
      env: {
        HN_ACP_COMMAND_HERMES: `node ${FIXTURE}`,
        PATH: process.env.PATH ?? '',
      },
      spawnEnv: { FIXTURE_SESSION_CONFIG: '1' },
      homeDir: LEDGER_HOME,
    });
    socket.receive('chat:session.start', {
      sessionId: 'sess-tui',
      agentInstanceId: 'ag-1',
      target: 'hermes',
      cwd: '/tmp',
    });
    const ready = await waitFor(
      () =>
        socket.emitted.find(
          (e) =>
            e.event === 'chat:session.ready' &&
            (e.payload as { sessionId?: string }).sessionId === 'sess-tui',
        )?.payload,
    );
    expect((ready as { error?: string }).error).toBeUndefined();

    // Before any turn: the channel is there, model keyed off the config
    // snapshot's model-category select, no tokens yet.
    const idle = handle.sessionsSnapshot();
    expect(idle).toHaveLength(1);
    expect(idle[0]).toMatchObject({
      sessionId: 'sess-tui',
      target: 'hermes',
      model: 'fx-opus',
      busy: false,
      turns: 0,
      inputTokens: 0,
    });
    expect(handle.usage.rows()).toHaveLength(0);

    // One turn: the fixture's usage_update (11 in / 7 out, per-turn dialect)
    // lands in BOTH the session view and the per-model ledger.
    socket.receive('chat:message.send', {
      sessionId: 'sess-tui',
      prompt: [{ type: 'text', text: 'hello tui' }],
    });
    await waitFor(() =>
      socket.chatEvents().some((e) => e.kind === 'turn_result') ? true : undefined,
    );
    const busy = handle.sessionsSnapshot()[0]!;
    expect(busy.busy).toBe(false); // settled after turn_result
    expect(busy.turns).toBe(1);
    expect(busy.inputTokens).toBe(11);
    expect(busy.outputTokens).toBe(7);
    const [row] = handle.usage.rows();
    expect(row).toMatchObject({
      target: 'hermes',
      model: 'fx-opus',
      turns: 1,
      inputTokens: 11,
      outputTokens: 7,
      sessions: 1,
    });

    socket.receive('chat:session.close', { sessionId: 'sess-tui', reason: 'user' });
    await waitFor(() => (handle.sessionsSnapshot().length === 0 ? true : undefined));
    // The ledger survives the channel close — it is daemon-lifetime.
    expect(handle.usage.rows()).toHaveLength(1);
  }, 15000);

  it('a plan turn surfaces full-replace snapshots and the history ring replays them (9 W14)', async () => {
    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_HERMES: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
      homeDir: LEDGER_HOME,
    });
    socket.receive('chat:session.start', {
      sessionId: 'sess-plan',
      agentInstanceId: 'ag-1',
      target: 'hermes',
      cwd: '/tmp',
    });
    await waitFor(() => socket.emitted.find((e) => e.event === 'chat:session.ready'));

    socket.receive('chat:message.send', {
      sessionId: 'sess-plan',
      prompt: [{ type: 'text', text: 'show-plan please' }],
    });
    await waitFor(() => socket.chatEvents().find((e) => e.kind === 'turn_result'));
    const plans = socket.chatEvents().filter((e) => e.kind === 'plan');
    // Full-replace snapshots arrive verbatim; the LAST one is all-completed.
    expect(plans.length).toBeGreaterThanOrEqual(4);
    const last = plans[plans.length - 1]!;
    if (last.kind !== 'plan') throw new Error('not a plan event');
    expect(last.entries.map((e) => e.status)).toEqual(['completed', 'completed', 'completed']);
    expect(last.entries[0]).toEqual({
      content: 'Survey the workspace layout',
      status: 'completed',
      priority: 'high',
    });
    // The in_progress snapshot carried the activeForm-style text.
    const mid = plans[1]!;
    if (mid.kind !== 'plan') throw new Error('not a plan event');
    expect(mid.entries.some((e) => e.content === 'Implementing the panel…')).toBe(true);

    // Resync replays the ring — the plan events must ride chat:history too.
    socket.receive('chat:session.resync', { sessionId: 'sess-plan' });
    const history = await waitFor(
      () =>
        socket.emitted.find((e) => e.event === 'chat:history')?.payload as
          { items: { type: string; event?: { kind: string } }[] } | undefined,
    );
    expect(history.items.some((i) => i.type === 'event' && i.event?.kind === 'plan')).toBe(true);

    socket.receive('chat:session.close', { sessionId: 'sess-plan', reason: 'user' });
  }, 15000);

  it('a commands catalog pushed after establishment rides the stream and the ring (9 W15)', async () => {
    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_HERMES: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
      spawnEnv: { FIXTURE_COMMANDS: '1' },
      homeDir: LEDGER_HOME,
    });
    socket.receive('chat:session.start', {
      sessionId: 'sess-cmd',
      agentInstanceId: 'ag-1',
      target: 'hermes',
      cwd: '/tmp',
    });
    await waitFor(() => socket.emitted.find((e) => e.event === 'chat:session.ready'));
    const cmd = await waitFor(() => socket.chatEvents().find((e) => e.kind === 'commands'));
    if (cmd.kind !== 'commands') throw new Error('not a commands event');
    expect(cmd.commands).toEqual([
      { name: 'deploy', description: 'Deploy the current profile', hint: 'profile name' },
      { name: 'mcp:status', description: 'MCP server status' },
    ]);

    socket.receive('chat:message.send', {
      sessionId: 'sess-cmd',
      prompt: [{ type: 'text', text: '/deploy my-profile' }],
    });
    await waitFor(() => socket.chatEvents().find((e) => e.kind === 'turn_result'));
    // The slash prompt rides verbatim (the agent parses it)…
    const echoed = socket.chatEvents().find((e) => e.kind === 'message_delta');
    expect(echoed).toMatchObject({ delta: 'echo: /deploy my-profile' });
    // …and the catalog survives the resync ring replay.
    socket.receive('chat:session.resync', { sessionId: 'sess-cmd' });
    const history = await waitFor(
      () =>
        socket.emitted.find((e) => e.event === 'chat:history')?.payload as
          { items: { type: string; event?: { kind: string } }[] } | undefined,
    );
    expect(history.items.some((i) => i.type === 'event' && i.event?.kind === 'commands')).toBe(
      true,
    );
    socket.receive('chat:session.close', { sessionId: 'sess-cmd', reason: 'user' });
  }, 15000);

  it('an elicitation round trip surfaces the card and returns the values verbatim (9 W14.1)', async () => {
    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_HERMES: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
      homeDir: LEDGER_HOME,
    });
    socket.receive('chat:session.start', {
      sessionId: 'sess-eli',
      agentInstanceId: 'ag-1',
      target: 'hermes',
      cwd: '/tmp',
    });
    await waitFor(() => socket.emitted.find((e) => e.event === 'chat:session.ready'));

    socket.receive('chat:message.send', {
      sessionId: 'sess-eli',
      prompt: [{ type: 'text', text: 'please ask-user now' }],
    });
    const req = await waitFor(() =>
      socket.chatEvents().find((e) => e.kind === 'elicitation_request'),
    );
    if (req.kind !== 'elicitation_request') throw new Error('not an elicitation event');
    expect(req.message).toBe('Which color do you prefer?');
    expect(req.toolCallId).toMatch(/^call-/);
    const byName = new Map(req.fields.map((f) => [f.name, f]));
    expect(byName.get('question_0')).toEqual({
      name: 'question_0',
      type: 'enum',
      title: 'Color',
      options: [
        { value: 'Red', label: 'Red', description: 'The color red' },
        { value: 'Blue', label: 'Blue' },
      ],
      required: true,
    });
    expect(byName.get('question_1')).toEqual({
      name: 'question_1',
      type: 'boolean',
      title: 'Verbose',
    });
    expect(byName.get('question_2')).toEqual({
      name: 'question_2',
      type: 'integer',
      title: 'Count',
    });

    // Accept → values ride VERBATIM; the fixture echoes the response it got.
    const respondAck = vi.fn();
    socket.receive(
      'chat:elicitation.respond',
      {
        sessionId: 'sess-eli',
        requestId: req.requestId,
        action: 'accept',
        values: { question_0: 'Red', question_1: true, question_2: 3 },
      },
      respondAck,
    );
    expect(respondAck).toHaveBeenCalledWith({ accepted: true });
    const echoed = await waitFor(() =>
      socket
        .chatEvents()
        .find((e) => e.kind === 'message_delta' && e.delta.startsWith('elicitation')),
    );
    expect(
      JSON.parse((echoed as { delta: string }).delta.slice('elicitation answered: '.length)),
    ).toEqual({
      action: 'accept',
      content: { question_0: 'Red', question_1: true, question_2: 3 },
    });
    await waitFor(() => socket.chatEvents().find((e) => e.kind === 'turn_result'));

    // The request rides the history ring (resync re-shows the card)…
    socket.receive('chat:session.resync', { sessionId: 'sess-eli' });
    const history = await waitFor(
      () =>
        socket.emitted.find((e) => e.event === 'chat:history')?.payload as
          { items: { type: string; event?: { kind: string } }[] } | undefined,
    );
    expect(
      history.items.some((i) => i.type === 'event' && i.event?.kind === 'elicitation_request'),
    ).toBe(true);
    // …and a stale respond for the settled id is rejected, not re-answered.
    const staleAck = vi.fn();
    socket.receive(
      'chat:elicitation.respond',
      { sessionId: 'sess-eli', requestId: req.requestId, action: 'decline' },
      staleAck,
    );
    expect(staleAck).toHaveBeenCalledWith({ error: 'unknown-elicitation' });

    socket.receive('chat:session.close', { sessionId: 'sess-eli', reason: 'user' });
  }, 15000);

  it('a permission request with a UUID-STRING id resolves (codex-acp dialect)', async () => {
    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_HERMES: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
      homeDir: LEDGER_HOME,
    });
    socket.receive('chat:session.start', {
      sessionId: 'sess-str',
      agentInstanceId: 'ag-1',
      target: 'hermes',
      cwd: '/tmp',
    });
    await waitFor(() => socket.emitted.find((e) => e.event === 'chat:session.ready')?.payload);

    socket.receive('chat:message.send', {
      sessionId: 'sess-str',
      prompt: [{ type: 'text', text: 'please ask-permission string-id now' }],
    });
    const perm = await waitFor(() =>
      socket.chatEvents().find((e) => e.kind === 'permission_request'),
    );
    if (perm.kind !== 'permission_request') throw new Error('not a permission event');

    socket.receive('chat:permission.respond', {
      sessionId: 'sess-str',
      requestId: perm.requestId,
      optionId: 'allow_always',
    });
    // The fixture only replies once it sees a response whose `id` matches the
    // UUID it asked with — the old `Number(msg.id)` coercion sent id:null, so
    // this delta never arrived and the real codex turn hung forever.
    await waitFor(() =>
      socket
        .chatEvents()
        .find((e) => e.kind === 'message_delta' && e.delta === 'permission granted: allow_always'),
    );
    await waitFor(() =>
      socket.chatEvents().find((e) => e.kind === 'turn_result' && e.stopReason === 'end_turn'),
    );
    socket.receive('chat:session.close', { sessionId: 'sess-str', reason: 'user' });
  }, 15000);

  it('drops codex-acp\u2019s unknown-model notice instead of streaming it as text', async () => {
    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_HERMES: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
      homeDir: LEDGER_HOME,
    });
    socket.receive('chat:session.start', {
      sessionId: 'sess-notice',
      agentInstanceId: 'ag-1',
      target: 'hermes',
      cwd: '/tmp',
    });
    await waitFor(() => socket.emitted.find((e) => e.event === 'chat:session.ready')?.payload);

    socket.receive('chat:message.send', {
      sessionId: 'sess-notice',
      prompt: [{ type: 'text', text: 'please metadata-notice then echo' }],
    });
    await waitFor(() =>
      socket.chatEvents().find((e) => e.kind === 'message_delta' && e.delta.startsWith('echo:')),
    );
    const deltas = socket.chatEvents().filter((e) => e.kind === 'message_delta');
    expect(deltas.some((d) => String(d.delta).includes('Model metadata for'))).toBe(false);
    socket.receive('chat:session.close', { sessionId: 'sess-notice', reason: 'user' });
  }, 15000);

  it('a prompt REJECTED with a protocol error ends the turn but keeps the channel', async () => {
    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_HERMES: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
      homeDir: LEDGER_HOME,
    });
    socket.receive('chat:session.start', {
      sessionId: 'sess-err',
      agentInstanceId: 'ag-1',
      target: 'hermes',
      cwd: '/tmp',
    });
    await waitFor(() => socket.emitted.find((e) => e.event === 'chat:session.ready')?.payload);

    socket.receive('chat:message.send', {
      sessionId: 'sess-err',
      prompt: [{ type: 'text', text: 'please error now' }],
    });
    const errEvent = await waitFor(() =>
      socket.chatEvents().find((e) => e.kind === 'raw' && e.method === 'hnx/prompt-error'),
    );
    expect((errEvent.params as { message: string }).message).toBe('Authentication required');
    await waitFor(() =>
      socket.chatEvents().find((e) => e.kind === 'turn_result' && e.stopReason === 'end_turn'),
    );
    expect(socket.chatEvents()).toContainEqual({ kind: 'session_status', state: 'idle' });
    // The channel SURVIVES the errored turn (the old code tore it down).
    expect(socket.eventsOf('chat:session.closed')).toHaveLength(0);

    // …and the very next prompt still works (echo).
    socket.receive('chat:message.send', {
      sessionId: 'sess-err',
      prompt: [{ type: 'text', text: 'still alive?' }],
    });
    await waitFor(() =>
      socket
        .chatEvents()
        .find((e) => e.kind === 'message_delta' && e.delta === 'echo: still alive?'),
    );

    const closeAck = vi.fn();
    socket.receive('chat:session.close', { sessionId: 'sess-err', reason: 'user' }, closeAck);
    expect(closeAck).toHaveBeenCalledWith({ closed: true });
  }, 15000);

  it('a codex-style error carries its data.message detail into the note', async () => {
    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_HERMES: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
      homeDir: LEDGER_HOME,
    });
    socket.receive('chat:session.start', {
      sessionId: 'sess-err-detail',
      agentInstanceId: 'ag-1',
      target: 'hermes',
      cwd: '/tmp',
    });
    await waitFor(() => socket.emitted.find((e) => e.event === 'chat:session.ready')?.payload);

    socket.receive('chat:message.send', {
      sessionId: 'sess-err-detail',
      prompt: [{ type: 'text', text: 'please error with detail' }],
    });
    const errEvent = await waitFor(() =>
      socket.chatEvents().find((e) => e.kind === 'raw' && e.method === 'hnx/prompt-error'),
    );
    // codex-acp answers `-32603 "Internal error"` with the real reason in
    // `data.message` — without this mapping the note is a bare "Internal error".
    expect((errEvent.params as { message: string }).message).toBe(
      'Internal error: stream disconnected before completion: error sending request for url (https://example.test/v3/responses)',
    );
    await waitFor(() =>
      socket.chatEvents().find((e) => e.kind === 'turn_result' && e.stopReason === 'end_turn'),
    );

    socket.receive('chat:session.close', { sessionId: 'sess-err-detail', reason: 'user' });
  }, 15000);

  it('start with an unavailable adapter reports spawn failure', async () => {
    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_HERMES: 'definitely-not-a-command-12345', PATH: '/nonexistent' },
      homeDir: LEDGER_HOME,
    });
    socket.receive('chat:session.start', {
      sessionId: 'sess-2',
      agentInstanceId: 'ag-1',
      target: 'hermes',
      cwd: '/tmp',
    });
    const ready = await waitFor(
      () =>
        socket.emitted.find((e) => e.event === 'chat:session.ready')?.payload as
          { error?: string } | undefined,
    );
    expect(ready.error).toBeTruthy();
  }, 15000);

  it('an initialize timeout surfaces the spawn stderr tail (rig-found: corrupted npx caches must self-diagnose)', async () => {
    // 2026-09-18 rig incident: a killed spawn left the claude wrapper's _npx
    // cache half-renamed; every later `npx -y` died on ENOTEMPTY AFTER
    // printing it to stderr, so the bare "initialize timed out" 504 carried
    // no clue. The tail rides the error now.
    await expect(
      AcpAgentConnection.start('node', [FIXTURE], {
        cwd: '/tmp',
        initializeTimeoutMs: 1200,
        env: { FIXTURE_NO_INIT: '1' },
      }),
    ).rejects.toThrow(/timed out after 1200ms: fixture stderr diagnostic/);
  }, 15000);
});

describe('native sessions (9 W7): resume, history, resync', () => {
  function waitFor<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = (): void => {
        const v = fn();
        if (v !== undefined) return resolve(v);
        if (Date.now() - started > ms) return reject(new Error('waitFor: timeout'));
        setTimeout(tick, 20);
      };
      tick();
    });
  }

  it('resume via session/load captures the replay as chat:history, then ready carries the native id', async () => {
    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_HERMES: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
      homeDir: LEDGER_HOME,
    });

    socket.receive('chat:session.start', {
      sessionId: 'sess-r1',
      agentInstanceId: 'ag-1',
      target: 'hermes',
      cwd: '/tmp',
      resume: { sessionId: 'fx-native-1', cwd: '/tmp' },
    });

    const ready = await waitFor(
      () =>
        socket.emitted.find((e) => e.event === 'chat:session.ready')?.payload as
          { error?: string; nativeSessionId?: string } | undefined,
    );
    expect(ready.error).toBeUndefined();
    expect(ready.nativeSessionId).toBe('fx-native-1');

    // History shipped BEFORE ready: the replayed user turn, the message, the
    // completed Read tool, and a synthetic turn_result so the fold settles.
    const history = socket.eventsOf('chat:history')[0]!.payload as {
      sessionId: string;
      items: { type: string; blocks?: unknown[]; event?: ChatStreamEvent }[];
    };
    expect(history.sessionId).toBe('sess-r1');
    const kinds = history.items.map((i) =>
      i.type === 'user' ? 'user' : (i.event!.kind as string),
    );
    expect(kinds).toEqual(['user', 'message_delta', 'tool_call', 'turn_result']);
    expect(history.items[0]!.blocks).toEqual([{ type: 'text', text: 'what did we conclude?' }]);
    const tool = history.items.find((i) => i.type === 'event' && i.event!.kind === 'tool_call')!
      .event as { call: { toolName?: string; status?: string; output?: string } };
    expect(tool.call.toolName).toBe('Read');
    expect(tool.call.status).toBe('completed');
    expect(tool.call.output).toBe('42');

    // A live turn on the resumed channel appends to the SAME ring.
    socket.receive('chat:message.send', {
      sessionId: 'sess-r1',
      prompt: [{ type: 'text', text: 'continue' }],
    });
    await waitFor(() =>
      socket.chatEvents().find((e) => e.kind === 'message_delta' && e.delta === 'echo: continue'),
    );

    // Resync (page refresh): the ring replays — replay history + live turn.
    const resyncAck = vi.fn();
    socket.receive('chat:session.resync', { sessionId: 'sess-r1' }, resyncAck);
    expect(resyncAck).toHaveBeenCalledWith({ accepted: true });
    const batches = socket.eventsOf('chat:history') as unknown as {
      payload: { items: { type: string; blocks?: unknown[] }[] };
    }[];
    const last = batches[batches.length - 1]!.payload;
    const userTexts = last.items
      .filter((i) => i.type === 'user')
      .map((i) => (i.blocks![0] as { text: string }).text);
    expect(userTexts).toEqual(['what did we conclude?', 'continue']);

    const closeAck = vi.fn();
    socket.receive('chat:session.close', { sessionId: 'sess-r1', reason: 'user' }, closeAck);
    expect(closeAck).toHaveBeenCalledWith({ closed: true });
  }, 15000);

  it('resume-only adapters (the dsh shape) resume without replay and report the native id', async () => {
    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_HERMES: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
      spawnEnv: { ...process.env, FIXTURE_ACP_NO_LOAD: '1' },
      homeDir: LEDGER_HOME,
    });

    socket.receive('chat:session.start', {
      sessionId: 'sess-r2',
      agentInstanceId: 'ag-1',
      target: 'hermes',
      cwd: '/tmp',
      resume: { sessionId: 'fx-native-only', cwd: '/tmp' },
    });

    const ready = await waitFor(
      () =>
        socket.emitted.find((e) => e.event === 'chat:session.ready')?.payload as
          { error?: string; nativeSessionId?: string } | undefined,
    );
    expect(ready.error).toBeUndefined();
    expect(ready.nativeSessionId).toBe('fx-native-only');
    // No transcript parser for hermes → no history batch.
    expect(socket.eventsOf('chat:history')).toHaveLength(0);

    const closeAck = vi.fn();
    socket.receive('chat:session.close', { sessionId: 'sess-r2', reason: 'user' }, closeAck);
    expect(closeAck).toHaveBeenCalledWith({ closed: true });
  }, 15000);
});

describe('resume failure hygiene (9 W7 leak regression)', () => {
  function waitFor<T>(fn: () => T | undefined, ms = 8000): Promise<T> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = (): void => {
        const v = fn();
        if (v !== undefined) return resolve(v);
        if (Date.now() - started > ms) return reject(new Error('waitFor: timeout'));
        setTimeout(tick, 20);
      };
      tick();
    });
  }
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('a failed establishment surfaces the error AND kills the adapter process', async () => {
    const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const pidFile = join(mkdtempSync(join(tmpdir(), 'hnx-fx-pid-')), 'pids');
    writeFileSync(pidFile, '', 'utf8');

    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_HERMES: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
      spawnEnv: { ...process.env, FIXTURE_PID_FILE: pidFile },
      homeDir: LEDGER_HOME,
    });

    socket.receive('chat:session.start', {
      sessionId: 'sess-fail',
      agentInstanceId: 'ag-1',
      target: 'hermes',
      cwd: '/tmp',
      resume: { sessionId: 'fx-native-fail', cwd: '/tmp' },
    });

    const ready = await waitFor(
      () =>
        socket.emitted.find((e) => e.event === 'chat:session.ready')?.payload as
          { error?: string } | undefined,
    );
    expect(ready.error).toContain('no configured model');

    // The adapter process must be GONE (this was the leak: every failed
    // resume left a live dsh/npx adapter parented to the daemon forever).
    await waitFor(() => {
      const pids = readFileSync(pidFile, 'utf8')
        .split('\n')
        .map((l) => Number.parseInt(l, 10))
        .filter((n) => Number.isFinite(n) && n > 0);
      return pids.length > 0 && pids.every((p) => !alive(p)) ? true : undefined;
    });
  }, 15000);

  it('a close arriving DURING establishment aborts it and kills the adapter', async () => {
    const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const pidFile = join(mkdtempSync(join(tmpdir(), 'hnx-fx-pid-')), 'pids');
    writeFileSync(pidFile, '', 'utf8');

    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_HERMES: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
      // Hold `session/new` open so the close below lands mid-establishment.
      spawnEnv: { ...process.env, FIXTURE_PID_FILE: pidFile, FIXTURE_DELAY_NEW_MS: '1500' },
      homeDir: LEDGER_HOME,
    });

    socket.receive('chat:session.start', {
      sessionId: 'sess-race',
      agentInstanceId: 'ag-1',
      target: 'hermes',
      cwd: '/tmp',
    });
    // Wait until the adapter is spawned (pid recorded) but session/new is
    // still pending — the channel is not registered yet.
    await waitFor(() => (readFileSync(pidFile, 'utf8').trim() !== '' ? true : undefined));
    socket.receive('chat:session.close', { sessionId: 'sess-race', reason: 'user' });

    // The establishment finishes AFTER the close: it must be abandoned, not
    // registered. Without the checkpoints the daemon would emit ready here and
    // keep an orphan adapter with no channel left to ever close it.
    await new Promise((r) => setTimeout(r, 2500));
    expect(socket.emitted.filter((e) => e.event === 'chat:session.ready')).toHaveLength(0);

    await waitFor(() => {
      const pids = readFileSync(pidFile, 'utf8')
        .split('\n')
        .map((l) => Number.parseInt(l, 10))
        .filter((n) => Number.isFinite(n) && n > 0);
      return pids.length > 0 && pids.every((p) => !alive(p)) ? true : undefined;
    });
  }, 15000);
});

describe('adapter ledger (9 W11 A)', () => {
  function waitFor<T>(fn: () => T | undefined, ms = 8000): Promise<T> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = (): void => {
        const v = fn();
        if (v !== undefined) return resolve(v);
        if (Date.now() - started > ms) return reject(new Error('waitFor: timeout'));
        setTimeout(tick, 20);
      };
      tick();
    });
  }
  const gone = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  };
  const pidsIn = (file: string): number[] =>
    readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => Number.parseInt(l, 10))
      .filter((n) => Number.isFinite(n) && n > 0);

  it('the entry exists BEFORE establishment completes — the hard-death window is covered', async () => {
    const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = mkdtempSync(join(tmpdir(), 'hnx-ledger-'));
    const pidFile = join(mkdtempSync(join(tmpdir(), 'hnx-fx-pid-')), 'pids');
    writeFileSync(pidFile, '', 'utf8');

    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_HERMES: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
      // Hold `session/new` open: the channel sits mid-establishment while we
      // inspect the ledger (a daemon hard-death HERE is the D1 case).
      spawnEnv: { ...process.env, FIXTURE_PID_FILE: pidFile, FIXTURE_DELAY_NEW_MS: '1500' },
      homeDir: home,
      auditIntervalMs: 0,
    });

    socket.receive('chat:session.start', {
      sessionId: 'sess-early',
      agentInstanceId: 'ag-1',
      target: 'hermes',
      cwd: '/tmp',
    });
    await waitFor(() => (readFileSync(pidFile, 'utf8').trim() !== '' ? true : undefined));

    const entries = readAdapterLedger(home);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      wireSessionId: 'sess-early',
      target: 'hermes',
      command: 'node',
    });
    // The pgid is the SPAWNED group's id (the fixture's own pid), recorded
    // before the agent answered anything — and no native session id yet.
    expect(entries[0]!.pgid).toBe(pidsIn(pidFile)[0]);
    expect(entries[0]!.nativeSessionId).toBeUndefined();

    // A boot sweep at this instant would find and reap exactly this group.
    socket.receive('chat:session.close', { sessionId: 'sess-early', reason: 'user' });
    await waitFor(() => (pidsIn(pidFile).every((p) => gone(p)) ? true : undefined));
    rmSync(home, { recursive: true, force: true });
  }, 15000);

  it('registration enriches the entry with the native id; close defers removal to the audit', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = mkdtempSync(join(tmpdir(), 'hnx-ledger-'));

    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_HERMES: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
      homeDir: home,
      auditIntervalMs: 100,
    });

    socket.receive('chat:session.start', {
      sessionId: 'sess-ledger',
      agentInstanceId: 'ag-1',
      target: 'hermes',
      cwd: '/tmp',
    });
    const ready = (await waitFor(
      () => socket.emitted.find((e) => e.event === 'chat:session.ready')?.payload,
    )) as { nativeSessionId?: string; error?: string };
    expect(ready.error).toBeUndefined();

    const entries = readAdapterLedger(home);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ wireSessionId: 'sess-ledger' });
    expect(entries[0]!.nativeSessionId).toBe(ready.nativeSessionId);
    const pgid = entries[0]!.pgid;

    socket.receive('chat:session.close', { sessionId: 'sess-ledger', reason: 'user' });
    await waitFor(() => (socket.eventsOf('chat:session.closed').length > 0 ? true : undefined));
    // Synchronously after the closed event the file is STILL there (kill
    // paths never unlink — a hard death inside the kill grace must keep the
    // record sweepable)…
    expect(readAdapterLedger(home)).toHaveLength(1);
    // …and the audit removes it once the group is actually gone.
    await waitFor(() => (readAdapterLedger(home).length === 0 ? true : undefined));
    expect(gone(pgid)).toBe(true);
    rmSync(home, { recursive: true, force: true });
  }, 15000);

  it('a failed establishment leaves no ledger residue once the group dies', async () => {
    const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = mkdtempSync(join(tmpdir(), 'hnx-ledger-'));
    const pidFile = join(mkdtempSync(join(tmpdir(), 'hnx-fx-pid-')), 'pids');
    writeFileSync(pidFile, '', 'utf8');

    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_HERMES: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
      spawnEnv: { ...process.env, FIXTURE_PID_FILE: pidFile },
      homeDir: home,
      auditIntervalMs: 100,
    });

    socket.receive('chat:session.start', {
      sessionId: 'sess-fail-ledger',
      agentInstanceId: 'ag-1',
      target: 'hermes',
      cwd: '/tmp',
      resume: { sessionId: 'fx-native-fail', cwd: '/tmp' },
    });
    const ready = (await waitFor(
      () => socket.emitted.find((e) => e.event === 'chat:session.ready')?.payload,
    )) as { error?: string };
    expect(ready.error).toContain('no configured model');

    await waitFor(() => (pidsIn(pidFile).every((p) => gone(p)) ? true : undefined));
    await waitFor(() => (readAdapterLedger(home).length === 0 ? true : undefined));
    rmSync(home, { recursive: true, force: true });
  }, 15000);
});

describe('disconnect grace + reconcile (9 W11 E)', () => {
  function waitFor<T>(fn: () => T | undefined, ms = 8000): Promise<T> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = (): void => {
        const v = fn();
        if (v !== undefined) return resolve(v);
        if (Date.now() - started > ms) return reject(new Error('waitFor: timeout'));
        setTimeout(tick, 20);
      };
      tick();
    });
  }
  const gone = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  };
  const pidsIn = (file: string): number[] =>
    readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => Number.parseInt(l, 10))
      .filter((n) => Number.isFinite(n) && n > 0);

  const openSession = async (socket: FakeSocket, sessionId: string): Promise<void> => {
    socket.receive('chat:session.start', {
      sessionId,
      agentInstanceId: 'ag-1',
      target: 'hermes',
      cwd: '/tmp',
    });
    const ready = (await waitFor(
      () =>
        socket.emitted.find(
          (e) =>
            e.event === 'chat:session.ready' &&
            (e.payload as { sessionId?: string }).sessionId === sessionId,
        )?.payload,
    )) as { error?: string };
    expect(ready.error).toBeUndefined();
  };

  it('a transport blip within the grace window keeps the channel; a later prompt works', async () => {
    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_HERMES: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
      homeDir: LEDGER_HOME,
    });
    await openSession(socket, 'sess-blip');

    socket.receive('disconnect', 'transport close');
    // Within the window: nothing tears down.
    await new Promise((r) => setTimeout(r, 300));
    expect(socket.eventsOf('chat:session.closed')).toHaveLength(0);

    socket.receive('connect');
    const ack = vi.fn();
    socket.receive(
      'chat:message.send',
      { sessionId: 'sess-blip', prompt: [{ type: 'text', text: 'hi' }] },
      ack,
    );
    expect(ack).toHaveBeenCalledWith({ accepted: true });
    await waitFor(() => socket.chatEvents().find((e) => e.kind === 'turn_result'));
    socket.receive('chat:session.close', { sessionId: 'sess-blip', reason: 'user' });
  }, 15000);

  it('a blip that outlasts the grace window tears everything down', async () => {
    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: {
        HN_ACP_COMMAND_HERMES: `node ${FIXTURE}`,
        HN_TEARDOWN_GRACE_MS: '80',
        PATH: process.env.PATH ?? '',
      },
      homeDir: LEDGER_HOME,
    });
    await openSession(socket, 'sess-expire');

    socket.receive('disconnect', 'transport close');
    await waitFor(() => (socket.eventsOf('chat:session.closed').length > 0 ? true : undefined));
    expect((socket.eventsOf('chat:session.closed')[0]!.payload as { reason: string }).reason).toBe(
      'daemon-disconnected',
    );
  }, 15000);

  it('a deliberate stop (io client disconnect) tears down immediately despite the grace', async () => {
    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_HERMES: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
      homeDir: LEDGER_HOME,
    });
    await openSession(socket, 'sess-stop');

    socket.receive('disconnect', 'io client disconnect');
    await waitFor(() => (socket.eventsOf('chat:session.closed').length > 0 ? true : undefined));
  }, 15000);

  it('HN_TEARDOWN_GRACE_MS=0 restores the pre-W11 immediate teardown', async () => {
    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: {
        HN_ACP_COMMAND_HERMES: `node ${FIXTURE}`,
        HN_TEARDOWN_GRACE_MS: '0',
        PATH: process.env.PATH ?? '',
      },
      homeDir: LEDGER_HOME,
    });
    await openSession(socket, 'sess-off');

    socket.receive('disconnect', 'transport close');
    await waitFor(() => (socket.eventsOf('chat:session.closed').length > 0 ? true : undefined));
  }, 15000);

  it('reconcile drops unlisted sessions, keeps listed ones, and acks what is held', async () => {
    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_HERMES: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
      homeDir: LEDGER_HOME,
    });
    await openSession(socket, 'sess-keep');
    await openSession(socket, 'sess-drop');

    const ack = vi.fn();
    socket.receive('chat:reconcile', { sessionIds: ['sess-keep'] }, ack);

    const dropped = await waitFor(() =>
      socket
        .eventsOf('chat:session.closed')
        .find((e) => (e.payload as { sessionId: string }).sessionId === 'sess-drop'),
    );
    expect((dropped.payload as { reason: string }).reason).toBe('reconciled');
    expect(ack).toHaveBeenCalledWith({ held: ['sess-keep'] });

    // The kept channel still prompts.
    const promptAck = vi.fn();
    socket.receive(
      'chat:message.send',
      { sessionId: 'sess-keep', prompt: [{ type: 'text', text: 'hi' }] },
      promptAck,
    );
    expect(promptAck).toHaveBeenCalledWith({ accepted: true });
    await waitFor(() => socket.chatEvents().find((e) => e.kind === 'turn_result'));
    socket.receive('chat:session.close', { sessionId: 'sess-keep', reason: 'user' });
  }, 15000);

  it('reconcile ABORTS an unlisted in-flight establishment (no orphan, no ready)', async () => {
    const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const pidFile = join(mkdtempSync(join(tmpdir(), 'hnx-fx-pid-')), 'pids');
    writeFileSync(pidFile, '', 'utf8');

    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_HERMES: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
      // Hold session/new open so the reconcile lands mid-establishment.
      spawnEnv: { ...process.env, FIXTURE_PID_FILE: pidFile, FIXTURE_DELAY_NEW_MS: '1500' },
      homeDir: LEDGER_HOME,
    });
    socket.receive('chat:session.start', {
      sessionId: 'sess-orphan',
      agentInstanceId: 'ag-1',
      target: 'hermes',
      cwd: '/tmp',
    });
    await waitFor(() => (readFileSync(pidFile, 'utf8').trim() !== '' ? true : undefined));

    const ack = vi.fn();
    socket.receive('chat:reconcile', { sessionIds: [] }, ack);
    expect(ack).toHaveBeenCalledWith({ held: [] });

    // The establishment must abort at its checkpoint — no ready, adapter dead.
    await new Promise((r) => setTimeout(r, 2200));
    expect(socket.emitted.filter((e) => e.event === 'chat:session.ready')).toHaveLength(0);
    await waitFor(() => (pidsIn(pidFile).every((p) => gone(p)) ? true : undefined));
  }, 15000);

  it('reconcile reports a LISTED in-flight start as held and lets it finish', async () => {
    const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const pidFile = join(mkdtempSync(join(tmpdir(), 'hnx-fx-pid-')), 'pids');
    writeFileSync(pidFile, '', 'utf8');

    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_HERMES: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
      spawnEnv: { ...process.env, FIXTURE_PID_FILE: pidFile, FIXTURE_DELAY_NEW_MS: '600' },
      homeDir: LEDGER_HOME,
    });
    socket.receive('chat:session.start', {
      sessionId: 'sess-inflight',
      agentInstanceId: 'ag-1',
      target: 'hermes',
      cwd: '/tmp',
    });
    await waitFor(() => (readFileSync(pidFile, 'utf8').trim() !== '' ? true : undefined));

    const ack = vi.fn();
    socket.receive('chat:reconcile', { sessionIds: ['sess-inflight'] }, ack);
    expect(ack).toHaveBeenCalledWith({ held: ['sess-inflight'] });

    const ready = (await waitFor(
      () => socket.emitted.find((e) => e.event === 'chat:session.ready')?.payload,
    )) as { error?: string };
    expect(ready.error).toBeUndefined();
    socket.receive('chat:session.close', { sessionId: 'sess-inflight', reason: 'user' });
  }, 15000);
});

// Node's zstd binding (needed to write real frames for the tail); absent on
// Node < 22.15 — those tests self-skip.
const maybeZstd = (await import('node:zlib')) as unknown as {
  zstdCompressSync?: (b: Buffer) => Buffer;
};

describe('dsh live streaming via transcript tail (9 W7)', () => {
  function waitFor<T>(fn: () => T | undefined, ms = 8000): Promise<T> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = (): void => {
        const v = fn();
        if (v !== undefined) return resolve(v);
        if (Date.now() - started > ms) return reject(new Error('waitFor: timeout'));
        setTimeout(tick, 20);
      };
      tick();
    });
  }

  it('streams token batches from the transcript while the turn runs, suppressing committed chunks', async () => {
    const zstd = maybeZstd.zstdCompressSync;
    if (zstd === undefined) return; // needs Node >= 22.15 zstd (the Node 20 CI floor runs this as a no-op)

    const { mkdirSync, writeFileSync, appendFileSync } = await import('node:fs');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = mkdtempSync(join(tmpdir(), 'hnx-dsh-tail-'));
    const sid = 'fx-tail-1';
    const dir = join(home, '.dsh', 'sessions', '--tail--', sid);
    mkdirSync(dir, { recursive: true });
    const transcript = join(dir, 'session.jsonl.zstd');
    const frame = (entries: unknown[]): Buffer =>
      Buffer.concat(entries.map((e) => zstd(Buffer.from(`${JSON.stringify(e)}\n`))));
    writeFileSync(
      transcript,
      frame([{ type: 'session', cwd: '/tmp', createdAt: 1, delegationDepth: 0 }]),
    );

    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: {
        HN_ACP_COMMAND_DEEPSEEK: `node ${FIXTURE}`,
        HN_DISABLE_DSH_TAP: '1',
        PATH: process.env.PATH ?? '',
      },
      spawnEnv: { ...process.env, FIXTURE_SESSION_ID: sid, FIXTURE_DELAY_PROMPT_MS: '1200' },
      homeDir: home,
    });

    socket.receive('chat:session.start', {
      sessionId: 'sess-tail',
      agentInstanceId: 'ag-1',
      target: 'deepseek',
      cwd: '/tmp',
    });
    const ready = await waitFor(
      () =>
        socket.emitted.find((e) => e.event === 'chat:session.ready')?.payload as
          { error?: string; nativeSessionId?: string } | undefined,
    );
    expect(ready.error).toBeUndefined();
    expect(ready.nativeSessionId).toBe(sid);

    // The turn is in flight (the fixture waits FIXTURE_DELAY_PROMPT_MS) —
    // "dsh" appends token batches to the transcript DURING generation.
    setTimeout(() => {
      appendFileSync(
        transcript,
        frame([
          {
            type: 'text-chunks',
            seq0: 1,
            time0: 1,
            data: { turn: 1, step: 0, index: 0, dt: [1], texts: ['你好', '，'] },
          },
        ]),
      );
    }, 250);
    setTimeout(() => {
      appendFileSync(
        transcript,
        frame([
          {
            type: 'text-chunks',
            seq0: 3,
            time0: 2,
            data: { turn: 1, step: 0, index: 0, dt: [], texts: ['世界'] },
          },
          { type: 'turn/end', seq: 4, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
        ]),
      );
    }, 600);

    socket.receive('chat:message.send', {
      sessionId: 'sess-tail',
      prompt: [{ type: 'text', text: 'say hi slowly' }],
    });
    const turnDone = await waitFor(() => socket.chatEvents().find((e) => e.kind === 'turn_result'));
    expect(turnDone).toBeDefined();

    // The streamed deltas arrived BEFORE the turn settled — and the fixture's
    // own committed `agent_message_chunk` echo ('echo: say hi slowly') was
    // SUPPRESSED (the tail already streamed this turn's text).
    const deltas = socket
      .chatEvents()
      .filter((e): e is { kind: 'message_delta'; delta: string } => e.kind === 'message_delta')
      .map((e) => e.delta);
    expect(deltas).toContain('你好，');
    expect(deltas).toContain('世界');
    expect(deltas.join('')).not.toContain('echo: say hi slowly');
    const turnIdx = socket.chatEvents().findIndex((e) => e.kind === 'turn_result');
    const lastDeltaIdx = socket
      .chatEvents()
      .findLastIndex((e) => e.kind === 'message_delta' && e.delta === '世界');
    expect(lastDeltaIdx).toBeLessThan(turnIdx);

    const closeAck = vi.fn();
    socket.receive('chat:session.close', { sessionId: 'sess-tail', reason: 'user' }, closeAck);
    expect(closeAck).toHaveBeenCalledWith({ closed: true });
  }, 15000);

  it('without a transcript (no tail) the committed chunks stream as before', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = mkdtempSync(join(tmpdir(), 'hnx-dsh-notail-'));

    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: {
        HN_ACP_COMMAND_DEEPSEEK: `node ${FIXTURE}`,
        HN_DISABLE_DSH_TAP: '1',
        PATH: process.env.PATH ?? '',
      },
      spawnEnv: { ...process.env, FIXTURE_SESSION_ID: 'fx-notail-1' },
      homeDir: home,
    });
    socket.receive('chat:session.start', {
      sessionId: 'sess-nt',
      agentInstanceId: 'ag-1',
      target: 'deepseek',
      cwd: '/tmp',
    });
    const ready = await waitFor(
      () =>
        socket.emitted.find((e) => e.event === 'chat:session.ready')?.payload as
          { error?: string } | undefined,
    );
    expect(ready.error).toBeUndefined();
    socket.receive('chat:message.send', {
      sessionId: 'sess-nt',
      prompt: [{ type: 'text', text: 'hi' }],
    });
    await waitFor(() =>
      socket.chatEvents().find((e) => e.kind === 'message_delta' && e.delta === 'echo: hi'),
    );
    const closeAck = vi.fn();
    socket.receive('chat:session.close', { sessionId: 'sess-nt', reason: 'user' }, closeAck);
    expect(closeAck).toHaveBeenCalledWith({ closed: true });
  }, 15000);

  it('a lazily-materialized transcript replays from byte 0 — pre-attach deltas are not lost', async () => {
    const zstd = maybeZstd.zstdCompressSync;
    if (zstd === undefined) return; // needs Node >= 22.15 zstd (the Node 20 CI floor runs this as a no-op)

    const { mkdirSync, writeFileSync, appendFileSync } = await import('node:fs');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = mkdtempSync(join(tmpdir(), 'hnx-dsh-lazy-'));
    const sid = 'fx-lazy-1';
    const dir = join(home, '.dsh', 'sessions', '--lazy--', sid);
    mkdirSync(dir, { recursive: true });
    const transcript = join(dir, 'session.jsonl.zstd');
    const frame = (entries: unknown[]): Buffer =>
      Buffer.concat(entries.map((e) => zstd(Buffer.from(`${JSON.stringify(e)}\n`))));

    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: {
        HN_ACP_COMMAND_DEEPSEEK: `node ${FIXTURE}`,
        HN_DISABLE_DSH_TAP: '1',
        PATH: process.env.PATH ?? '',
      },
      spawnEnv: { ...process.env, FIXTURE_SESSION_ID: sid, FIXTURE_DELAY_PROMPT_MS: '2500' },
      homeDir: home,
    });
    socket.receive('chat:session.start', {
      sessionId: 'sess-lazy',
      agentInstanceId: 'ag-1',
      target: 'deepseek',
      cwd: '/tmp',
    });
    const ready = await waitFor(
      () =>
        socket.emitted.find((e) => e.event === 'chat:session.ready')?.payload as
          { error?: string; nativeSessionId?: string } | undefined,
    );
    expect(ready.error).toBeUndefined();

    // The prompt goes out while the transcript does NOT exist yet (dsh
    // materializes it lazily); the file then appears already holding the
    // turn's FIRST batch — written before any attach could see it.
    socket.receive('chat:message.send', {
      sessionId: 'sess-lazy',
      prompt: [{ type: 'text', text: 'lazy file' }],
    });
    setTimeout(() => {
      writeFileSync(
        transcript,
        frame([
          { type: 'session', cwd: '/tmp', createdAt: 1, delegationDepth: 0 },
          {
            type: 'text-chunks',
            seq0: 1,
            time0: 1,
            data: { turn: 1, step: 0, index: 0, dt: [1], texts: ['早到的批次'] },
          },
        ]),
      );
    }, 120);
    setTimeout(() => {
      appendFileSync(
        transcript,
        frame([
          {
            type: 'text-chunks',
            seq0: 3,
            time0: 2,
            data: { turn: 1, step: 0, index: 0, dt: [], texts: ['后到的批次'] },
          },
          { type: 'turn/end', seq: 4, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
        ]),
      );
    }, 900);

    await waitFor(() => socket.chatEvents().find((e) => e.kind === 'turn_result'));
    const deltas = socket
      .chatEvents()
      .filter((e): e is { kind: 'message_delta'; delta: string } => e.kind === 'message_delta')
      .map((e) => e.delta);
    // BOTH batches streamed — the pre-attach one via the byte-0 replay — and
    // the wire's committed echo never doubled anything.
    expect(deltas).toContain('早到的批次');
    expect(deltas).toContain('后到的批次');
    expect(deltas.join('')).not.toContain('echo: lazy file');

    const closeAck = vi.fn();
    socket.receive('chat:session.close', { sessionId: 'sess-lazy', reason: 'user' }, closeAck);
    expect(closeAck).toHaveBeenCalledWith({ closed: true });
  }, 15000);
});

describe('dsh live streaming via the in-process event tap (9 W7.1)', () => {
  function waitFor<T>(fn: () => T | undefined, ms = 8000): Promise<T> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = (): void => {
        const v = fn();
        if (v !== undefined) return resolve(v);
        if (Date.now() - started > ms) return reject(new Error('waitFor: timeout'));
        setTimeout(tick, 20);
      };
      tick();
    });
  }

  it('tap handshake wins: bus deltas stream, committed chunks suppressed, turn/end settles turn_result', async () => {
    const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = mkdtempSync(join(tmpdir(), 'hnx-dsh-tap-'));
    const argvFile = join(home, 'argv.txt');
    writeFileSync(argvFile, '', 'utf8');
    const sid = 'fx-tap-1';

    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_DEEPSEEK: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
      spawnEnv: {
        ...process.env,
        FIXTURE_SESSION_ID: sid,
        FIXTURE_TAP_SPEAKER: '1',
        FIXTURE_ARGV_FILE: argvFile,
      },
      homeDir: home,
    });

    socket.receive('chat:session.start', {
      sessionId: 'sess-tap',
      agentInstanceId: 'ag-1',
      target: 'deepseek',
      cwd: '/tmp',
    });
    const ready = await waitFor(
      () =>
        socket.emitted.find((e) => e.event === 'chat:session.ready')?.payload as
          { error?: string; nativeSessionId?: string } | undefined,
    );
    expect(ready.error).toBeUndefined();
    expect(ready.nativeSessionId).toBe(sid);

    // The spawn composed the tap: `--patch <yml>` on the adapter argv and the
    // insert overlay rendered under the daemon's home (never ~/.dsh).
    await waitFor(() => (readFileSync(argvFile, 'utf8').includes('--patch') ? true : undefined));
    const patchYml = readFileSync(join(home, '.hnx', 'dsh-tap.patch.yml'), 'utf8');
    expect(patchYml).toContain('- insert:');
    expect(patchYml).toContain('id: hnx-tap');

    socket.receive('chat:message.send', {
      sessionId: 'sess-tap',
      prompt: [{ type: 'text', text: 'hello tap' }],
    });
    const turnIdx = await waitFor(() => {
      const i = socket.chatEvents().findIndex((e) => e.kind === 'turn_result');
      return i === -1 ? undefined : i;
    });

    // Both bus deltas streamed; the subagent session's event never rendered.
    const deltas = socket
      .chatEvents()
      .filter((e): e is { kind: string; delta: string } => e.kind === 'message_delta')
      .map((e) => e.delta);
    expect(deltas).toContain('tap-流式-1 ');
    expect(deltas).toContain('tap-流式-2');
    expect(deltas.join('')).not.toContain('SUBAGENT-NOISE');
    // The wire's committed chunks (suppressed — the tap owns this turn's
    // text) and the streamed step's commit blocks never rendered.
    expect(deltas.join('')).not.toContain('echo: hello tap');
    expect(deltas.join('')).not.toContain('committed-thought');
    expect(deltas.join('')).not.toContain('tap-COMMIT-text');
    // Every delta PRECEDES turn_result — the tap's `turn/end` (deliberately
    // landed 150ms AFTER the wire settled) gated it.
    const lastDeltaIdx = socket.chatEvents().findLastIndex((e) => e.kind === 'message_delta');
    expect(lastDeltaIdx).toBeLessThan(turnIdx);
    // The commit's usage rode the bus; the wire's usage_update flowed too.
    const usages = socket.chatEvents().filter((e) => e.kind === 'usage');
    expect(usages).toContainEqual({ kind: 'usage', inputTokens: 5, outputTokens: 9 });
    expect(usages).toContainEqual({ kind: 'usage', inputTokens: 11, outputTokens: 7 });

    const closeAck = vi.fn();
    socket.receive('chat:session.close', { sessionId: 'sess-tap', reason: 'user' }, closeAck);
    expect(closeAck).toHaveBeenCalledWith({ closed: true });
  }, 15000);

  it('no tap handshake within the window → falls through to committed streaming (worst case = W7)', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = mkdtempSync(join(tmpdir(), 'hnx-dsh-notap-'));

    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_DEEPSEEK: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
      // No FIXTURE_TAP_SPEAKER: the fixture receives HNX_TAP_PORT but stays
      // silent — and tolerates the appended `--patch` argv.
      spawnEnv: { ...process.env, FIXTURE_SESSION_ID: 'fx-notap-1' },
      homeDir: home,
    });
    socket.receive('chat:session.start', {
      sessionId: 'sess-nt2',
      agentInstanceId: 'ag-1',
      target: 'deepseek',
      cwd: '/tmp',
    });
    const ready = await waitFor(
      () =>
        socket.emitted.find((e) => e.event === 'chat:session.ready')?.payload as
          { error?: string } | undefined,
    );
    expect(ready.error).toBeUndefined();
    socket.receive('chat:message.send', {
      sessionId: 'sess-nt2',
      prompt: [{ type: 'text', text: 'hi fallback' }],
    });
    await waitFor(() =>
      socket
        .chatEvents()
        .find((e) => e.kind === 'message_delta' && e.delta === 'echo: hi fallback'),
    );
    const closeAck = vi.fn();
    socket.receive('chat:session.close', { sessionId: 'sess-nt2', reason: 'user' }, closeAck);
    expect(closeAck).toHaveBeenCalledWith({ closed: true });
  }, 20000);

  it('HN_DISABLE_DSH_TAP=1 spawns the adapter with NO tap at all (the A/B switch)', async () => {
    const { mkdtempSync, readFileSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const home = mkdtempSync(join(tmpdir(), 'hnx-dsh-ab-'));
    const argvFile = join(home, 'argv.txt');
    writeFileSync(argvFile, '', 'utf8');

    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: {
        HN_ACP_COMMAND_DEEPSEEK: `node ${FIXTURE}`,
        HN_DISABLE_DSH_TAP: '1',
        PATH: process.env.PATH ?? '',
      },
      spawnEnv: {
        ...process.env,
        FIXTURE_SESSION_ID: 'fx-ab-1',
        FIXTURE_TAP_SPEAKER: '1', // even a speaking fixture: no port was passed
        FIXTURE_ARGV_FILE: argvFile,
      },
      homeDir: home,
    });
    socket.receive('chat:session.start', {
      sessionId: 'sess-ab',
      agentInstanceId: 'ag-1',
      target: 'deepseek',
      cwd: '/tmp',
    });
    const ready = await waitFor(
      () =>
        socket.emitted.find((e) => e.event === 'chat:session.ready')?.payload as
          { error?: string } | undefined,
    );
    expect(ready.error).toBeUndefined();
    await waitFor(() => (readFileSync(argvFile, 'utf8').length > 0 ? true : undefined));
    expect(readFileSync(argvFile, 'utf8')).not.toContain('--patch');

    // A prompt still streams committed-only (no tap, no transcript).
    socket.receive('chat:message.send', {
      sessionId: 'sess-ab',
      prompt: [{ type: 'text', text: 'ab' }],
    });
    await waitFor(() =>
      socket.chatEvents().find((e) => e.kind === 'message_delta' && e.delta === 'echo: ab'),
    );
    const closeAck = vi.fn();
    socket.receive('chat:session.close', { sessionId: 'sess-ab', reason: 'user' }, closeAck);
    expect(closeAck).toHaveBeenCalledWith({ closed: true });
  }, 15000);
});

describe('session config (9 W9 A)', () => {
  function waitFor<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const tick = (): void => {
        const v = fn();
        if (v !== undefined) return resolve(v);
        if (Date.now() - started > ms) return reject(new Error('waitFor: timeout'));
        setTimeout(tick, 20);
      };
      tick();
    });
  }

  it('takeConfigOptions keeps only select rows and nulls on junk', async () => {
    const { takeConfigOptions, takeSessionConfig } = await import('../src/daemon/chat.js');
    expect(takeConfigOptions('nope')).toBeNull();
    expect(takeConfigOptions([])).toBeNull();
    const kept = takeConfigOptions([
      {
        id: 'model',
        name: 'Model',
        type: 'select',
        currentValue: 'm1',
        options: [{ value: 'm1', name: 'M1' }],
      },
      { id: 'telemetry', name: 'Telemetry', type: 'boolean', currentValue: 'true' },
      { junk: true },
    ]);
    expect(kept).not.toBeNull();
    expect(kept!.map((o) => o.id)).toEqual(['model']);
    expect(
      takeSessionConfig({
        modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Manual' }] },
      }),
    ).toEqual({
      modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Manual' }] },
      options: [],
    });
    expect(takeSessionConfig({})).toBeNull();
    expect(takeSessionConfig({ configOptions: [{ id: 'x', name: 'X', type: 'select' }] })).toEqual({
      options: [{ id: 'x', name: 'X' }],
    });
  });

  it('9 W13 — takeConfigOptions FLATTENS nested grouped options (dsh shape)', async () => {
    const { takeConfigOptions } = await import('../src/daemon/chat.js');
    const kept = takeConfigOptions([
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: '["harness-nexus","m1"]',
        options: [
          {
            group: 'deepseek-official',
            name: 'DeepSeek',
            options: [
              { value: '["deepseek-official","m-off"]', name: 'Official' },
              {
                group: 'nested-extra',
                name: 'Nested',
                options: [{ value: '["deepseek-official","m-deep"]', name: 'Deep' }],
              },
            ],
          },
          {
            group: 'harness-nexus',
            name: 'volcengine',
            options: [{ value: '["harness-nexus","m1"]', name: 'M1' }],
          },
        ],
      },
    ]);
    expect(kept).not.toBeNull();
    expect(kept!.length).toBe(1);
    expect(kept![0]!.options).toEqual([
      { value: '["deepseek-official","m-off"]', name: 'Official', group: 'deepseek-official' },
      { value: '["deepseek-official","m-deep"]', name: 'Deep', group: 'nested-extra' },
      { value: '["harness-nexus","m1"]', name: 'M1', group: 'harness-nexus' },
    ]);
  });

  it('mapAcpUpdate maps the config pushes as PATCH events (capture path)', () => {
    expect(
      mapAcpUpdate({ update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' } }),
    ).toEqual({
      kind: 'session_config',
      modes: { currentModeId: 'plan' },
    });
    expect(mapAcpUpdate({ update: { sessionUpdate: 'current_mode_update' } })).toBeNull();
    expect(
      mapAcpUpdate({
        update: {
          sessionUpdate: 'config_option_update',
          configOptions: [
            { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select' },
          ],
        },
      }),
    ).toEqual({
      kind: 'session_config',
      configOptions: [{ id: 'effort', name: 'Effort', category: 'thought_level' }],
    });
  });

  it('establishment snapshot → ready caps → config.set round-trip → pushes merge', async () => {
    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_HERMES: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
      spawnEnv: {
        FIXTURE_SESSION_CONFIG: '1',
        FIXTURE_IMAGE_CAPS: '1',
        FIXTURE_SESSION_ID: 'fx-cfg',
      },
      homeDir: LEDGER_HOME,
    });
    socket.receive('chat:session.start', {
      sessionId: 'sess-cfg',
      agentInstanceId: 'ag-1',
      target: 'hermes',
      cwd: '/tmp',
    });

    const ready = await waitFor(
      () =>
        socket.emitted.find((e) => e.event === 'chat:session.ready')?.payload as
          { error?: string; promptCapabilities?: { image: boolean } } | undefined,
    );
    expect(ready.error).toBeUndefined();
    expect(ready.promptCapabilities).toEqual({ image: true });

    // The establishment snapshot arrives as a FULL session_config event
    // (modes + the three select options; the boolean telemetry row dropped).
    const snapshot = await waitFor(() =>
      socket.chatEvents().find((e) => e.kind === 'session_config'),
    );
    if (snapshot.kind !== 'session_config') throw new Error('not a config event');
    expect(snapshot.modes?.currentModeId).toBe('default');
    expect(snapshot.configOptions?.map((o) => o.id)).toEqual(['mode', 'model', 'effort']);

    // Mode switch: the daemon forwards set_mode; the fixture confirms via a
    // current_mode_update push, which the daemon merges into a FULL snapshot.
    const modeAck = vi.fn();
    socket.receive(
      'chat:config.set',
      { sessionId: 'sess-cfg', kind: 'mode', modeId: 'acceptEdits' },
      modeAck,
    );
    await waitFor(() => (modeAck.mock.calls.length > 0 ? true : undefined));
    expect(modeAck).toHaveBeenCalledWith({ accepted: true });
    const afterMode = await waitFor(() => {
      const configs = socket.chatEvents().filter((e) => e.kind === 'session_config');
      const last = configs[configs.length - 1];
      return last !== undefined &&
        last.kind === 'session_config' &&
        last.modes?.currentModeId === 'acceptEdits'
        ? last
        : undefined;
    });
    if (afterMode.kind !== 'session_config') throw new Error('unreachable');
    expect(afterMode.modes?.availableModes?.map((m) => m.id)).toEqual([
      'default',
      'acceptEdits',
      'plan',
    ]);

    // Option switch: the fixture's config_option_update REPLACES the option
    // list; the daemon re-emits the merged snapshot.
    const optAck = vi.fn();
    socket.receive(
      'chat:config.set',
      { sessionId: 'sess-cfg', kind: 'option', configId: 'model', value: 'fx-sonnet' },
      optAck,
    );
    await waitFor(() => (optAck.mock.calls.length > 0 ? true : undefined));
    expect(optAck).toHaveBeenCalledWith({ accepted: true });
    const afterOpt = await waitFor(() => {
      const configs = socket.chatEvents().filter((e) => e.kind === 'session_config');
      const last = configs[configs.length - 1];
      return last !== undefined &&
        last.kind === 'session_config' &&
        last.configOptions?.some((o) => o.id === 'model' && o.currentValue === 'fx-sonnet')
        ? last
        : undefined;
    });
    if (afterOpt.kind !== 'session_config') throw new Error('unreachable');
    expect(afterOpt.configOptions?.map((o) => o.id)).toEqual(['model']);

    // Unknown session → error ack.
    const badAck = vi.fn();
    socket.receive('chat:config.set', { sessionId: 'nope', kind: 'mode', modeId: 'x' }, badAck);
    expect(badAck).toHaveBeenCalledWith({ error: 'unknown-session' });
    const protoAck = vi.fn();
    socket.receive('chat:config.set', { kind: 'mode' }, protoAck);
    expect(protoAck).toHaveBeenCalledWith({ error: 'proto:invalid' });
  }, 15000);

  it('9 W13 — modelOptions narrows the model row on establish AND on re-push (codex)', async () => {
    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      // The adapter command is just an env override — driving the FIXTURE as
      // `codex` exercises the target-keyed rewrite without a real codex.
      env: { HN_ACP_COMMAND_CODEX: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
      spawnEnv: { FIXTURE_SESSION_CONFIG: '1', FIXTURE_SESSION_ID: 'fx-w13' },
      homeDir: LEDGER_HOME,
    });
    socket.receive('chat:session.start', {
      sessionId: 'sess-w13',
      agentInstanceId: 'ag-1',
      target: 'codex',
      cwd: '/tmp',
      modelOptions: ['fx-sonnet'],
    });

    await waitFor(() => socket.emitted.find((e) => e.event === 'chat:session.ready')?.payload);
    // Establishment snapshot: the model row keeps only fx-sonnet, with the
    // out-of-list currentValue (fx-opus) appended verbatim; other rows whole.
    const snapshot = await waitFor(() =>
      socket.chatEvents().find((e) => e.kind === 'session_config'),
    );
    if (snapshot.kind !== 'session_config') throw new Error('not a config event');
    expect(snapshot.configOptions?.map((o) => o.id)).toEqual(['mode', 'model', 'effort']);
    const modelRow = snapshot.configOptions?.find((o) => o.id === 'model');
    expect(modelRow?.options?.map((o) => o.value)).toEqual(['fx-sonnet', 'fx-opus']);
    expect(modelRow?.currentValue).toBe('fx-opus');

    // After a set, the fixture re-pushes its FULL option list — the rewrite
    // must ride the push too or the built-ins come back mid-session.
    const optAck = vi.fn();
    socket.receive(
      'chat:config.set',
      { sessionId: 'sess-w13', kind: 'option', configId: 'model', value: 'fx-sonnet' },
      optAck,
    );
    await waitFor(() => (optAck.mock.calls.length > 0 ? true : undefined));
    const afterOpt = await waitFor(() => {
      const configs = socket.chatEvents().filter((e) => e.kind === 'session_config');
      const last = configs[configs.length - 1];
      return last !== undefined &&
        last.kind === 'session_config' &&
        last.configOptions?.some((o) => o.id === 'model' && o.currentValue === 'fx-sonnet')
        ? last
        : undefined;
    });
    if (afterOpt.kind !== 'session_config') throw new Error('unreachable');
    const pushed = afterOpt.configOptions?.find((o) => o.id === 'model');
    expect(pushed?.options?.map((o) => o.value)).toEqual(['fx-sonnet']);
  }, 15000);

  it('an image prompt block passes through verbatim and echoes', async () => {
    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_HERMES: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
      spawnEnv: { FIXTURE_IMAGE_CAPS: '1' },
      homeDir: LEDGER_HOME,
    });
    socket.receive('chat:session.start', {
      sessionId: 'sess-img',
      agentInstanceId: 'ag-1',
      target: 'hermes',
      cwd: '/tmp',
    });
    await waitFor(
      () =>
        socket.emitted.find((e) => e.event === 'chat:session.ready')?.payload as
          { promptCapabilities?: { image: boolean } } | undefined,
    );
    const ack = vi.fn();
    socket.receive(
      'chat:message.send',
      {
        sessionId: 'sess-img',
        prompt: [
          { type: 'text', text: 'look ' },
          { type: 'image', data: 'aGk=', mimeType: 'image/png' },
        ],
      },
      ack,
    );
    expect(ack).toHaveBeenCalledWith({ accepted: true });
    await waitFor(() =>
      socket
        .chatEvents()
        .find((e) => e.kind === 'message_delta' && e.delta === 'echo: look [image]'),
    );
  }, 15000);
});

describe('adapter report (9 W11 C)', () => {
  function waitFor<T>(fn: () => T | undefined, ms = 8000): Promise<T> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = (): void => {
        const v = fn();
        if (v !== undefined) return resolve(v);
        if (Date.now() - started > ms) return reject(new Error('waitFor: timeout'));
        setTimeout(tick, 20);
      };
      tick();
    });
  }

  it('answers from the LIVE sessions map (pgid, native id, command, uptime base)', async () => {
    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_HERMES: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
      homeDir: LEDGER_HOME,
    });
    socket.receive('chat:session.start', {
      sessionId: 'sess-rep',
      agentInstanceId: 'ag-1',
      target: 'hermes',
      cwd: '/tmp',
    });
    const ready = (await waitFor(
      () =>
        socket.emitted.find(
          (e) =>
            e.event === 'chat:session.ready' &&
            (e.payload as { sessionId?: string }).sessionId === 'sess-rep',
        )?.payload,
    )) as { error?: string };
    expect(ready.error).toBeUndefined();

    const ack = vi.fn();
    socket.receive('adapters:report', { requestId: 'req-1' }, ack);
    expect(ack).toHaveBeenCalledWith({ accepted: true });
    const result = socket.emitted.find((e) => e.event === 'adapters:report:result')?.payload as {
      requestId: string;
      adapters: {
        wireSessionId: string;
        target: string;
        pgid: number;
        nativeSessionId: string;
        startedAt: number;
        command: string;
      }[];
    };
    expect(result.requestId).toBe('req-1');
    expect(result.adapters).toHaveLength(1);
    expect(result.adapters[0]).toMatchObject({
      wireSessionId: 'sess-rep',
      target: 'hermes',
      command: 'node',
      nativeSessionId: expect.any(String),
      startedAt: expect.any(Number),
    });
    expect(result.adapters[0]!.pgid).toBeGreaterThan(0);

    // Gone from the map → gone from the report (present-tense truth).
    socket.receive('chat:session.close', { sessionId: 'sess-rep', reason: 'user' });
    await waitFor(() => (socket.eventsOf('chat:session.closed').length > 0 ? true : undefined));
    const ack2 = vi.fn();
    socket.receive('adapters:report', { requestId: 'req-2' }, ack2);
    const second = socket.emitted.filter((e) => e.event === 'adapters:report:result').at(-1)
      ?.payload as { requestId: string; adapters: unknown[] };
    expect(second.requestId).toBe('req-2');
    expect(second.adapters).toHaveLength(0);
  }, 15000);

  it('rejects a malformed report request', async () => {
    const socket = new FakeSocket();
    attachChatHandlers(socket as never, {
      env: { HN_ACP_COMMAND_HERMES: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
      homeDir: LEDGER_HOME,
    });
    const ack = vi.fn();
    socket.receive('adapters:report', {}, ack);
    expect(ack).toHaveBeenCalledWith({ error: 'proto:invalid' });
    expect(socket.emitted.filter((e) => e.event === 'adapters:report:result')).toHaveLength(0);
  });
});
