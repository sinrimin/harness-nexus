import { describe, expect, it } from 'vitest';
import type { AssistantMessageRow, AssistantPromptBlock } from '@harness-nexus/core';
import {
  IMAGE_CONTEXT_PLACEHOLDER,
  IMAGE_CONTEXT_TURNS,
  promptBlocksToPiContent,
  rowsToPiMessages,
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
