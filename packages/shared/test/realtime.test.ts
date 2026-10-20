// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
  chatChannelViewSchema,
  chatChannelsCloseAllRequestSchema,
  chatChannelsPushSchema,
  appHandshakeAuthSchema,
  chatConfigSetRequestSchema,
  chatMessageSendRequestSchema,
  chatPermissionRespondRequestSchema,
  chatElicitationRespondRequestSchema,
  chatPromptEventSchema,
  chatSessionOpenRequestSchema,
  chatSessionReadyEventSchema,
  chatSessionStartEventSchema,
  chatStreamEventEnvelopeSchema,
  chatStreamEventSchema,
  ctlHandshakeAuthSchema,
  acpPermissionOptionSchema,
  jobDispatchEventSchema,
  jobProgressEventSchema,
  machineHelloAckSchema,
  machineHelloSchema,
  machineStatusEventSchema,
  nativeSessionViewSchema,
  sessionsListRequestSchema,
} from '../src/realtime.js';

describe('realtime handshake schemas', () => {
  it('accepts a /ctl handshake with token + machineId', () => {
    expect(ctlHandshakeAuthSchema.parse({ token: 'hnpat_x', machineId: 'm1' })).toEqual({
      token: 'hnpat_x',
      machineId: 'm1',
    });
  });

  it('rejects a /ctl handshake missing machineId', () => {
    expect(ctlHandshakeAuthSchema.safeParse({ token: 'hnpat_x' }).success).toBe(false);
  });

  it('accepts a /app handshake with just a token', () => {
    expect(appHandshakeAuthSchema.parse({ token: 'jwt-or-pat' })).toEqual({
      token: 'jwt-or-pat',
    });
  });
});

describe('machine:hello', () => {
  it('parses and defaults capabilities to []', () => {
    const parsed = machineHelloSchema.parse({ daemonVersion: '0.1.0' });
    expect(parsed.capabilities).toEqual([]);
    expect(parsed.daemonVersion).toBe('0.1.0');
  });

  it('parses a full hello', () => {
    const parsed = machineHelloSchema.parse({
      daemonVersion: '0.1.0',
      os: 'linux',
      arch: 'x64',
      hostname: 'laptop',
      capabilities: ['deploy'],
    });
    expect(parsed.hostname).toBe('laptop');
    expect(parsed.capabilities).toEqual(['deploy']);
  });

  it('rejects an empty daemonVersion', () => {
    expect(machineHelloSchema.safeParse({ daemonVersion: '' }).success).toBe(false);
  });

  it('ack shape round-trips', () => {
    expect(machineHelloAckSchema.parse({ proto: 1, machineId: 'm1' })).toEqual({
      proto: 1,
      machineId: 'm1',
    });
  });
});

describe('machine:status push', () => {
  it('accepts online with a null lastSeenAt', () => {
    expect(
      machineStatusEventSchema.safeParse({ machineId: 'm1', online: true, lastSeenAt: null })
        .success,
    ).toBe(true);
  });

  it('rejects a missing online flag', () => {
    expect(machineStatusEventSchema.safeParse({ machineId: 'm1', lastSeenAt: null }).success).toBe(
      false,
    );
  });
});

describe('job envelopes (v0, handlers land in C4)', () => {
  const job = {
    id: 'j1',
    machineId: 'm1',
    ownerId: 'u1',
    type: 'deploy',
    status: 'queued',
    payload: { profileId: 'p1' },
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };

  it('job:dispatch parses a full Job view', () => {
    expect(jobDispatchEventSchema.parse({ job })).toMatchObject({ job: { id: 'j1' } });
  });

  it('rejects an unknown job type', () => {
    expect(jobDispatchEventSchema.safeParse({ job: { ...job, type: 'nope' } }).success).toBe(false);
  });

  it('job progress percent stays within 0–100', () => {
    expect(
      jobProgressEventSchema.safeParse({ jobId: 'j1', phase: 'plan', percent: 150 }).success,
    ).toBe(false);
    expect(
      jobProgressEventSchema.safeParse({ jobId: 'j1', phase: 'plan', percent: 50 }).success,
    ).toBe(true);
  });
});

describe('chat stream schemas (C5)', () => {
  it('accepts every semantic event kind', () => {
    const events = [
      { kind: 'message_delta', delta: 'hello ' },
      { kind: 'thought_delta', delta: 'thinking…' },
      { kind: 'tool_call', call: { toolCallId: 't1', kind: 'edit', status: 'in_progress' } },
      { kind: 'usage', inputTokens: 10, outputTokens: 5 },
      {
        kind: 'permission_request',
        requestId: 'r1',
        toolCall: { toolCallId: 't1', title: 'run tool' },
        options: [
          { optionId: 'allow_always', name: 'Allow', kind: 'allow_always' },
          { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' },
        ],
      },
      {
        kind: 'permission_resolved',
        requestId: 'r1',
        outcome: 'selected',
        optionId: 'allow_always',
      },
      { kind: 'turn_result', stopReason: 'end_turn' },
      { kind: 'session_status', state: 'active' },
      { kind: 'raw', method: 'session/update', params: { sessionUpdate: 'plan' } },
      {
        kind: 'plan',
        entries: [
          { content: 'Survey the layout', status: 'pending', priority: 'high' },
          { content: 'Analyzing dependencies…', status: 'in_progress' },
          { content: 'Write the patch', status: 'completed' },
        ],
      },
      {
        kind: 'commands',
        commands: [
          { name: 'review', description: 'Review my changes', hint: 'focus areas' },
          { name: 'mcp:deploy', description: 'Deploy via MCP' },
        ],
      },
      {
        kind: 'elicitation_request',
        requestId: 'e1',
        message: 'Which color do you prefer?',
        fields: [
          {
            name: 'question_0',
            type: 'enum',
            title: 'Color',
            required: true,
            options: [
              { value: 'Red', label: 'Red', description: 'The color red' },
              { value: 'Blue', label: 'Blue' },
            ],
          },
          { name: 'question_0_custom', type: 'text', title: 'Other' },
          { name: 'question_1', type: 'multi', options: [{ value: 'a' }, { value: 'b' }] },
          { name: 'question_2', type: 'boolean' },
          { name: 'question_3', type: 'integer' },
          { name: 'question_4', type: 'number' },
        ],
        toolCallId: 'call_abc',
      },
      { kind: 'elicitation_request', requestId: 'e2', message: 'Unrepresentable', fields: [] },
      { kind: 'elicitation_resolved', requestId: 'e1', outcome: 'accepted' },
      { kind: 'elicitation_resolved', requestId: 'e2', outcome: 'timeout' },
    ];
    for (const event of events) {
      expect(chatStreamEventSchema.safeParse(event).success, JSON.stringify(event)).toBe(true);
    }
  });

  it('rejects unknown kinds and bad enum values', () => {
    expect(chatStreamEventSchema.safeParse({ kind: 'nope' }).success).toBe(false);
    expect(
      chatStreamEventSchema.safeParse({ kind: 'turn_result', stopReason: 'crashed' }).success,
    ).toBe(false);
    expect(chatStreamEventSchema.safeParse({ kind: 'session_status', state: 'busy' }).success).toBe(
      false,
    );
    // 9 W14.1 — elicitation rejections: unknown field type, bad outcome, an
    // option without a value.
    expect(
      chatStreamEventSchema.safeParse({
        kind: 'elicitation_request',
        requestId: 'e1',
        message: '?',
        fields: [{ name: 'q', type: 'colour' }],
      }).success,
    ).toBe(false);
    expect(
      chatStreamEventSchema.safeParse({
        kind: 'elicitation_resolved',
        requestId: 'e1',
        outcome: 'maybe',
      }).success,
    ).toBe(false);
    expect(
      chatStreamEventSchema.safeParse({
        kind: 'elicitation_request',
        requestId: 'e1',
        message: '?',
        fields: [{ name: 'q', type: 'enum', options: [{ label: 'no value' }] }],
      }).success,
    ).toBe(false);
  });

  it('plan snapshots: empty clears, bad status rejects, entry cap holds (9 W14)', () => {
    expect(chatStreamEventSchema.safeParse({ kind: 'plan', entries: [] }).success).toBe(true);
    expect(
      chatStreamEventSchema.safeParse({ kind: 'plan', entries: [{ content: 'x', status: 'done' }] })
        .success,
    ).toBe(false);
    const tooMany = {
      kind: 'plan' as const,
      entries: Array.from({ length: 129 }, () => ({ content: 'x', status: 'pending' })),
    };
    expect(chatStreamEventSchema.safeParse(tooMany).success).toBe(false);
  });

  it('commands catalogs: empty clears, missing name rejects, cap holds (9 W15)', () => {
    expect(chatStreamEventSchema.safeParse({ kind: 'commands', commands: [] }).success).toBe(true);
    expect(
      chatStreamEventSchema.safeParse({ kind: 'commands', commands: [{ description: 'x' }] })
        .success,
    ).toBe(false);
    const tooMany = {
      kind: 'commands' as const,
      commands: Array.from({ length: 65 }, (_, i) => ({
        name: `cmd-${i}`,
        description: 'x',
      })),
    };
    expect(chatStreamEventSchema.safeParse(tooMany).success).toBe(false);
  });

  it('validates the chat:event envelope wrapping an event', () => {
    expect(
      chatStreamEventEnvelopeSchema.safeParse({
        sessionId: 's1',
        event: { kind: 'turn_result', stopReason: 'cancelled' },
      }).success,
    ).toBe(true);
    expect(
      chatStreamEventEnvelopeSchema.safeParse({ sessionId: 's1', event: { kind: 'x' } }).success,
    ).toBe(false);
  });

  it('permission options keep optionId verbatim and cap the list', () => {
    const option = { optionId: 'weird id with spaces', name: 'x', kind: 'allow_once' };
    expect(acpPermissionOptionSchema.parse(option)).toEqual(option);
    const tooMany = {
      kind: 'permission_request' as const,
      requestId: 'r1',
      toolCall: { toolCallId: 't1' },
      options: Array.from({ length: 9 }, () => ({ ...option })),
    };
    expect(chatStreamEventSchema.safeParse(tooMany).success).toBe(false);
  });
});

describe('chat request schemas (C5)', () => {
  it('open accepts create and re-join forms', () => {
    expect(chatSessionOpenRequestSchema.parse({ agentInstanceId: 'a1' })).toEqual({
      agentInstanceId: 'a1',
    });
    expect(chatSessionOpenRequestSchema.parse({ agentInstanceId: 'a1', sessionId: 's1' })).toEqual({
      agentInstanceId: 'a1',
      sessionId: 's1',
    });
    expect(chatSessionOpenRequestSchema.safeParse({}).success).toBe(false);
  });

  it('message send accepts a string or block array', () => {
    expect(chatMessageSendRequestSchema.parse({ sessionId: 's1', content: 'hi' })).toEqual({
      sessionId: 's1',
      content: 'hi',
    });
    expect(
      chatMessageSendRequestSchema.safeParse({
        sessionId: 's1',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'resource_link', name: 'f', uri: 'file:///f' },
        ],
      }).success,
    ).toBe(true);
    expect(chatMessageSendRequestSchema.safeParse({ sessionId: 's1', content: '' }).success).toBe(
      false,
    );
    expect(chatMessageSendRequestSchema.safeParse({ sessionId: 's1', content: 42 }).success).toBe(
      false,
    );
  });

  it('permission respond treats missing optionId as cancel and keeps it verbatim', () => {
    expect(chatPermissionRespondRequestSchema.parse({ sessionId: 's1', requestId: 'r1' })).toEqual({
      sessionId: 's1',
      requestId: 'r1',
    });
    expect(
      chatPermissionRespondRequestSchema.parse({
        sessionId: 's1',
        requestId: 'r1',
        optionId: 'allow_always',
      }),
    ).toEqual({ sessionId: 's1', requestId: 'r1', optionId: 'allow_always' });
  });

  it('elicitation respond accepts every value shape and rejects junk (9 W14.1)', () => {
    expect(
      chatElicitationRespondRequestSchema.parse({
        sessionId: 's1',
        requestId: 'e1',
        action: 'accept',
        values: {
          question_0: 'Red',
          question_1: ['a', 'b'],
          question_2: true,
          question_3: 7,
        },
      }),
    ).toEqual({
      sessionId: 's1',
      requestId: 'e1',
      action: 'accept',
      values: { question_0: 'Red', question_1: ['a', 'b'], question_2: true, question_3: 7 },
    });
    expect(
      chatElicitationRespondRequestSchema.parse({
        sessionId: 's1',
        requestId: 'e1',
        action: 'decline',
      }),
    ).toEqual({ sessionId: 's1', requestId: 'e1', action: 'decline' });
    // accept without values = an empty form submit; object values are junk.
    expect(
      chatElicitationRespondRequestSchema.safeParse({
        sessionId: 's1',
        requestId: 'e1',
        action: 'accept',
      }).success,
    ).toBe(true);
    expect(
      chatElicitationRespondRequestSchema.safeParse({
        sessionId: 's1',
        requestId: 'e1',
        action: 'accept',
        values: { q: { nested: true } },
      }).success,
    ).toBe(false);
    expect(
      chatElicitationRespondRequestSchema.safeParse({
        sessionId: 's1',
        requestId: 'e1',
        action: 'maybe',
      }).success,
    ).toBe(false);
  });

  it('session start carries target and cwd', () => {
    expect(
      chatSessionStartEventSchema.safeParse({
        sessionId: 's1',
        agentInstanceId: 'a1',
        target: 'hermes',
        cwd: '/home/u/.hermes',
      }).success,
    ).toBe(true);
    expect(
      chatSessionStartEventSchema.safeParse({
        sessionId: 's1',
        agentInstanceId: 'a1',
        target: 'not-a-target',
        cwd: '/x',
      }).success,
    ).toBe(false);
  });

  it('session start carries the optional 9 W13 modelOptions hint', () => {
    expect(
      chatSessionStartEventSchema.parse({
        sessionId: 's1',
        agentInstanceId: 'a1',
        target: 'codex',
        cwd: '/x',
        modelOptions: ['gw-large', 'gw-mini'],
      }),
    ).toEqual({
      sessionId: 's1',
      agentInstanceId: 'a1',
      target: 'codex',
      cwd: '/x',
      modelOptions: ['gw-large', 'gw-mini'],
    });
    // absent stays valid (no stored config / pre-W13 server)
    expect(
      chatSessionStartEventSchema.safeParse({
        sessionId: 's1',
        agentInstanceId: 'a1',
        target: 'codex',
        cwd: '/x',
      }).success,
    ).toBe(true);
    expect(
      chatSessionStartEventSchema.safeParse({
        sessionId: 's1',
        agentInstanceId: 'a1',
        target: 'codex',
        cwd: '/x',
        modelOptions: [''],
      }).success,
    ).toBe(false);
  });
});

describe('chat session config schemas (9 W9 A)', () => {
  it('accepts full and patch session_config events', () => {
    expect(
      chatStreamEventSchema.safeParse({
        kind: 'session_config',
        modes: {
          currentModeId: 'acceptEdits',
          availableModes: [
            { id: 'default', name: 'Manual', description: 'Always ask' },
            { id: 'acceptEdits', name: 'Accept edits' },
          ],
        },
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            currentValue: '["deepseek-official","deepseek-chat"]',
            options: [{ value: '["p","m"]', name: 'm', group: 'p' }],
          },
        ],
      }).success,
    ).toBe(true);
    // A lone currentModeId patch (the current_mode_update mapping).
    expect(
      chatStreamEventSchema.safeParse({
        kind: 'session_config',
        modes: { currentModeId: 'plan' },
      }).success,
    ).toBe(true);
    // An empty value option row (dsh's provider-default reasoning effort).
    expect(
      chatStreamEventSchema.safeParse({
        kind: 'session_config',
        configOptions: [
          {
            id: 'reasoning_effort',
            name: 'Reasoning effort',
            category: 'thought_level',
            currentValue: '',
            options: [{ value: '', name: 'Provider default' }],
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      chatStreamEventSchema.safeParse({ kind: 'session_config', modes: { currentModeId: 7 } })
        .success,
    ).toBe(false);
  });

  it('config set discriminates mode vs option and allows an empty value', () => {
    expect(
      chatConfigSetRequestSchema.parse({ sessionId: 's1', kind: 'mode', modeId: 'auto' }),
    ).toEqual({ sessionId: 's1', kind: 'mode', modeId: 'auto' });
    expect(
      chatConfigSetRequestSchema.parse({
        sessionId: 's1',
        kind: 'option',
        configId: 'reasoning_effort',
        value: '',
      }),
    ).toEqual({ sessionId: 's1', kind: 'option', configId: 'reasoning_effort', value: '' });
    expect(chatConfigSetRequestSchema.safeParse({ sessionId: 's1', kind: 'mode' }).success).toBe(
      false,
    );
    expect(
      chatConfigSetRequestSchema.safeParse({ sessionId: 's1', kind: 'option', configId: 'model' })
        .success,
    ).toBe(false);
  });

  it('ready carries optional prompt capabilities', () => {
    expect(
      chatSessionReadyEventSchema.parse({
        sessionId: 's1',
        promptCapabilities: { image: true, embeddedContext: true },
      }),
    ).toEqual({ sessionId: 's1', promptCapabilities: { image: true, embeddedContext: true } });
    expect(chatSessionReadyEventSchema.parse({ sessionId: 's1' })).toEqual({ sessionId: 's1' });
    expect(
      chatSessionReadyEventSchema.safeParse({ sessionId: 's1', promptCapabilities: {} }).success,
    ).toBe(false);
  });
});

describe('prompt image blocks (9 W9 B)', () => {
  const image = (data: string): { type: 'image'; data: string; mimeType: 'image/png' } => ({
    type: 'image',
    data,
    mimeType: 'image/png',
  });

  it('accepts an image block on the send paths', () => {
    expect(
      chatMessageSendRequestSchema.safeParse({
        sessionId: 's1',
        content: [{ type: 'text', text: 'look' }, image('aGk=')],
      }).success,
    ).toBe(true);
    expect(
      chatPromptEventSchema.safeParse({
        sessionId: 's1',
        prompt: [image('aGk=')],
      }).success,
    ).toBe(true);
    expect(
      chatMessageSendRequestSchema.safeParse({
        sessionId: 's1',
        content: [{ type: 'image', data: 'aGk=', mimeType: 'image/bmp' }],
      }).success,
    ).toBe(false);
  });

  it('caps image count and total payload per turn', () => {
    const four = Array.from({ length: 4 }, () => image('aaaa'));
    const five = [...four, image('aaaa')];
    expect(
      chatPromptEventSchema.safeParse({
        sessionId: 's1',
        prompt: [...four, { type: 'text', text: 'x' }],
      }).success,
    ).toBe(true);
    expect(chatPromptEventSchema.safeParse({ sessionId: 's1', prompt: five }).success).toBe(false);
    const twoBig = [image('a'.repeat(4 * 1024 * 1024)), image('a'.repeat(4 * 1024 * 1024))];
    expect(chatPromptEventSchema.safeParse({ sessionId: 's1', prompt: twoBig }).success).toBe(
      false,
    );
  });
});

describe('nativeSessionViewSchema — timestamp dialects (rig-found 2026-09-14)', () => {
  const row = { sessionId: 's1', cwd: '/root/p', title: 't' };
  it('accepts Z-suffix and +00:00-offset updatedAt alike', () => {
    expect(
      nativeSessionViewSchema.safeParse({ ...row, updatedAt: '2026-09-14T07:32:10.868Z' }).success,
    ).toBe(true);
    // codex-acp (Rust chrono) speaks RFC3339 with an offset — strict datetime
    // used to drop the whole listing and the route timed out silently.
    expect(
      nativeSessionViewSchema.safeParse({ ...row, updatedAt: '2026-09-14T07:32:10.868+00:00' })
        .success,
    ).toBe(true);
  });
  it('still rejects garbage timestamps', () => {
    expect(nativeSessionViewSchema.safeParse({ ...row, updatedAt: 'yesterday' }).success).toBe(
      false,
    );
  });
});

describe('live-channel snapshot schemas (9 W11 B)', () => {
  const channel = {
    sessionId: 'sess-1',
    agentInstanceId: 'agent-1',
    machineId: 'mach-1',
    target: 'codex',
    phase: 'ready',
    busy: true,
    deferred: false,
    nativeSessionId: '01a09f3a-7fae',
    openedAt: 1789378000000,
    lastActiveAt: 1789378060000,
  };
  it('accepts a well-formed channel view and push', () => {
    expect(chatChannelViewSchema.safeParse(channel).success).toBe(true);
    expect(chatChannelsPushSchema.safeParse({ channels: [channel] }).success).toBe(true);
    expect(chatChannelsPushSchema.safeParse({ channels: [] }).success).toBe(true);
  });
  it('rejects an unknown phase and a non-numeric openedAt', () => {
    expect(chatChannelViewSchema.safeParse({ ...channel, phase: 'connected' }).success).toBe(false);
    expect(chatChannelViewSchema.safeParse({ ...channel, openedAt: 'now' }).success).toBe(false);
  });
  it('nativeSessionId is optional (a starting channel has none yet)', () => {
    const { nativeSessionId: _drop, ...without } = channel;
    expect(chatChannelViewSchema.safeParse(without).success).toBe(true);
  });
  it('closeAll takes an empty object, idleOnly, and nothing else', () => {
    expect(chatChannelsCloseAllRequestSchema.safeParse({}).success).toBe(true);
    expect(chatChannelsCloseAllRequestSchema.safeParse({ idleOnly: true }).success).toBe(true);
    expect(chatChannelsCloseAllRequestSchema.safeParse({ force: true }).success).toBe(false);
  });
});

describe('sessions:list cache bypass flag (9 W11 D)', () => {
  it('refresh is optional, boolean, and rejected when non-boolean', () => {
    expect(
      sessionsListRequestSchema.safeParse({ requestId: 'r1', target: 'claude-code' }).success,
    ).toBe(true);
    expect(
      sessionsListRequestSchema.safeParse({
        requestId: 'r1',
        target: 'claude-code',
        refresh: true,
      }).success,
    ).toBe(true);
    expect(
      sessionsListRequestSchema.safeParse({ requestId: 'r1', target: 'codex', refresh: 'yes' })
        .success,
    ).toBe(false);
  });
});
