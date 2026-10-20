// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachChatHandlers } from '../src/daemon/chat.js';
import {
  flattenPiPrompt,
  piEventToAcpUpdate,
  piModelRef,
  resolvePiCommand,
} from '../src/daemon/acp/pi-connection.js';
import { rewriteSessionConfigOptions } from '../src/daemon/model-options.js';
import type { ChatStreamEvent } from '@harness-nexus/shared';

/**
 * The pi ACP façade (Phase 9 W16): pure dialect mappers, the W13 model-option
 * rewrite for pi, and full round-trips against the fixture pi agent
 * (test/fixtures/pi-rpc-agent.mjs) through a fake socket — the same path the
 * daemon takes in production. pi has no permissions and no elicitations:
 * those arms simply never fire (tested by the round-trip's silence).
 */

const FIXTURE = new URL('./fixtures/pi-rpc-agent.mjs', import.meta.url).pathname;

class FakeSocket {
  emitted: { event: string; payload: unknown }[] = [];
  handlers = new Map<string, (payload: unknown, ack?: (res: unknown) => void) => void>();

  emit(event: string, payload: unknown): boolean {
    this.emitted.push({ event, payload });
    return true;
  }

  on(event: string, handler: (payload: unknown, ack?: (res: unknown) => void) => void): this {
    this.handlers.set(event, handler);
    return this;
  }

  receive(event: string, payload: unknown): void {
    this.handlers.get(event)?.(payload, () => {});
  }

  chatEvents(): ChatStreamEvent[] {
    return this.emitted
      .filter((e) => e.event === 'chat:event')
      .map((e) => (e.payload as { event: ChatStreamEvent }).event);
  }
}

function waitFor<T>(fn: () => T | undefined | false, ms = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      // Only a truthy-or-object result counts — `some()` returning false must
      // keep waiting (undefined/false are both "not yet").
      const v = fn();
      if (v !== undefined && v !== false) return resolve(v as T);
      if (Date.now() - started > ms) return reject(new Error('waitFor: timeout'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('pi dialect mappers (pure)', () => {
  it('maps text/thinking deltas, tool executions, bash, and usage', () => {
    // rig-verified shape (pi 0.85.1): the delta rides `assistantMessageEvent`
    expect(
      piEventToAcpUpdate({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hi' },
      }),
    ).toEqual({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi' } });
    expect(
      piEventToAcpUpdate({
        type: 'message_update',
        assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'hm' },
      }),
    ).toEqual({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hm' } });
    // the pre-verification `update` spelling stays as a cushion
    expect(
      piEventToAcpUpdate({ type: 'message_update', update: { type: 'text_delta', delta: 'Hi' } }),
    ).toEqual({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi' } });
    expect(
      piEventToAcpUpdate({
        type: 'tool_execution_start',
        toolCallId: 't1',
        tool: 'read',
        arguments: { path: '/x' },
      }),
    ).toEqual({
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'read',
      rawInput: '{"path":"/x"}',
    });
    expect(
      piEventToAcpUpdate({
        type: 'tool_execution_end',
        toolCallId: 't1',
        result: { output: [{ type: 'text', text: 'body' }] },
      }),
    ).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      content: [{ type: 'text', text: 'body' }],
      status: 'completed',
    });
    expect(piEventToAcpUpdate({ type: 'bash_execution_update', id: 'b1', delta: '$ ls' })).toEqual({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'b1',
      content: [{ type: 'text', text: '$ ls' }],
    });
    expect(
      piEventToAcpUpdate({
        type: 'message_end',
        message: { role: 'assistant', usage: { inputTokens: 2, outputTokens: 4 } },
      }),
    ).toEqual({ sessionUpdate: 'usage_update', usage: { inputTokens: 2, outputTokens: 4 } });
    // alt usage spellings (rig-pending cushion)
    expect(
      piEventToAcpUpdate({ type: 'message_end', message: { usage: { input: 1, output: 2 } } }),
    ).toEqual({ sessionUpdate: 'usage_update', usage: { inputTokens: 1, outputTokens: 2 } });
  });

  it('drops lifecycle events and unshapely rows (never fatal)', () => {
    expect(piEventToAcpUpdate({ type: 'agent_settled' })).toBeNull();
    expect(piEventToAcpUpdate({ type: 'turn_start' })).toBeNull();
    expect(piEventToAcpUpdate({ type: 'message_update', update: {} })).toBeNull();
    expect(piEventToAcpUpdate(null)).toBeNull();
  });

  it('flattens ACP prompt blocks onto pi message + images', () => {
    expect(
      flattenPiPrompt([
        { type: 'text', text: 'read ' },
        { type: 'resource_link', name: 'notes', uri: 'file:///tmp/notes.md' },
        { type: 'text', text: ' please' },
        { type: 'image', data: 'BASE64==' },
      ]),
    ).toEqual({
      message: 'read [@notes](file:///tmp/notes.md) please',
      images: ['BASE64=='],
    });
  });

  it('builds provider/id model refs and resolves the spawn command', () => {
    expect(piModelRef({ provider: 'harness-nexus', id: 'gw-large' })).toBe(
      'harness-nexus/gw-large',
    );
    expect(piModelRef('bare-id')).toBe('bare-id');
    expect(piModelRef({ name: 'no id' })).toBeNull();
    expect(resolvePiCommand({})).toEqual({ command: 'pi', args: ['--mode', 'rpc'] });
    expect(resolvePiCommand({ HN_ACP_COMMAND_PI: 'node /tmp/fake.mjs --flag' })).toEqual({
      command: 'node',
      args: ['/tmp/fake.mjs', '--flag'],
    });
  });

  it('W13 rewrite intersects pi model options to the configured set', () => {
    const options = [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        currentValue: 'harness-nexus/gw-large',
        options: [
          { value: 'harness-nexus/gw-large', name: 'gw-large' },
          { value: 'harness-nexus/gw-mini', name: 'gw-mini' },
          { value: 'anthropic/builtin-sonnet', name: 'claude-sonnet' },
        ],
      },
    ];
    const rewritten = rewriteSessionConfigOptions(options, {
      target: 'pi',
      modelOptions: ['gw-large'],
    });
    expect(rewritten[0]!.options).toEqual([{ value: 'harness-nexus/gw-large', name: 'gw-large' }]);
    // empty intersection → untouched (hand-managed install is the honest state)
    expect(
      rewriteSessionConfigOptions(options, { target: 'pi', modelOptions: ['other-model'] })[0]!
        .options,
    ).toHaveLength(3);
  });
});

// ---- integration round-trips (fixture pi over the façade) ----

let home: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'hnx-pi-chat-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function attach(socket: FakeSocket): void {
  attachChatHandlers(socket as never, {
    env: { HN_ACP_COMMAND_PI: `node ${FIXTURE}`, PATH: process.env.PATH ?? '' },
    homeDir: home,
  });
}

const openNew = (socket: FakeSocket, sessionId: string): void => {
  socket.receive('chat:session.start', {
    sessionId,
    agentInstanceId: 'ag-pi',
    target: 'pi',
    cwd: home,
  });
};

describe('pi chat round-trip', () => {
  it('establishes with the fixture session id, config options, and command catalog', async () => {
    const socket = new FakeSocket();
    attach(socket);
    openNew(socket, 'sess-pi-1');

    const ready = await waitFor(() => socket.emitted.find((e) => e.event === 'chat:session.ready'));
    const payload = ready!.payload as {
      nativeSessionId?: string;
      promptCapabilities?: { image?: boolean };
      error?: string;
    };
    expect(payload.error).toBeUndefined();
    expect(payload.nativeSessionId).toBe('pi-fixture-uuid');
    expect(payload.promptCapabilities?.image).toBe(true);

    // config snapshot (model + thinking rows) reaches the stream…
    await waitFor(() => socket.chatEvents().some((e) => e.kind === 'session_config'));
    const config = socket.chatEvents().find((e) => e.kind === 'session_config') as {
      kind: 'session_config';
      configOptions?: { id: string; options?: { value: string }[] }[];
    };
    const modelRow = config.configOptions?.find((o) => o.id === 'model');
    expect(modelRow?.options?.map((o) => o.value)).toEqual([
      'harness-nexus/gw-large',
      'harness-nexus/gw-mini',
      'anthropic/builtin-sonnet',
    ]);
    // …and the W15 command catalog rides an available_commands_update
    await waitFor(() => socket.chatEvents().some((e) => e.kind === 'commands'));
    const commands = socket.chatEvents().find((e) => e.kind === 'commands') as {
      commands: { name: string }[];
    };
    expect(commands.commands.map((c) => c.name)).toEqual(['review', 'deploy']);
  });

  it('runs a tool turn: deltas, tool cards, usage, and turn_result at settle', async () => {
    const socket = new FakeSocket();
    attach(socket);
    openNew(socket, 'sess-pi-2');
    await waitFor(() => socket.emitted.find((e) => e.event === 'chat:session.ready'));

    socket.receive('chat:message.send', {
      sessionId: 'sess-pi-2',
      prompt: [{ type: 'text', text: 'use-tool please' }],
    });
    await waitFor(() => socket.chatEvents().some((e) => e.kind === 'turn_result'));

    const kinds = socket.chatEvents();
    expect(kinds.some((e) => e.kind === 'message_delta' && e.delta === 'Let me check ')).toBe(true);
    expect(kinds.some((e) => e.kind === 'message_delta' && e.delta === 'done')).toBe(true);
    const tool = kinds.find((e) => e.kind === 'tool_call') as {
      call: { toolCallId: string; title?: string; status?: string };
    };
    expect(tool?.call.toolCallId).toBe('t1');
    expect(tool?.call.title).toBe('read');
    expect(kinds.some((e) => e.kind === 'usage')).toBe(true);
    const turn = kinds.find((e) => e.kind === 'turn_result') as { stopReason: string };
    expect(turn.stopReason).toBe('end_turn');
  });

  it('maps a NACKed prompt to a prompt-error note and a settled turn', async () => {
    const socket = new FakeSocket();
    attach(socket);
    openNew(socket, 'sess-pi-3');
    await waitFor(() => socket.emitted.find((e) => e.event === 'chat:session.ready'));

    socket.receive('chat:message.send', {
      sessionId: 'sess-pi-3',
      prompt: [{ type: 'text', text: 'fail-turn' }],
    });
    await waitFor(() => socket.chatEvents().some((e) => e.kind === 'turn_result'));
    const raw = socket
      .chatEvents()
      .find(
        (e) => e.kind === 'raw' && (e as { method?: string }).method === 'hnx/prompt-error',
      ) as { params?: { message?: string } };
    expect(raw?.params?.message).toContain('no auth');
  });

  it('cancels a hanging turn (abort → agent_settled → cancelled)', async () => {
    const socket = new FakeSocket();
    attach(socket);
    openNew(socket, 'sess-pi-4');
    await waitFor(() => socket.emitted.find((e) => e.event === 'chat:session.ready'));

    socket.receive('chat:message.send', {
      sessionId: 'sess-pi-4',
      prompt: [{ type: 'text', text: 'hang forever' }],
    });
    await waitFor(() =>
      socket.chatEvents().some((e) => e.kind === 'session_status' && e.state === 'active'),
    );
    socket.receive('chat:turn.cancel', { sessionId: 'sess-pi-4' });
    const turn = (await waitFor(() =>
      socket.chatEvents().find((e) => e.kind === 'turn_result'),
    )) as { stopReason: string };
    expect(turn.stopReason).toBe('cancelled');
  });

  it('resumes with file-replayed history (the session/load arm)', async () => {
    const store = path.join(home, '.pi', 'agent', 'sessions', '--w--');
    mkdirSync(store, { recursive: true });
    const lines = [
      {
        type: 'session',
        version: 3,
        id: 'uuid-9',
        timestamp: '2026-09-17T10:00:00.000Z',
        cwd: home,
      },
      {
        type: 'message',
        id: 'a1',
        parentId: null,
        message: { role: 'user', content: [{ type: 'text', text: 'past question' }] },
      },
      {
        type: 'message',
        id: 'a2',
        parentId: 'a1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'past answer' }] },
      },
    ];
    writeFileSync(
      path.join(store, '20260917-100000_uuid-9.jsonl'),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
      'utf8',
    );

    const socket = new FakeSocket();
    attach(socket);
    socket.receive('chat:session.start', {
      sessionId: 'sess-pi-5',
      agentInstanceId: 'ag-pi',
      target: 'pi',
      cwd: home,
      resume: { sessionId: 'uuid-9', cwd: home },
    });
    const ready = await waitFor(() => socket.emitted.find((e) => e.event === 'chat:session.ready'));
    expect((ready!.payload as { error?: string }).error).toBeUndefined();

    const history = await waitFor(() => socket.emitted.find((e) => e.event === 'chat:history'));
    const items = (history!.payload as { items: unknown[] }).items;
    expect(JSON.stringify(items)).toContain('past question');
    expect(JSON.stringify(items)).toContain('past answer');
  });

  it('fails honestly when the resumed session file does not exist', async () => {
    const socket = new FakeSocket();
    attach(socket);
    socket.receive('chat:session.start', {
      sessionId: 'sess-pi-6',
      agentInstanceId: 'ag-pi',
      target: 'pi',
      cwd: home,
      resume: { sessionId: 'no-such-session', cwd: home },
    });
    const ready = await waitFor(() => socket.emitted.find((e) => e.event === 'chat:session.ready'));
    expect((ready!.payload as { error?: string }).error).toContain('not found');
  });
});
