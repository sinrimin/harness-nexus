// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  piFindSessionFile,
  piListSessions,
  piMessageToReplayUpdates,
  piSessionReplay,
  piSessionViews,
} from '../src/daemon/pi-sessions.js';
import { attachSessionsHandlers } from '../src/daemon/sessions.js';

/**
 * pi session store parsing (Phase 9 W16) — listing, the leaf-chain replay,
 * and the sessions:list dispatch arm. Ground truth: pi.dev "Session format"
 * (header v3, tree entries, session_info names, model_change routes).
 */

const realFs = {
  readdir: (p: string) => readdirSync(p),
  readFile: (p: string) => readFileSync(p),
  stat: (p: string) => statSync(p),
};

let root: string;
let home: string;
const sessionsDir = (): string => path.join(root, 'sessions');

function writeSession(group: string, file: string, lines: unknown[]): void {
  const dir = path.join(sessionsDir(), group);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, file),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    'utf8',
  );
}

const header = (id: string, cwd: string): unknown => ({
  type: 'session',
  version: 3,
  id,
  timestamp: '2026-09-17T10:00:00.000Z',
  cwd,
});

/** A two-turn transcript with a branch off turn 1 (pi's tree semantics). */
const transcript = (): unknown[] => [
  header('uuid-1', '/home/me/proj'),
  {
    type: 'message',
    id: 'a1',
    parentId: null,
    timestamp: '2026-09-17T10:00:01.000Z',
    message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
  },
  // A sibling the chain must SKIP (branched off a1, superseded by a2).
  {
    type: 'message',
    id: 'b1',
    parentId: 'a1',
    timestamp: '2026-09-17T10:00:02.000Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'branched off' }] },
  },
  {
    type: 'message',
    id: 'a2',
    parentId: 'a1',
    timestamp: '2026-09-17T10:00:03.000Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'hi there' },
        { type: 'toolCall', toolCallId: 't1', tool: 'read', arguments: { path: '/x' } },
      ],
    },
  },
  {
    type: 'message',
    id: 'a3',
    parentId: 'a2',
    timestamp: '2026-09-17T10:00:04.000Z',
    message: {
      role: 'toolResult',
      toolCallId: 't1',
      output: [{ type: 'text', text: 'file body' }],
    },
  },
  {
    type: 'model_change',
    id: 'm1',
    parentId: 'a3',
    provider: 'harness-nexus',
    modelId: 'gw-large',
  },
  { type: 'session_info', id: 's1', parentId: 'm1', name: 'my task' },
];

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'hnx-pi-'));
  home = mkdtempSync(path.join(tmpdir(), 'hnx-pi-home-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe('piListSessions', () => {
  it('lists header identity, session_info title, model_change route; skips junk', () => {
    writeSession('--home-me-proj--', '20260917-100000_uuid-1.jsonl', transcript());
    writeSession('--home-me-other--', '20260917-110000_uuid-2.jsonl', [
      header('uuid-2', '/home/me/other'),
    ]);
    writeSession('--junk--', 'not-json.jsonl', [{ type: 'message' }]); // no session header → skipped
    writeSession('--x--', 'notes.txt', ['not a session']); // not .jsonl → ignored

    const rows = piListSessions(sessionsDir(), realFs);
    expect(rows).toHaveLength(2);
    const first = rows.find((r) => r.sessionId === 'uuid-1')!;
    expect(first.cwd).toBe('/home/me/proj');
    expect(first.title).toBe('my task');
    expect(first.model).toBe('harness-nexus/gw-large');
    expect(first.createdAt).toBe('2026-09-17T10:00:00.000Z');
    expect(Number.isNaN(Date.parse(first.updatedAt ?? ''))).toBe(false); // mtime ISO
    const second = rows.find((r) => r.sessionId === 'uuid-2')!;
    expect(second.title).toBeNull();
    expect(second.model).toBeNull();
  });

  it('views omit the optional arms when null', () => {
    writeSession('--home-me-other--', '20260917-110000_uuid-2.jsonl', [
      header('uuid-2', '/home/me/other'),
    ]);
    const [view] = piSessionViews(sessionsDir(), realFs);
    expect(view).toBeDefined();
    expect(view!.sessionId).toBe('uuid-2');
    expect('title' in view!).toBe(false);
    expect('model' in view!).toBe(false);
  });
});

describe('piSessionReplay (leaf chain)', () => {
  it('maps the ACTIVE chain and skips the branch', () => {
    const updates = piSessionReplay(
      transcript()
        .map((e) => JSON.stringify(e))
        .join('\n'),
    );
    expect(updates).toEqual([
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hello' } },
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi there' } },
      { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'read', rawInput: '{"path":"/x"}' },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: 't1',
        content: [{ type: 'text', text: 'file body' }],
        status: 'completed',
      },
    ]);
    expect(JSON.stringify(updates)).not.toContain('branched off');
  });

  it('tolerates junk lines and non-chat entries', () => {
    const text = [
      'not json at all',
      JSON.stringify(header('u', '/w')),
      JSON.stringify({
        type: 'message',
        id: 'x',
        parentId: null,
        message: { role: 'system', content: [] },
      }),
      JSON.stringify({ type: 'compaction', id: 'c', parentId: 'x', summary: '…' }),
      '',
    ].join('\n');
    expect(piSessionReplay(text)).toEqual([]);
  });
});

describe('piMessageToReplayUpdates', () => {
  it('joins multi-block user text and skips non-text blocks', () => {
    const updates = piMessageToReplayUpdates({
      role: 'user',
      content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }],
    });
    expect(updates).toEqual([
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'ab' } },
    ]);
  });
});

describe('piFindSessionFile', () => {
  it('matches by filename (partials) then falls back to header ids', () => {
    writeSession('--home-me-proj--', '20260917-100000_uuid-1.jsonl', transcript());
    expect(piFindSessionFile(sessionsDir(), realFs, 'uuid-1')).toContain('uuid-1.jsonl');
    expect(piFindSessionFile(sessionsDir(), realFs, 'uuid-1'.slice(0, 8))).toContain(
      'uuid-1.jsonl',
    );
    expect(piFindSessionFile(sessionsDir(), realFs, 'nope')).toBeNull();
  });
});

describe('sessions:list dispatch (pi arm)', () => {
  it('answers from the file scan under the home — rows, no adapter spawn', async () => {
    const store = path.join(home, '.pi', 'agent', 'sessions', '--home-me-proj--');
    mkdirSync(store, { recursive: true });
    writeFileSync(
      path.join(store, '20260917-100000_uuid-1.jsonl'),
      transcript()
        .map((l) => JSON.stringify(l))
        .join('\n') + '\n',
      'utf8',
    );

    const emitted: { event: string; payload: unknown }[] = [];
    const handlers = new Map<string, (payload: unknown, ack?: (r: unknown) => void) => void>();
    const sock = {
      emit: (event: string, payload: unknown): boolean => {
        emitted.push({ event, payload });
        return true;
      },
      on: (event: string, handler: (payload: unknown, ack?: (r: unknown) => void) => void) => {
        handlers.set(event, handler);
        return sock;
      },
    };
    attachSessionsHandlers(sock as never, { homeDir: home, env: {}, cacheTtlMs: 0 });
    handlers.get('sessions:list')!({ requestId: 'r1', target: 'pi' }, () => {});

    await new Promise((r) => setTimeout(r, 50));
    const result = emitted.find((e) => e.event === 'sessions:list:result')?.payload as {
      sessions?: { sessionId: string; title?: string }[];
    };
    expect(result?.sessions).toHaveLength(1);
    expect(result?.sessions?.[0]?.sessionId).toBe('uuid-1');
    expect(result?.sessions?.[0]?.title).toBe('my task');
  });
});
