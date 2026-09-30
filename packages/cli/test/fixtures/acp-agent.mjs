#!/usr/bin/env node
/**
 * Fixture ACP agent (Phase 8 C5 tests + smoke; 9 W7 adds sessions). Speaks
 * ACP v1 — JSON-RPC 2.0, newline-delimited — over stdio:
 *
 *   initialize → {protocolVersion: 1, agentInfo, agentCapabilities}
 *                (advertises sessionCapabilities list+load+resume+close unless
 *                 FIXTURE_ACP_NO_LOAD=1 → resume only, the dsh shape)
 *   session/new → {sessionId, cwd}
 *   session/list → one canned native session (9 W7)
 *   session/load → REPLAYS one prior turn as session/update notifications
 *                  (user_message_chunk + agent_message_chunk + a completed
 *                  tool_call), then responds {sessionId} (the claude shape)
 *   session/resume → {} with NO replay (the dsh shape)
 *   session/prompt →
 *     prompt containing 'ask-permission':
 *        session/request_permission (a REQUEST, answered by the client) →
 *        allow_*: tool_call completed + "permission granted: <optionId>" → end_turn
 *        reject_* or cancelled: tool_call failed + "denied" → end_turn
 *     prompt containing 'ask-user' (9 W14.1):
 *        elicitation/create (a REQUEST, form mode) → the client's response is
 *        echoed as "elicitation answered: <json>" → end_turn
 *     any other prompt: one thought chunk + one text chunk (echo) + usage → end_turn
 *   session/cancel → the pending prompt resolves {stopReason: 'cancelled'}
 *   session/close → {}
 *
 * FIXTURE_TAP_SPEAKER=1 (9 W7.1): emulate the hnx dsh tap PLUGIN — dial the
 *   daemon's HNX_TAP_PORT/HNX_TAP_TOKEN listener, say hello, and replay
 *   canned session-event-BUS rows during a plain echo turn (deltas during
 *   generation, a streamed-step commit, then turn/end AFTER the wire
 *   settles). Tests must pin FIXTURE_SESSION_ID — the daemon filters tap
 *   events by the acp session id.
 *
 * FIXTURE_CONTEXT=1 (#26): usage_update also carries the context OCCUPANCY
 *   (`used`/`size`, the way the claude wrapper reports it), which is what the
 *   Sender's context meter renders. FIXTURE_CONTEXT_USED / _SIZE override the
 *   default 34,100 / 200,000 — the rig uses the env pair to park the meter in
 *   its warn (>80%) and danger (>95%) tones.
 *
 * The daemon tests drive it via HN_ACP_COMMAND_<TARGET>="node <this file>".
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { createInterface } from 'node:readline';

// 9 W7 leak regression: tests point FIXTURE_PID_FILE here to observe that the
// daemon KILLS this process when establishment fails (stdin-end exit alone is
// NOT the kill path being asserted).
if (process.env.FIXTURE_PID_FILE) {
  try {
    appendFileSync(process.env.FIXTURE_PID_FILE, `${process.pid}\n`);
  } catch {
    /* best effort */
  }
}

// 9 W7.1: tests point FIXTURE_ARGV_FILE here to observe HOW the daemon
// composed the command line (the tap appends `--patch <yml>`; the A/B switch
// must not).
if (process.env.FIXTURE_ARGV_FILE) {
  try {
    appendFileSync(process.env.FIXTURE_ARGV_FILE, `${process.argv.join(' ')}\n`);
  } catch {
    /* best effort */
  }
}

// ---- 9 W7.1 tap-speaker: the plugin's protocol, canned ----

let tapSock = null;
let tapReady = false;

if (process.env.FIXTURE_TAP_SPEAKER === '1') {
  const port = Number(process.env.HNX_TAP_PORT);
  const token = process.env.HNX_TAP_TOKEN;
  if (Number.isInteger(port) && port > 0 && token) {
    const s = netConnect(port, '127.0.0.1');
    tapSock = s;
    s.on('connect', () => {
      tapReady = true;
      s.write(`${JSON.stringify({ type: 'hello', token, pid: process.pid })}\n`);
    });
    s.on('error', () => {});
  }
}

/** One bus event for `sessionId` — verbatim SessionEvent envelope. */
function tapEvent(sessionId, event) {
  if (!tapReady || tapSock === null) return;
  try {
    tapSock.write(`${JSON.stringify({ type: 'event', sessionId, event })}\n`);
  } catch {
    /* best effort */
  }
}

/**
 * The tap-speaker echo turn: bus deltas stream DURING generation (incl. one
 * SUBAGENT session's event the daemon must filter out), the commit for the
 * already-streamed step carries only usage, the wire settles, and the bus
 * `turn/end` lands ~150ms AFTER the wire — the daemon must wait for it
 * before turn_result (the settle-from-tap contract).
 */
function runTapSpeakerTurn(id, text, finish) {
  const sid = process.env.FIXTURE_SESSION_ID || 'fx-session';
  tapEvent(sid, {
    type: 'assistant/chunk',
    seq: 1,
    time: 1,
    data: { turn: 1, step: 0, chunk: { type: 'text-delta', text: 'tap-流式-1 ' } },
  });
  tapEvent('fx-subagent-session', {
    type: 'assistant/chunk',
    seq: 1,
    time: 1,
    data: { turn: 1, step: 0, chunk: { type: 'text-delta', text: 'SUBAGENT-NOISE' } },
  });
  setTimeout(() => {
    tapEvent(sid, {
      type: 'assistant/chunk',
      seq: 2,
      time: 2,
      data: { turn: 1, step: 0, chunk: { type: 'text-delta', text: 'tap-流式-2' } },
    });
  }, 150);
  setTimeout(() => {
    // Commit of the streamed step: the mapper must NOT re-render its blocks.
    tapEvent(sid, {
      type: 'assistant/message',
      seq: 3,
      time: 3,
      data: {
        turn: 1,
        step: 0,
        message: { content: [{ type: 'text', text: 'tap-COMMIT-text' }] },
        usage: { inputTokens: 5, outputTokens: 9 },
      },
    });
    // The wire's committed chunks arrive NOW (the daemon suppresses the
    // message/thought ones — the tap already streamed this turn) and the
    // prompt response settles the wire.
    notify('session/update', {
      sessionId: sid,
      update: {
        sessionUpdate: 'agent_thought_chunk',
        contentBlock: { type: 'text', text: 'committed-thought' },
      },
    });
    notify('session/update', {
      sessionId: sid,
      update: {
        sessionUpdate: 'agent_message_chunk',
        contentBlock: { type: 'text', text: `echo: ${text}` },
      },
    });
    update(sid, 'usage_update');
    finish('end_turn');
  }, 300);
  setTimeout(() => {
    tapEvent(sid, {
      type: 'turn/end',
      seq: 4,
      time: 4,
      data: { turn: 1, reason: { kind: 'completed' } },
    });
  }, 450);
}

/** Pending permission waiters: jsonrpc request id → (outcome) => void */
const permissionWaiters = new Map();
/** Pending elicitation waiters (9 W14.1): jsonrpc id → (response) => void */
const elicitationWaiters = new Map();
/** In-flight prompt ids — session/cancel resolves all of them as 'cancelled'. */
const promptIds = new Set();

// #44 — cumulative accumulators for the FIXTURE_RESPONSE_USAGE dialect: each
// turn adds these per-turn amounts, and both the prompt response's usage and
// the usage_update cost read the CUMULATIVE totals (claude-wrapper shape).
const fixtureState = {
  accumulatedInput: 0,
  accumulatedOutput: 0,
  accumulatedCacheRead: 0,
  accumulatedCacheWrite: 0,
  accumulatedCostUsd: 0,
};

let nextId = 1;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: data ? { code, message, data } : { code, message } });
}

function update(sessionId, sessionUpdate) {
  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate,
      // #44: two dialects. Default = the dsh/pi style (per-turn token counts
      // on the usage_update itself). FIXTURE_RESPONSE_USAGE=1 = the claude
      // style — usage_update carries occupancy (and cost) only, tokens ride
      // the session/prompt RESPONSE as cumulative totals.
      ...(sessionUpdate === 'usage_update' &&
      process.env.FIXTURE_RESPONSE_USAGE !== '1'
        ? { usage: { inputTokens: 11, outputTokens: 7 } }
        : {}),
      ...(sessionUpdate === 'usage_update' && process.env.FIXTURE_RESPONSE_USAGE === '1'
        ? { cost: { amount: fixtureState.accumulatedCostUsd, currency: 'USD' } }
        : {}),
      // Occupancy, the way dsh reports it: FLAT on the update (`used`/`size`;
      // the daemon maps exactly those two). The Sender's context meter renders
      // them, so a rig that wants to see the meter (ring, bar, details) turns
      // it on with FIXTURE_CONTEXT=1 — off by default, so the turn-usage
      // assertions in chat.test.ts keep seeing exactly two fields.
      ...(sessionUpdate === 'usage_update' && process.env.FIXTURE_CONTEXT === '1'
        ? {
            used: Number(process.env.FIXTURE_CONTEXT_USED ?? '34100'),
            size: Number(process.env.FIXTURE_CONTEXT_SIZE ?? '200000'),
          }
        : {}),
    },
  });
}

/** session/update with an envelope `_meta` (Claude toolName rides there). */
function updateMeta(sessionId, sessionUpdate, meta) {
  notify('session/update', {
    sessionId,
    update: sessionUpdate,
    _meta: meta,
  });
}

/**
 * `show-tools` prompt: a full turn exercising the 9 W6 rich cards — a Read
 * (rawOutput body), a Bash (rawInput + output), an Edit (structured diff),
 * markdown + a code fence, then usage → end_turn.
 */
function runToolShowcase(id, sessionId) {
  const finish = () => {
    update(sessionId, 'usage_update');
    respond(id, { stopReason: 'end_turn' });
  };

  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      contentBlock: { type: 'text', text: 'Inspecting the workspace first.\n\n' },
    },
  });

  updateMeta(
    sessionId,
    {
      sessionUpdate: 'tool_call',
      toolCallUpdate: {
        toolCallId: 'fx-read-1',
        title: 'src/app.ts',
        kind: 'read',
        status: 'in_progress',
      },
    },
    { claudeCode: { toolName: 'Read' } },
  );
  updateMeta(
    sessionId,
    {
      sessionUpdate: 'tool_call_update',
      toolCallUpdate: {
        toolCallId: 'fx-read-1',
        title: 'src/app.ts',
        kind: 'read',
        status: 'completed',
        rawOutput: [
          '1\timport { main } from "./lib.js";',
          '2',
          '3\t// entry point',
          '4\tawait main();',
          '5',
        ].join('\n'),
      },
    },
    { claudeCode: { toolName: 'Read' } },
  );

  updateMeta(
    sessionId,
    {
      sessionUpdate: 'tool_call',
      toolCallUpdate: {
        toolCallId: 'fx-bash-1',
        title: 'npm test',
        kind: 'execute',
        status: 'in_progress',
        rawInput: { command: 'npm test', description: 'run the test suite' },
      },
    },
    { claudeCode: { toolName: 'Bash' } },
  );
  updateMeta(
    sessionId,
    {
      sessionUpdate: 'tool_call_update',
      toolCallUpdate: {
        toolCallId: 'fx-bash-1',
        status: 'completed',
        rawOutput: '> harness-nexus@0.1.0 test\n> vitest run\n\n ✓ 99 passed (99)',
      },
    },
    { claudeCode: { toolName: 'Bash' } },
  );

  updateMeta(
    sessionId,
    {
      sessionUpdate: 'tool_call',
      toolCallUpdate: {
        toolCallId: 'fx-edit-1',
        title: 'src/app.ts',
        kind: 'edit',
        status: 'in_progress',
      },
    },
    { claudeCode: { toolName: 'Edit' } },
  );
  updateMeta(
    sessionId,
    {
      sessionUpdate: 'tool_call_update',
      toolCallUpdate: {
        toolCallId: 'fx-edit-1',
        status: 'completed',
        content: [
          {
            type: 'diff',
            path: 'src/app.ts',
            oldText: '// entry point\nawait main();',
            newText: '// entry point (hardened)\nawait main({ retries: 2 });',
          },
        ],
      },
    },
    { claudeCode: { toolName: 'Edit' } },
  );

  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      contentBlock: {
        type: 'text',
        text: [
          'All green. **Summary**:',
          '',
          '- `Read` found the entry point',
          '- `Bash` ran the suite — 99 passing',
          '- `Edit` hardened the bootstrap',
          '',
          '```ts',
          'await main({ retries: 2 });',
          '```',
        ].join('\n'),
      },
    },
  });
  finish();
}

/**
 * `show-plan` prompt (9 W14): a turn riding PLAN snapshots the way
 * claude-agent-acp emits them — full-replace lists, TodoWrite-style, with
 * the in_progress row carrying its activeForm text. No tool calls at all:
 * the wrapper SUPPRESSES TodoWrite/Task* as tool calls on purpose.
 */
function runPlanShowcase(id, sessionId) {
  const plan = (entries) =>
    notify('session/update', {
      sessionId,
      update: { sessionUpdate: 'plan', entries },
    });
  const finish = () => {
    update(sessionId, 'usage_update');
    respond(id, { stopReason: 'end_turn' });
  };

  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      contentBlock: { type: 'text', text: 'Laying out the steps first.\n\n' },
    },
  });
  plan([
    { content: 'Survey the workspace layout', status: 'pending', priority: 'high' },
    { content: 'Implement the panel', status: 'pending' },
    { content: 'Verify against the fold', status: 'pending' },
  ]);
  plan([
    { content: 'Survey the workspace layout', status: 'completed', priority: 'high' },
    { content: 'Implementing the panel…', status: 'in_progress' },
    { content: 'Verify against the fold', status: 'pending' },
  ]);
  plan([
    { content: 'Survey the workspace layout', status: 'completed', priority: 'high' },
    { content: 'Implement the panel', status: 'completed' },
    { content: 'Verifying against the fold…', status: 'in_progress' },
  ]);
  plan([
    { content: 'Survey the workspace layout', status: 'completed', priority: 'high' },
    { content: 'Implement the panel', status: 'completed' },
    { content: 'Verify against the fold', status: 'completed' },
  ]);
  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      contentBlock: { type: 'text', text: 'All steps complete.' },
    },
  });
  finish();
}

function runPrompt(id, text, deferred = false) {
  const sessionId = 'fx-session'; // single-session fixture; content is what matters
  const finish = (stopReason) => {
    promptIds.delete(id);
    // FIXTURE_RESPONSE_USAGE=1 (#44): the claude-wrapper dialect — the
    // session/prompt RESPONSE carries session-CUMULATIVE token usage
    // (input/output + cached read/write) while usage_update stays
    // occupancy-only.
    const usage =
      process.env.FIXTURE_RESPONSE_USAGE === '1'
        ? {
            inputTokens: fixtureState.accumulatedInput,
            outputTokens: fixtureState.accumulatedOutput,
            cachedReadTokens: fixtureState.accumulatedCacheRead,
            cachedWriteTokens: fixtureState.accumulatedCacheWrite,
          }
        : undefined;
    respond(id, { stopReason, ...(usage !== undefined ? { usage } : {}) });
  };
  promptIds.add(id);
  fixtureState.accumulatedInput += 100;
  fixtureState.accumulatedOutput += 20;
  fixtureState.accumulatedCacheRead += 500;
  fixtureState.accumulatedCacheWrite += 50;
  fixtureState.accumulatedCostUsd = Math.round((fixtureState.accumulatedCostUsd + 0.012) * 1000) / 1000;

  // Test seam: hold the plain echo turn so a test can append transcript
  // frames DURING generation (the dsh live-tail streaming path).
  const delay = Number(process.env.FIXTURE_DELAY_PROMPT_MS ?? '0');
  if (!deferred && delay > 0) {
    setTimeout(() => runPrompt(id, text, true), delay);
    return;
  }

  if (text.includes('please error with detail')) {
    // codex-acp's dialect: the real reason rides in `error.data.message`
    // while the top-level message is a generic "Internal error".
    promptIds.delete(id);
    respondError(id, -32603, 'Internal error', {
      message:
        'stream disconnected before completion: error sending request for url (https://example.test/v3/responses)',
      codex_error_info: 'other',
    });
    return;
  }

  if (text.includes('please error')) {
    // A PROTOCOL error (like claude-code's "Authentication required" on
    // prompt): the request fails, the process stays alive.
    promptIds.delete(id);
    respondError(id, -32000, 'Authentication required');
    return;
  }

  if (text.includes('show-tools')) {
    runToolShowcase(id, sessionId);
    return;
  }

  if (text.includes('show-plan')) {
    runPlanShowcase(id, sessionId);
    return;
  }

  if (text.includes('ask-permission')) {
    // 'ask-permission string-id' → a UUID request id (codex-acp's dialect).
    // The daemon must echo it VERBATIM: a Number() coercion sends id:null and
    // the response never matches, so the turn hangs forever.
    const permId = text.includes('string-id') ? randomUUID() : nextId++;
    const toolCallId = `tool-${randomUUID().slice(0, 8)}`;
    send({
      jsonrpc: '2.0',
      id: permId,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall: { toolCallId, title: 'fixture: echo', kind: 'execute' },
        options: [
          { optionId: 'allow_always', name: 'Allow', kind: 'allow_always' },
          { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
        ],
      },
    });
    permissionWaiters.set(permId, (outcome) => {
      permissionWaiters.delete(permId);
      const allowed =
        outcome?.outcome === 'selected' && String(outcome.optionId).startsWith('allow');
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallUpdate: {
              toolCallId,
              title: 'fixture: echo',
              kind: 'execute',
              status: allowed ? 'completed' : 'failed',
            },
          },
        },
      });
      notify('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          contentBlock: {
            type: 'text',
            text: allowed ? `permission granted: ${outcome.optionId}` : 'denied',
          },
        },
      });
      finish('end_turn');
    });
    return;
  }

  // 9 W14.1 — prompt containing 'ask-user': send a real `elicitation/create`
  // REQUEST (the claude-agent-acp dialect: top-level method, form mode) and
  // echo the client's response as the turn's message. Exercises the daemon's
  // handler, the wire event, and the respond round trip.
  if (text.includes('ask-user')) {
    const elId = nextId++;
    send({
      jsonrpc: '2.0',
      id: elId,
      method: 'elicitation/create',
      params: {
        mode: 'form',
        sessionId,
        toolCallId: `call-${randomUUID().slice(0, 8)}`,
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
            question_0_custom: { type: 'string', title: 'Other' },
            question_1: { type: 'boolean', title: 'Verbose' },
            question_2: { type: 'integer', title: 'Count' },
          },
        },
      },
    });
    elicitationWaiters.set(elId, (response) => {
      elicitationWaiters.delete(elId);
      notify('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          contentBlock: { type: 'text', text: `elicitation answered: ${JSON.stringify(response)}` },
        },
      });
      finish('end_turn');
    });
    return;
  }

  if (tapReady) {
    runTapSpeakerTurn(id, text, finish);
    return;
  }

  // codex-acp dialect: an unknown gateway model id is announced by streaming a
  // DIAGNOSTIC as an assistant chunk. The daemon drops it (not model output).
  if (text.includes('metadata-notice')) {
    notify('session/update', {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        contentBlock: {
          type: 'text',
          text:
            'Model metadata for `gw-model-x` not found. Defaulting to fallback metadata; ' +
            'this can degrade performance and cause issues.',
        },
      },
    });
  }

  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'agent_thought_chunk',
      contentBlock: { type: 'text', text: 'thinking about it' },
    },
  });
  notify('session/update', {
    sessionId,
    update: {
      sessionUpdate: 'agent_message_chunk',
      contentBlock: { type: 'text', text: `echo: ${text}` },
    },
  });
  update(sessionId, 'usage_update');
  finish('end_turn');
}

/** 9 W9 A — the advertised session-config surface (claude-shaped). */
function fixtureSessionConfig() {
  return {
    modes: {
      currentModeId: 'default',
      availableModes: [
        { id: 'default', name: 'Manual', description: 'Always ask before making changes' },
        { id: 'acceptEdits', name: 'Accept edits' },
        { id: 'plan', name: 'Plan' },
      ],
    },
    configOptions: [
      {
        id: 'mode',
        name: 'Mode',
        category: 'mode',
        type: 'select',
        currentValue: 'default',
        options: [
          { value: 'default', name: 'Manual' },
          { value: 'acceptEdits', name: 'Accept edits' },
        ],
      },
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'fx-opus',
        options: [
          { value: 'fx-opus', name: 'Fixture Opus' },
          { value: 'fx-sonnet', name: 'Fixture Sonnet' },
        ],
      },
      {
        id: 'effort',
        name: 'Effort',
        category: 'thought_level',
        type: 'select',
        currentValue: 'default',
        options: [
          { value: 'default', name: 'Default' },
          { value: 'high', name: 'High' },
        ],
      },
      // A non-select row the daemon must DROP, not surface.
      {
        id: 'telemetry',
        name: 'Telemetry',
        category: 'model_config',
        type: 'boolean',
        currentValue: 'true',
      },
    ],
  };
}

function handleRequest(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      // FIXTURE_NO_INIT=1 — emulate a wrapper that never completes the
      // handshake (e.g. npx dying on a corrupted cache): one stderr line as
      // the diagnostic breadcrumb, and NO response. Tests drive start()
      // with a short initializeTimeoutMs.
      if (process.env.FIXTURE_NO_INIT === '1') {
        process.stderr.write('fixture stderr diagnostic: initialize will hang\n');
        return;
      }
      respond(id, {
        protocolVersion: 1,
        agentInfo: { name: 'fixture-agent', version: '0.1.0' },
        authMethods: [],
        agentCapabilities: {
          // 9 W9 B — FIXTURE_IMAGE_CAPS=1 flips the image capability (dsh
          // derives it per model route; false must disable the attach UI).
          promptCapabilities: {
            image: process.env.FIXTURE_IMAGE_CAPS === '1',
            audio: false,
            embeddedContext: true,
          },
          sessionCapabilities:
            process.env.FIXTURE_ACP_NO_LOAD === '1'
              ? { list: {}, resume: {}, close: {} } // the dsh shape — no replay
              : { list: {}, load: {}, resume: {}, close: {} },
        },
      });
      return;
    case 'session/new': {
      // FIXTURE_SESSION_ID pins the id so tests can pre-create the dsh
      // transcript directory for the live-tail streaming path.
      // FIXTURE_DELAY_NEW_MS widens the establishment window so tests can send
      // a close WHILE session/new is still in flight (the daemon must abort).
      // FIXTURE_SESSION_CONFIG=1 (9 W9 A) advertises modes + configOptions on
      // the establishment responses (the claude/codex/dsh shape).
      const sid = process.env.FIXTURE_SESSION_ID || `fx-${randomUUID().slice(0, 8)}`;
      const answer = () =>
        respond(id, {
          sessionId: sid,
          cwd: params?.cwd ?? process.cwd(),
          ...(process.env.FIXTURE_SESSION_CONFIG === '1' ? fixtureSessionConfig() : {}),
        });
      const newDelay = Number(process.env.FIXTURE_DELAY_NEW_MS ?? '0');
      if (newDelay > 0) setTimeout(answer, newDelay);
      else answer();
      // FIXTURE_COMMANDS=1 (9 W15): push a command catalog after the response,
      // the way the real adapters do (claude/codex defer it well past the
      // reply — early pushes would race the daemon's establishment wiring).
      if (process.env.FIXTURE_COMMANDS === '1') {
        setTimeout(() => {
          notify('session/update', {
            sessionId: sid,
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: [
                {
                  name: 'deploy',
                  description: 'Deploy the current profile',
                  input: { hint: 'profile name' },
                },
                { name: 'mcp:status', description: 'MCP server status' },
              ],
            },
          });
        }, 250);
      }
      return;
    }
    case 'session/list':
      respond(id, {
        sessions: [
          {
            sessionId: 'fx-native-1',
            // A REAL path — the daemon spawns the resume at this cwd, so a
            // canned path that doesn't exist would fail with ENOENT.
            cwd: '/tmp',
            title: 'fixture: prior turn',
            updatedAt: new Date().toISOString(),
          },
        ],
      });
      return;
    case 'session/load': {
      // The claude/codex shape: replay the prior turn BEFORE responding.
      const sid = params?.sessionId ?? 'fx-native-1';
      if (sid === 'fx-native-fail') {
        // Establishment failure (the dsh pinned-model class) — the daemon
        // must surface the error AND kill this adapter process.
        respondError(
          id,
          -32603,
          'Internal error: pi-ai provider "harness-nexus" has no configured model "deepseek-chat"',
        );
        return;
      }
      notify('session/update', {
        sessionId: sid,
        update: {
          sessionUpdate: 'user_message_chunk',
          contentBlock: { type: 'text', text: 'what did we conclude?' },
        },
      });
      notify('session/update', {
        sessionId: sid,
        update: {
          sessionUpdate: 'agent_message_chunk',
          contentBlock: { type: 'text', text: 'We concluded: 42 (replayed).' },
        },
      });
      updateMeta(
        sid,
        {
          sessionUpdate: 'tool_call',
          toolCallUpdate: {
            toolCallId: 'fx-replay-tool',
            title: 'notes.txt',
            kind: 'read',
            status: 'completed',
            rawOutput: '42',
          },
        },
        { claudeCode: { toolName: 'Read' } },
      );
      // 9 W9 A — a replayed config push (the capture path maps it to a
      // session_config PATCH; the response snapshot below then wins).
      if (process.env.FIXTURE_SESSION_CONFIG === '1') {
        notify('session/update', {
          sessionId: sid,
          update: { sessionUpdate: 'current_mode_update', currentModeId: 'acceptEdits' },
        });
      }
      respond(id, {
        sessionId: sid,
        ...(process.env.FIXTURE_SESSION_CONFIG === '1' ? fixtureSessionConfig() : {}),
      });
      return;
    }
    case 'session/resume':
      // The dsh shape: restores the log WITHOUT replaying old updates.
      respond(id, process.env.FIXTURE_SESSION_CONFIG === '1' ? fixtureSessionConfig() : {});
      return;
    case 'session/set_mode':
      // 9 W9 A — apply, then confirm via the standard push (the live-path
      // interception the daemon must exercise).
      notify('session/update', {
        sessionId: params?.sessionId ?? 'fx-session',
        update: { sessionUpdate: 'current_mode_update', currentModeId: params?.modeId },
      });
      respond(id, {});
      return;
    case 'session/set_config_option':
      notify('session/update', {
        sessionId: params?.sessionId ?? 'fx-session',
        update: {
          sessionUpdate: 'config_option_update',
          configOptions: [
            {
              id: params?.configId,
              name: 'Model',
              category: 'model',
              type: 'select',
              currentValue: params?.value,
              options: [
                { value: 'fx-opus', name: 'Fixture Opus' },
                { value: 'fx-sonnet', name: 'Fixture Sonnet' },
              ],
            },
          ],
        },
      });
      respond(id, {});
      return;
    case 'session/prompt': {
      const prompt = Array.isArray(params?.prompt) ? params.prompt : [];
      const text = prompt
        .map((b) =>
          b.type === 'text' ? b.text : b.type === 'image' ? '[image]' : `[@${b.name ?? 'x'}]`,
        )
        .join('');
      runPrompt(id, text);
      return;
    }
    case 'session/cancel':
      for (const pid of [...promptIds]) {
        promptIds.delete(pid);
        respond(pid, { stopReason: 'cancelled' });
      }
      respond(id, {});
      return;
    case 'session/close':
      respond(id, {});
      return;
    default:
      respondError(id, -32601, `method not found: ${method}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (trimmed === '') return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  if (
    msg.id !== undefined &&
    msg.id !== null &&
    (msg.result !== undefined || msg.error !== undefined)
  ) {
    // A response — to our session/request_permission. The ACP result shape is
    // { outcome: { outcome: 'selected'|'cancelled', optionId? } }.
    const waiter = permissionWaiters.get(msg.id);
    if (waiter) {
      const result = msg.result ?? {};
      waiter(result.outcome ?? { outcome: 'cancelled' });
      return;
    }
    // …or to our elicitation/create (9 W14.1): the result IS the response
    // ({action:'accept',content} | {action:'decline'} | {action:'cancel'}).
    const elWaiter = elicitationWaiters.get(msg.id);
    if (elWaiter) {
      elWaiter(msg.result ?? { action: 'cancel' });
    }
    return;
  }
  if (msg.method === undefined) return;
  if (msg.method === 'initialized') return; // notification
  if (msg.id === undefined || msg.id === null) return; // other notifications: ignore
  handleRequest(msg);
});

process.stdin.on('end', () => process.exit(0));
