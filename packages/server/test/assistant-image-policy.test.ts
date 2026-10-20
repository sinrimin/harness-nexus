// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import type { AssistantMessageRow, AssistantPromptBlock } from '@harness-nexus/core';
import {
  IMAGE_CONTEXT_PLACEHOLDER,
  IMAGE_CONTEXT_TURNS,
  IMAGE_EXPIRED_PLACEHOLDER,
  loadImageMap,
  type ImageMap,
  promptBlocksToPiContent,
  rowsToPiMessages,
  rowsToHistoryItems,
} from '../src/assistant/history.js';

/**
 * #58-3 — the model-context image policy. The transcript rows keep their
 * image blocks (the UI replay is untouched); the LLM-facing rebuild degrades
 * them per the resolved model: a non-vision model strips EVERY image (a
 * mid-session switch must not feed blocks the wire would reject), a vision
 * model keeps only the most recent `keepTurns` user rows' (re-uploading all
 * history images every turn bloats the input bill and provider image caps).
 */

const IMG: AssistantPromptBlock = { type: 'image', data: 'AAAA', mimeType: 'image/png' };

function userRow(seq: number, blocks: AssistantPromptBlock[]): AssistantMessageRow {
  return {
    sessionId: 's',
    seq,
    type: 'user',
    blocks,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function assistantRow(seq: number): AssistantMessageRow {
  return {
    sessionId: 's',
    seq,
    type: 'assistant',
    text: 'ok',
    thought: '',
    toolCalls: [],
    stopReason: 'end_turn',
    usage: undefined,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

/** Five user turns, each with one image + one text block. */
const ROWS: AssistantMessageRow[] = (() => {
  const rows: AssistantMessageRow[] = [];
  let seq = 0;
  for (let turn = 0; turn < 5; turn += 1) {
    rows.push(userRow(seq++, [IMG, { type: 'text', text: `turn ${turn}` }]));
    rows.push(assistantRow(seq++));
  }
  return rows;
})();

type UserMsg = { role: 'user'; content: { type: string; text?: string }[] };

function userContents(messages: ReturnType<typeof rowsToPiMessages>): UserMsg['content'][] {
  return messages
    .filter((m): m is UserMsg => m.role === 'user')
    .map((m) => m.content as UserMsg['content']);
}

describe('#58-3 assistant model-context image policy', () => {
  it('a vision model keeps images only in the most recent keepTurns user rows', () => {
    const contents = userContents(
      rowsToPiMessages(ROWS, 'openai-chat', 'm', {
        vision: true,
        keepTurns: IMAGE_CONTEXT_TURNS,
      }),
    );
    expect(contents).toHaveLength(5);
    // Oldest 5-3=2 turns degrade; the trailing 3 keep their images.
    expect(contents[0]![0]).toEqual({ type: 'text', text: IMAGE_CONTEXT_PLACEHOLDER });
    expect(contents[1]![0]).toEqual({ type: 'text', text: IMAGE_CONTEXT_PLACEHOLDER });
    for (const c of contents.slice(2)) {
      expect(c[0]!.type).toBe('image');
    }
    // Text blocks ride untouched in every row.
    expect(contents[0]![1]).toEqual({ type: 'text', text: 'turn 0' });
  });

  it('a non-vision model strips EVERY image (mid-session switch survives)', () => {
    const contents = userContents(
      rowsToPiMessages(ROWS, 'openai-chat', 'm', {
        vision: false,
        keepTurns: IMAGE_CONTEXT_TURNS,
      }),
    );
    for (const c of contents) {
      expect(c[0]).toEqual({ type: 'text', text: IMAGE_CONTEXT_PLACEHOLDER });
    }
  });

  it('no policy (legacy callers) keeps every image', () => {
    const contents = userContents(rowsToPiMessages(ROWS, 'openai-chat', 'm'));
    for (const c of contents) {
      expect(c[0]!.type).toBe('image');
    }
  });

  it('the current prompt keeps its images iff the model has vision', () => {
    const blocks = [IMG, { type: 'text', text: 'look' }] as const;
    expect(promptBlocksToPiContent(blocks, { vision: true, keepTurns: 3 })[0]!.type).toBe('image');
    expect(promptBlocksToPiContent(blocks, { vision: false, keepTurns: 3 })[0]).toEqual({
      type: 'text',
      text: IMAGE_CONTEXT_PLACEHOLDER,
    });
    // resource_link keeps its text rendering under either policy.
    const ref = promptBlocksToPiContent(
      [{ type: 'resource_link', name: 'a.md', uri: 'file:///a.md' }],
      { vision: false, keepTurns: 3 },
    );
    expect(ref[0]).toEqual({ type: 'text', text: '[file reference] a.md: file:///a.md' });
  });
});

describe('#59 imageRef arms through the builders', () => {
  const REF: AssistantPromptBlock = { type: 'imageRef', ref: 'b1', mimeType: 'image/png' };
  const vision = { vision: true, keepTurns: IMAGE_CONTEXT_TURNS };
  const map: ImageMap = new Map([
    ['b1', { data: 'AAAA', mimeType: 'image/png' }],
    ['gone', null],
  ]);

  it('a resolved ref rides the model context; a missing one degrades', () => {
    const content = promptBlocksToPiContent(
      [
        { type: 'text', text: 'look' },
        REF,
        { type: 'imageRef', ref: 'gone', mimeType: 'image/png' },
      ],
      vision,
      map,
    );
    expect(content).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'text', text: IMAGE_CONTEXT_PLACEHOLDER },
    ]);
  });

  it('an images-only turn gains the [image] text part (OpenAI-compatible shape)', () => {
    const content = promptBlocksToPiContent([REF], vision, map);
    expect(content[0]).toEqual({ type: 'text', text: '[image]' });
    expect(content[1]!.type).toBe('image');
    // The legacy inline arm gets the same guard.
    const legacy = rowsToPiMessages([userRow(0, [IMG])], 'openai-chat', 'm', vision);
    const first = legacy[0]!;
    expect(first.role === 'user' && first.content[0]).toEqual({ type: 'text', text: '[image]' });
  });

  it('a non-vision model degrades refs exactly like inline images', () => {
    const content = promptBlocksToPiContent([REF], { vision: false, keepTurns: 3 }, map);
    expect(content).toEqual([{ type: 'text', text: IMAGE_CONTEXT_PLACEHOLDER }]);
  });

  it('rowsToHistoryItems resolves refs inline; missing blobs replay as expired', async () => {
    const rows = [userRow(0, [REF, { type: 'text', text: 'hi' }])];
    const items = await rowsToHistoryItems(rows, async (ref) =>
      ref === 'b1' ? { data: 'AAAA', mimeType: 'image/png' } : null,
    );
    const u = items[0]!;
    expect(u.type === 'user' ? u.blocks : []).toEqual([
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
      { type: 'text', text: 'hi' },
    ]);

    const gone = await rowsToHistoryItems(
      [userRow(1, [{ type: 'imageRef', ref: 'gone', mimeType: 'image/png' }])],
      async () => null,
    );
    expect(gone[0]!.type === 'user' ? gone[0]!.blocks : []).toEqual([
      { type: 'text', text: IMAGE_EXPIRED_PLACEHOLDER },
    ]);
  });

  it('loadImageMap treats expired rows as missing', async () => {
    const blobs = {
      async get(id: string) {
        if (id === 'fresh') {
          return {
            row: {
              id,
              mimeType: 'image/png',
              size: 1,
              expiresAt: '2999-01-01T00:00:00.000Z',
              createdAt: '2026-01-01T00:00:00.000Z',
            },
            data: new Uint8Array([1]),
          };
        }
        if (id === 'stale') {
          return {
            row: {
              id,
              mimeType: 'image/png',
              size: 1,
              expiresAt: '2000-01-01T00:00:00.000Z',
              createdAt: '2026-01-01T00:00:00.000Z',
            },
            data: new Uint8Array([2]),
          };
        }
        return null;
      },
    };
    const m = await loadImageMap(
      blobs as never,
      ['fresh', 'stale', 'nope'],
      '2026-06-01T00:00:00.000Z',
    );
    expect(m.get('fresh')!.data).toBe(Buffer.from([1]).toString('base64'));
    expect(m.get('stale')).toBeNull();
    expect(m.get('nope')).toBeNull();
  });
});
