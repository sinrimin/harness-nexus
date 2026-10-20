// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import * as zlib from 'node:zlib';
import {
  createDshLiveMapper,
  currentSessionLog,
  dshHistoryItems,
  dshListSessions,
  decodeTranscript,
  findTranscript,
  nativeZstd,
  scanSummary,
  splitZstdFrames,
  TranscriptTail,
} from '../src/daemon/dsh-sessions.js';

/**
 * dsh native session store tests (Phase 9 W7; #46 ground truth dsh
 * 0.2.0-rc.2 — session-log generation v4, flat tool results, settlement-only
 * rows, `agent/assistant-stream` frames for token deltas). The frame decoder
 * is injected everywhere so the logic runs on any Node; a real zstd
 * round-trip is additionally exercised when the running Node has the binding
 * (≥ 22.15).
 */

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Build a concatenated "zstd" buffer whose frames are magic-prefixed JSONL. */
function fakeTranscript(entries: unknown[]): Buffer {
  return Buffer.concat(
    entries.map((e) => Buffer.concat([MAGIC, Buffer.from(`${JSON.stringify(e)}\n`)])),
  );
}

/** Test decoder: strips the 4-byte magic, returns the JSONL text. */
const stripMagic = (frame: Buffer): Buffer => frame.subarray(4);

describe('splitZstdFrames', () => {
  it('slices frames at every magic occurrence (a fresh session dir = 1 frame)', () => {
    const buf = Buffer.concat([
      MAGIC,
      Buffer.from('aaaa'),
      MAGIC,
      Buffer.from('bb'),
      MAGIC,
      Buffer.from('c'),
    ]);
    expect(splitZstdFrames(buf)).toHaveLength(3);
    expect(splitZstdFrames(buf)[1]!.subarray(4).toString()).toBe('bb');
    expect(splitZstdFrames(MAGIC)).toHaveLength(1);
    expect(splitZstdFrames(Buffer.alloc(0))).toHaveLength(0);
  });
});

describe('decodeTranscript', () => {
  it('parses every frame, skipping noise lines and undecodable frames', () => {
    const buf = Buffer.concat([
      fakeTranscript([{ type: 'session' }, { type: 'turn/start' }]),
      MAGIC, // a frame the decoder rejects (simulated below via a stub)
      Buffer.from('x'),
    ]);
    const boom = (frame: Buffer): Buffer => {
      if (frame.length <= 4) throw new Error('corrupt frame');
      return frame.subarray(4);
    };
    const entries = decodeTranscript(buf, boom);
    expect(entries.map((e) => e['type'])).toEqual(['session', 'turn/start']);
  });

  it('caps entries so a runaway transcript cannot exhaust memory', () => {
    const buf = fakeTranscript(Array.from({ length: 30 }, (_, i) => ({ seq: i })));
    expect(decodeTranscript(buf, stripMagic, 10)).toHaveLength(10);
  });
});

describe('scanSummary', () => {
  it('reads the header (cwd/createdAt/depth) and the derived title', () => {
    const buf = fakeTranscript([
      {
        type: 'session',
        version: 4,
        id: 's1',
        isSeeded: false,
        cwd: '/root/projects/demo',
        createdAt: 1789008798907,
        delegationDepth: 0,
      },
      { type: 'session/title', data: { title: 'hi' } },
      { type: 'turn/start', data: {} },
    ]);
    const { header, title } = scanSummary(buf, stripMagic);
    expect(header).toMatchObject({
      id: 's1',
      cwd: '/root/projects/demo',
      createdAt: 1789008798907,
      delegationDepth: 0,
    });
    expect(title).toBe('hi');
  });
});

describe('currentSessionLog (generation-versioned discovery)', () => {
  const dir = '/root/.dsh/sessions/--x--/s1';
  const readdirOf =
    (names: string[] | null) =>
    (p: string): string[] => {
      if (p !== dir || names === null) throw new Error('ENOENT');
      return names;
    };

  it('selects the numerically highest canonical generation', () => {
    expect(
      currentSessionLog(dir, readdirOf(['session.jsonl.zstd', 'session.v4.jsonl.zstd'])),
    ).toEqual({ file: `${dir}/session.v4.jsonl.zstd`, generation: 4 });
    // A future v5 is higher still — the daemon reads whatever dsh writes, so a
    // new generation only needs a mapper update, never a discovery change.
    expect(
      currentSessionLog(dir, readdirOf(['session.v4.jsonl.zstd', 'session.v5.jsonl.zstd'])),
    ).toEqual({ file: `${dir}/session.v5.jsonl.zstd`, generation: 5 });
  });

  it('reads a pre-v4-only directory as absent (#46: no back-compat)', () => {
    expect(currentSessionLog(dir, readdirOf(['session.jsonl.zstd']))).toBeNull();
    expect(currentSessionLog(dir, readdirOf(['session.v3.jsonl.zstd']))).toBeNull();
  });

  it('returns the expected current name for a lazily-materialized session dir', () => {
    expect(currentSessionLog(dir, readdirOf([]))).toEqual({
      file: `${dir}/session.v4.jsonl.zstd`,
      generation: 4,
    });
  });

  it('ignores non-canonical names and absent dirs', () => {
    expect(currentSessionLog(dir, readdirOf(['session.tmp', 'session.v0.jsonl']))).toEqual({
      file: `${dir}/session.v4.jsonl.zstd`,
      generation: 4,
    });
    expect(currentSessionLog(dir, readdirOf(null))).toBeNull();
  });
});

describe('dshListSessions', () => {
  const root = '~/.dsh/sessions';

  /** Fake store shaped like the disk: root → slug → session id → { filename: transcript }. */
  function fsFor(
    store: Record<string, Record<string, Record<string, Buffer>>>,
    mtimeMs = 1_789_000_000_000,
  ) {
    const readdir = (p: string): string[] => {
      if (p === root) return Object.keys(store[root] ?? {});
      const rest = p.slice(root.length + 1).split('/');
      if (rest.length === 1) return Object.keys(store[root]?.[rest[0]!] ?? {});
      if (rest.length === 2) return Object.keys(store[root]?.[rest[0]!]?.[rest[1]!] ?? {});
      throw new Error('ENOENT');
    };
    return {
      readdir,
      readFile: (p: string) => {
        const rest = p.slice(root.length + 1).split('/');
        const buf = store[root]?.[rest[0]!]?.[rest[1]!]?.[rest[2]!];
        if (buf === undefined) throw new Error('ENOENT');
        return buf;
      },
      stat: () => ({ mtimeMs }),
    };
  }

  const v4 = (buf: Buffer): Record<string, Buffer> => ({ 'session.v4.jsonl.zstd': buf });

  it('lists ROOT sessions newest-first, skipping subagents and empty (no-turn) sessions', () => {
    // NB: the header entry carries its fields at the TOP level (no `data`).
    const turn = { type: 'agent/inbox/spliced', data: {} };
    const transcript = (header: Record<string, unknown>, extra: unknown[] = []): Buffer =>
      fakeTranscript([{ type: 'session', ...header }, ...extra]);
    const store = {
      [root]: {
        '--root-demo--': {
          'aaa-1': v4(
            transcript({ cwd: '/root/demo', createdAt: 100, delegationDepth: 0 }, [
              { type: 'session/title', data: { title: 'first' } },
              turn,
            ]),
          ),
          'bbb-2': v4(
            transcript({ cwd: '/root/demo', createdAt: 200, delegationDepth: 0 }, [turn]),
          ),
          'ccc-sub': v4(
            transcript({ cwd: '/root/demo', createdAt: 300, delegationDepth: 1 }, [turn]),
          ),
          'ddd-parent': v4(
            transcript(
              {
                cwd: '/root/demo',
                createdAt: 400,
                delegationDepth: 0,
                parentSession: 'aaa-1',
              },
              [turn],
            ),
          ),
          // Header-only artifact (an explicitly flushed empty session): NOT a
          // conversation. The "second unnamed session" of the double-row
          // complaint. Not listed.
          'fff-empty': v4(transcript({ cwd: '/root/demo', createdAt: 500, delegationDepth: 0 })),
          'eee-broken': v4(fakeTranscript([{ type: 'turn/start', data: {} }])),
          // #46 — a pre-v4-only session is unsupported: not listed.
          'ggg-old': { 'session.jsonl.zstd': transcript({ cwd: '/root/demo', createdAt: 600 }) },
          // A migrated session: the historical v0 artifact survives next to the
          // published v4 successor (dsh keeps the source byte-identical) — the
          // CURRENT generation is what we read.
          'hhh-migrated': {
            'session.jsonl.zstd': fakeTranscript([
              { type: 'session', cwd: '/root/demo', createdAt: 700 },
            ]),
            'session.v4.jsonl.zstd': transcript(
              { cwd: '/root/demo', createdAt: 700, delegationDepth: 0 },
              [turn],
            ),
          },
        },
      },
    };
    const fs = fsFor(store);
    const out = dshListSessions(root, fs, stripMagic);
    expect(out.map((s) => s.sessionId)).toEqual(['hhh-migrated', 'bbb-2', 'aaa-1']);
    expect(out[1]).toMatchObject({ sessionId: 'bbb-2', cwd: '/root/demo', title: null });
    expect(out[2]).toMatchObject({ title: 'first', createdAt: new Date(100).toISOString() });
    // Post-W8: sessions with a live channel stay LISTED (the server marks them
    // `open`; the rail offers a rejoin) — no exclusion flag exists anymore.
  });

  it('returns an honest empty list when the store does not exist', () => {
    expect(
      dshListSessions(
        root,
        {
          readdir: () => {
            throw new Error('ENOENT');
          },
          readFile: () => {
            throw new Error('ENOENT');
          },
          stat: () => ({ mtimeMs: 0 }),
        },
        stripMagic,
      ),
    ).toEqual([]);
  });
});

describe('dshHistoryItems', () => {
  it('maps a two-turn transcript: real user inputs, complete blocks, tool pair, turn ends', () => {
    const entries = [
      { type: 'session', version: 4, cwd: '/root/demo', createdAt: 1, delegationDepth: 0 },
      { type: 'permission/preset', data: { preset: 'workspace-write' } },
      {
        type: 'agent/inbox/spliced',
        data: {
          target: 'next-turn',
          start: 0,
          inserted: [
            {
              content: [{ type: 'text', text: 'hi' }],
              source: { kind: 'user' },
              role: 'user',
              id: 'u-1',
            },
          ],
        },
      },
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
      { type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }], id: 'u-1' } },
      {
        type: 'user/message',
        data: { content: [{ type: 'text', text: 'Current runtime context…' }] },
      },
      {
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            content: [
              { type: 'reasoning', text: 'just a greeting' },
              { type: 'text', text: 'Hi there!' },
            ],
          },
        },
      },
      { type: 'step/end', data: { turn: 1, step: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      {
        type: 'agent/inbox/spliced',
        data: {
          inserted: [
            {
              content: [{ type: 'text', text: 'list files' }],
              source: { kind: 'user' },
              role: 'user',
              id: 'u-2',
            },
          ],
        },
      },
      { type: 'turn/start', data: { turn: 2 } },
      {
        type: 'assistant/message',
        data: {
          turn: 2,
          step: 1,
          message: {
            content: [
              { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
            ],
          },
        },
      },
      {
        type: 'tool/call',
        data: { callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
      },
      {
        // v4: a first-class tool-role message — FLAT content, toolCallId on
        // the message (the v0 nesting under source/tool-result is gone).
        type: 'tool/result',
        data: {
          message: {
            role: 'tool',
            toolCallId: 'call-1',
            source: { kind: 'tool', callId: 'call-1' },
            content: [{ type: 'text', text: 'a.txt\nb.txt' }],
          },
        },
      },
      {
        // v4: usage rides the settlement row (the v0 assistant/chunk usage
        // marker is gone).
        type: 'assistant/message',
        data: {
          turn: 2,
          step: 2,
          message: { content: [{ type: 'text', text: 'Two files.' }] },
          usage: { inputTokens: 20, outputTokens: 4 },
        },
      },
      { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
    ];

    const items = dshHistoryItems(entries);
    const shape = items.map((i) => (i.type === 'user' ? 'user' : i.event.kind));
    expect(shape).toEqual([
      'user', // hi
      'thought_delta',
      'message_delta',
      'turn_result',
      'user', // list files
      'tool_call', // from the assistant/message tool-call block
      'tool_call', // from tool/call (same callId — the fold merges)
      'tool_call', // completed + output from tool/result
      'message_delta',
      'usage',
      'turn_result',
    ]);

    expect(items[0]).toEqual({ type: 'user', blocks: [{ type: 'text', text: 'hi' }] });
    const toolEvents = items.filter((i) => i.type === 'event' && i.event.kind === 'tool_call') as {
      event: {
        call: {
          toolCallId: string;
          status?: string;
          output?: string;
          rawInput?: Record<string, unknown>;
          toolName?: string;
        };
      };
    }[];
    const completed = toolEvents.find((e) => e.event.call.status === 'completed')!;
    expect(completed.event.call).toMatchObject({
      toolCallId: 'call-1',
      output: 'a.txt\nb.txt',
    });
    const started = toolEvents.find((e) => e.event.call.rawInput !== undefined)!;
    expect(started.event.call.rawInput).toEqual({ command: 'ls' });
    expect(started.event.call.toolName).toBe('bash');
    expect(
      items.filter(
        (i) =>
          i.type === 'event' &&
          i.event.kind === 'message_delta' &&
          i.event.delta.includes('runtime context'),
      ),
    ).toHaveLength(0); // synthesized context noise never leaks into history
  });

  it('falls back to source.callId when the flat toolCallId is absent', () => {
    const items = dshHistoryItems([
      {
        type: 'tool/result',
        data: {
          message: {
            role: 'tool',
            source: { kind: 'tool', callId: 'call-9' },
            content: [{ type: 'text', text: 'ok' }],
          },
        },
      },
    ]);
    expect(items[0]).toEqual({
      type: 'event',
      event: {
        kind: 'tool_call',
        call: { toolCallId: 'call-9', status: 'completed', output: 'ok' },
      },
    });
  });

  it('maps an aborted turn end (v4 renamed the v0 `cancelled`)', () => {
    const items = dshHistoryItems([{ type: 'turn/end', data: { reason: { kind: 'aborted' } } }]);
    expect(items[0]).toEqual({
      type: 'event',
      event: { kind: 'turn_result', stopReason: 'cancelled' },
    });
  });
});

describe('real zstd round-trip (Node >= 22.15 only)', () => {
  const zstd = nativeZstd();
  const compress = (zlib as unknown as { zstdCompressSync?: (buf: Buffer) => Buffer })
    .zstdCompressSync;
  const maybe = zstd !== null && compress !== undefined ? it : it.skip;

  maybe('decodes a dsh-shaped multi-frame file through the native binding', () => {
    const entries = [
      { type: 'session', version: 4, cwd: '/root/demo', createdAt: 1, delegationDepth: 0 },
      { type: 'session/title', data: { title: 'hello' } },
      {
        type: 'agent/inbox/spliced',
        data: {
          inserted: [
            {
              content: [{ type: 'text', text: 'ping' }],
              source: { kind: 'user' },
              role: 'user',
              id: 'u1',
            },
          ],
        },
      },
    ];
    const buf = Buffer.concat(entries.map((e) => compress(Buffer.from(`${JSON.stringify(e)}\n`))));
    const decoded = decodeTranscript(buf, zstd!);
    expect(decoded.map((e) => e['type'])).toEqual([
      'session',
      'session/title',
      'agent/inbox/spliced',
    ]);
    expect(scanSummary(buf, zstd!).title).toBe('hello');
  });
});

describe('createDshLiveMapper (frames + settlement rows: dsh 0.2.0-rc.2)', () => {
  type Ev = { kind: string; delta?: string; inputTokens?: number; outputTokens?: number };

  /** Drive the mapper with frames and/or settlement rows in order. */
  const run = (...inputs: ({ frame: unknown } | { event: unknown })[]): Ev[] => {
    const mapper = createDshLiveMapper();
    const events: Ev[] = [];
    for (const input of inputs) {
      const out =
        'frame' in input
          ? mapper.frame(input.frame as Record<string, unknown>)
          : mapper.event(input.event as Record<string, unknown>);
      for (const e of out) events.push(e as Ev);
    }
    return events;
  };

  const start = (attemptId: string, turn: number, step: number): { frame: unknown } => ({
    frame: { type: 'start', attemptId, revision: 1, turn, step },
  });
  const delta = (attemptId: string, text: string, kind = 'text-delta'): { frame: unknown } => ({
    frame: {
      type: 'chunk',
      attemptId,
      revision: 2,
      index: 0,
      time: 1,
      chunk: { type: kind, index: 0, text },
    },
  });
  const commit = (
    turn: number,
    step: number,
    text: string,
    usage: unknown = { inputTokens: 5, outputTokens: 2 },
  ): { event: unknown } => ({
    event: {
      type: 'assistant/message',
      seq: 9,
      time: 20,
      data: {
        turn,
        step,
        message: {
          content: [
            { type: 'reasoning', text: 'R' },
            { type: 'text', text },
          ],
        },
        usage,
      },
    },
  });

  it('frame arm: start registers the attempt, chunk deltas map by kind', () => {
    expect(run(start('a:1', 1, 0))).toEqual([]);
    expect(run(start('a:1', 1, 0), delta('a:1', '你好'))).toEqual([
      { kind: 'message_delta', delta: '你好' },
    ]);
    expect(run(start('a:1', 1, 0), delta('a:1', 'hmm', 'reasoning-delta'))).toEqual([
      { kind: 'thought_delta', delta: 'hmm' },
    ]);
    // A chunk frame whose attempt never started still maps (identity only
    // gates the settlement dedup, not the rendering).
    expect(run(delta('never', 'x'))).toEqual([{ kind: 'message_delta', delta: 'x' }]);
  });

  it('frame arm: non-delta chunks and non-chunk frames map to nothing', () => {
    expect(
      run(
        start('a:1', 1, 0),
        {
          frame: {
            type: 'chunk',
            attemptId: 'a:1',
            revision: 2,
            index: 0,
            time: 1,
            chunk: { type: 'block-start', index: 0, blockType: 'text' },
          },
        },
        {
          frame: {
            type: 'chunk',
            attemptId: 'a:1',
            revision: 3,
            index: 1,
            time: 2,
            chunk: { type: 'tool-call-delta', index: 1, id: 'c1', argumentsDelta: '{"a":' },
          },
        },
        {
          frame: {
            type: 'chunk',
            attemptId: 'a:1',
            revision: 4,
            index: 2,
            time: 3,
            chunk: { type: 'usage', usage: { inputTokens: 1 } },
          },
        },
        {
          frame: {
            type: 'chunk',
            attemptId: 'a:1',
            revision: 5,
            index: 3,
            time: 4,
            chunk: { type: 'finish', reason: { kind: 'stop' } },
          },
        },
        {
          frame: {
            type: 'end',
            attemptId: 'a:1',
            revision: 6,
            index: 4,
            outcome: { kind: 'committed', eventType: 'assistant/message', seq: 9 },
          },
        },
      ),
    ).toEqual([]);
  });

  it('settlement: usage only for frame-streamed steps, full blocks otherwise', () => {
    // Step streamed by frames → no text re-send, usage rides through.
    expect(
      run(start('a:1', 1, 0), delta('a:1', 'streamed '), commit(1, 0, 'streamed full')),
    ).toEqual([
      { kind: 'message_delta', delta: 'streamed ' },
      { kind: 'usage', inputTokens: 5, outputTokens: 2 },
    ]);
    // Step the frames NEVER covered (late tap attach) → complete blocks.
    expect(run(commit(1, 1, 'never streamed'))).toEqual([
      { kind: 'thought_delta', delta: 'R' },
      { kind: 'message_delta', delta: 'never streamed' },
      { kind: 'usage', inputTokens: 5, outputTokens: 2 },
    ]);
    // The dedup is per turn:step and one-shot: a second commit for the same
    // step falls back to full blocks.
    expect(
      run(start('a:1', 2, 0), delta('a:1', 'v'), commit(2, 0, 'v full'), commit(2, 0, 'again')),
    ).toEqual([
      { kind: 'message_delta', delta: 'v' },
      { kind: 'usage', inputTokens: 5, outputTokens: 2 },
      { kind: 'thought_delta', delta: 'R' },
      { kind: 'message_delta', delta: 'again' },
      { kind: 'usage', inputTokens: 5, outputTokens: 2 },
    ]);
  });

  it('settlement: assistant/attempt and turn/user rows map to nothing; tools still map', () => {
    expect(
      run(
        { event: { type: 'assistant/attempt', data: { turn: 1, step: 0, stream: [] } } },
        { event: { type: 'turn/start', data: { turn: 2 } } },
        {
          event: {
            type: 'user/message',
            data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] },
          },
        },
        { event: { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } },
      ),
    ).toEqual([]);
    expect(
      run({
        event: {
          type: 'tool/call',
          data: { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
        },
      }),
    ).toEqual([
      {
        kind: 'tool_call',
        call: {
          toolCallId: 'c1',
          toolName: 'bash',
          status: 'in_progress',
          rawInput: { command: 'ls' },
        },
      },
    ]);
    // Flat tool/result (v4) maps through the event arm too.
    expect(
      run({
        event: {
          type: 'tool/result',
          data: {
            message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] },
          },
        },
      }),
    ).toEqual([
      { kind: 'tool_call', call: { toolCallId: 'c1', status: 'completed', output: 'ok' } },
    ]);
  });
});

describe('TranscriptTail (dsh live streaming)', () => {
  /**
   * A decoder that behaves like real zstd for the cases the tail leans on: a
   * TRUNCATED frame throws (real frames carry a trailing checksum), a
   * complete frame round-trips its JSONL.
   */
  const checkedDecoder = (frame: Buffer): Buffer => {
    const body = frame.subarray(4);
    if (!body.toString('utf8').endsWith('\n')) throw new Error('torn frame');
    return body;
  };

  it('streams settlement batches as they are appended, recovering partial frames', async () => {
    const events: { kind: string; delta?: string }[] = [];
    // An appendable in-memory file the tail reads through the TailFs seam.
    let file = fakeTranscript([
      { type: 'session', version: 4, cwd: '/root/demo', createdAt: 1, delegationDepth: 0 },
    ]);
    const fs = {
      size: () => file.length,
      readEnd: (_p: string, start: number) => file.subarray(start),
    };
    const tail = new TranscriptTail(
      '/x/session.v4.jsonl.zstd',
      fs,
      checkedDecoder,
      (e) => events.push(e as { kind: string; delta?: string }),
      { intervalMs: 5 },
    );
    tail.start(); // skips existing bytes (the header)
    await new Promise((r) => setTimeout(r, 20));

    // A batch arrives mid-generation — a tool call…
    file = Buffer.concat([
      file,
      fakeTranscript([
        { type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } },
      ]),
    ]);
    await new Promise((r) => setTimeout(r, 20));
    // …a commit frame cut MID-WRITE (its tail bytes missing)…
    const whole = fakeTranscript([
      {
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 0,
          message: {
            content: [
              { type: 'reasoning', text: 'R' },
              { type: 'text', text: '1\n2\n' },
            ],
          },
          usage: { inputTokens: 5, outputTokens: 2 },
        },
      },
    ]);
    file = Buffer.concat([file, whole.subarray(0, whole.length - 4)]);
    await new Promise((r) => setTimeout(r, 20));
    expect(events).toEqual([
      { kind: 'tool_call', call: expect.objectContaining({ toolCallId: 'c1' }) },
    ]); // partial held back
    // …the rest of the frame lands: unstreamed step → complete blocks + usage.
    file = Buffer.concat([file, whole.subarray(whole.length - 4)]);
    await new Promise((r) => setTimeout(r, 20));
    expect(events.map((e) => e.kind)).toEqual([
      'tool_call',
      'thought_delta',
      'message_delta',
      'usage',
    ]);
    expect(events[2]).toEqual({ kind: 'message_delta', delta: '1\n2\n' });

    // The flat tool/result completes the pair (callId carries the join).
    file = Buffer.concat([
      file,
      fakeTranscript([
        {
          type: 'tool/result',
          data: {
            message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'a' }] },
          },
        },
      ]),
    ]);
    await new Promise((r) => setTimeout(r, 20));
    expect(events.at(-1)).toEqual({
      kind: 'tool_call',
      call: { toolCallId: 'c1', status: 'completed', output: 'a' },
    });

    // flush() drains synchronously; a turn/end row arms the settle signal;
    // stop() freezes the stream.
    tail.flush();
    const beforeSettle = Date.now();
    expect(tail.turnEndSeenSince(Date.now())).toBe(false);
    file = Buffer.concat([
      file,
      fakeTranscript([
        { type: 'turn/end', seq: 8, time: 8, data: { turn: 1, reason: { kind: 'completed' } } },
      ]),
    ]);
    await new Promise((r) => setTimeout(r, 20));
    expect(tail.turnEndSeenSince(beforeSettle)).toBe(true);
    tail.stop();
    const before = events.length;
    file = Buffer.concat([
      file,
      fakeTranscript([
        {
          type: 'assistant/message',
          data: { turn: 2, step: 0, message: { content: [{ type: 'text', text: 'post-stop' }] } },
        },
      ]),
    ]);
    await new Promise((r) => setTimeout(r, 20));
    expect(events.length).toBe(before);
  }, 10000);

  it('stops and reports fatal on a bounded frame that will not decode', async () => {
    const events: { kind: string }[] = [];
    const fatal: string[] = [];
    let file = fakeTranscript([
      { type: 'session', version: 4, cwd: '/x', createdAt: 1, delegationDepth: 0 },
    ]);
    const tail = new TranscriptTail(
      '/x/session.v4.jsonl.zstd',
      { size: () => file.length, readEnd: (_p: string, start: number) => file.subarray(start) },
      checkedDecoder,
      (e) => events.push(e as { kind: string }),
      { intervalMs: 5, onFatal: (reason) => fatal.push(reason) },
    );
    tail.start(); // skips the header
    // A bounded undecodable frame (corruption — NOT a torn trailing write:
    // more bytes follow it), then a good frame after it.
    file = Buffer.concat([
      file,
      MAGIC,
      Buffer.from('garbage-not-zstd'),
      fakeTranscript([
        {
          type: 'assistant/message',
          data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: 'after' }] } },
        },
      ]),
    ]);
    await new Promise((r) => setTimeout(r, 30));
    expect(fatal).toHaveLength(1);
    expect(fatal[0]).toContain('corrupt');
    expect(events).toEqual([]); // nothing after the corruption is trusted
  }, 10000);
});

describe('findTranscript', () => {
  it('locates the session dir across slugs and names the CURRENT generation', () => {
    const sessions = '/root/.dsh/sessions';
    const dirs = new Set([
      sessions, // the sessions root itself
      `${sessions}/--a--`,
      `${sessions}/--b--`,
      `${sessions}/--a--/id-1`, // the session dir itself must exist
    ]);
    const readdir = (p: string): string[] => {
      if (!dirs.has(p)) throw new Error('ENOENT');
      return p === sessions ? ['--a--', '--b--'] : ['whatever'];
    };
    expect(findTranscript(sessions, 'id-1', readdir)).toBe(
      `${sessions}/--a--/id-1/session.v4.jsonl.zstd`,
    );
    expect(
      findTranscript(sessions, 'nope', () => {
        throw new Error('ENOENT');
      }),
    ).toBeNull();
  });

  it('reads a pre-v4-only session dir as absent (#46)', () => {
    const sessions = '/root/.dsh/sessions';
    const readdir = (p: string): string[] => {
      if (p === sessions) return ['--a--'];
      if (p === `${sessions}/--a--`) return ['id-1'];
      if (p === `${sessions}/--a--/id-1`) return ['session.jsonl.zstd'];
      throw new Error('ENOENT');
    };
    expect(findTranscript(sessions, 'id-1', readdir)).toBeNull();
  });
});
