#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

// Fake pi coding agent speaking the `--mode rpc` JSONL dialect (Phase 9 W16).
//
// The contract mirrors the REAL pi surface the daemon's PiRpcConnection
// façade rides (pi.dev/docs/latest/rpc): LF-delimited JSON over stdio;
// commands carry {type, id, …} and responses echo the id
// ({type:'response', id, success:true, …payload} | success:false + error);
// events ({type:'message_update' | 'tool_execution_*' | 'message_end' |
// 'agent_settled' | …}) flow interleaved. pi has NO handshake — the daemon
// probes with get_state.
//
// Prompt-message keywords select the scripted turn:
//   'fail-turn' → the prompt is NACKed (success:false + error; turn error)
//   'use-tool'  → text deltas + a read-tool execution + usage + settled
//   'think'     → thinking deltas + text + settled
//   'bash'      → bash_execution_update stream + settled
//   'hang'      → acked but never settles (waits for abort)
//   default     → two text deltas + usage + settled
// `abort` responds once idle AND emits agent_settled (what real pi does when
// the in-flight generation stops) — exercising the cancelled-turn release.

import { setTimeout as delay } from 'node:timers/promises';

const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
// rig-verified envelope (pi 0.85.1): {id, type:'response', command, success,
// data} — the payload lives under `data`; failures carry a root `error`.
const respond = (id, command, payload = {}, error = null) =>
  send(
    error === null
      ? { type: 'response', id, command, success: true, data: payload }
      : { type: 'response', id, command, success: false, error },
  );

const FIXTURE_SESSION_ID = process.env.PI_FIXTURE_SESSION_ID ?? 'pi-fixture-uuid';

const models = [
  { provider: 'harness-nexus', id: 'gw-large', name: 'gw-large' },
  { provider: 'harness-nexus', id: 'gw-mini', name: 'gw-mini' },
  { provider: 'anthropic', id: 'builtin-sonnet', name: 'claude-sonnet' },
];

function turn(message) {
  if (message.includes('fail-turn')) {
    return null; // caller NACKs instead
  }
  if (message.includes('use-tool')) {
    send({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Let me check ' },
    });
    send({
      type: 'tool_execution_start',
      toolCallId: 't1',
      tool: 'read',
      arguments: { path: '/tmp/x' },
    });
    send({ type: 'tool_execution_update', toolCallId: 't1', partialResult: 'reading…' });
    send({
      type: 'tool_execution_end',
      toolCallId: 't1',
      result: { output: [{ type: 'text', text: 'file body' }] },
    });
    send({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'done' },
    });
    send({
      type: 'message_end',
      message: { role: 'assistant', usage: { inputTokens: 12, outputTokens: 34 } },
    });
    send({ type: 'agent_settled' });
    return true;
  }
  if (message.includes('think')) {
    send({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'hmm' },
    });
    send({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: 'thoughtful answer' },
    });
    send({ type: 'message_end', message: { role: 'assistant', usage: { input: 5, output: 7 } } });
    send({ type: 'agent_settled' });
    return true;
  }
  if (message.includes('bash')) {
    send({ type: 'bash_execution_update', id: 'bash-1', delta: '$ ls\nfile' });
    send({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'listed' },
    });
    send({ type: 'agent_settled' });
    return true;
  }
  if (message.includes('hang')) {
    return true; // acked; nothing until abort
  }
  send({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Hello' },
  });
  send({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: ' there' },
  });
  send({
    type: 'message_end',
    message: { role: 'assistant', usage: { inputTokens: 3, outputTokens: 5 } },
  });
  send({ type: 'agent_settled' });
  return true;
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl = buf.indexOf('\n');
  while (nl !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line !== '') void handle(line);
    nl = buf.indexOf('\n');
  }
});

async function handle(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // noise — mirror pi's tolerance
  }
  const { type, id, ...params } = msg;
  switch (type) {
    case 'get_state': {
      if (Number(process.env.PI_FIXTURE_SLOW_START ?? 0) > 0) {
        await delay(Number(process.env.PI_FIXTURE_SLOW_START));
      }
      respond(id, type, {
        state: {
          model: { provider: 'harness-nexus', id: 'gw-large' },
          thinkingLevel: 'medium',
          isStreaming: false,
          sessionName: 'fixture',
        },
      });
      return;
    }
    case 'get_session_stats':
      respond(id, type, { sessionId: FIXTURE_SESSION_ID, messageCount: 2 });
      return;
    case 'get_available_models':
      respond(id, type, { models });
      return;
    case 'get_available_thinking_levels':
      respond(id, type, { levels: ['off', 'low', 'medium', 'high'] });
      return;
    case 'get_commands':
      respond(id, type, {
        commands: [{ name: 'review', description: 'Review the diff' }, { name: 'deploy' }],
      });
      return;
    case 'new_session':
      respond(id, type);
      return;
    case 'switch_session': {
      // rig-verified: switch_session takes `sessionPath` (the session FILE's
      // absolute path). An id-shaped param dies exactly like real pi:
      // "Cannot read properties of undefined (reading 'startsWith')".
      if (typeof params.sessionPath !== 'string' || params.sessionPath === '') {
        respond(id, type, null, "Cannot read properties of undefined (reading 'startsWith')");
      } else {
        respond(id, type, { cancelled: false });
      }
      return;
    }
    case 'set_model':
    case 'set_thinking_level':
      respond(id, type);
      return;
    case 'prompt': {
      const ok = turn(String(params.message ?? ''));
      if (ok === null) respond(id, 'prompt', null, 'pi prompt rejected: no auth for this model');
      else respond(id, type); // the ACK — the turn settles via agent_settled
      return;
    }
    case 'abort':
      respond(id, type);
      // Real pi answers abort once idle; the generation stops → the turn
      // settles. Emitting settled here releases the held ACP response with
      // stopReason 'cancelled' (the façade's abortRequested flag).
      send({ type: 'agent_settled' });
      return;
    default:
      respond(id, type, null, `fixture pi does not implement '${type}'`);
  }
}

process.stdin.resume();
process.on('SIGTERM', () => process.exit(0));
