// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import type { AssistantMessageRow } from '@harness-nexus/core';
import { rowsToHistoryItems, rowsToPiMessages } from '../src/assistant/history.js';

/**
 * #68 — the modelVisible note arm (dispatch backflow): notes the assistant
 * MODEL must see fold into the conversation at context-build time without
 * ever standing between a toolCall and its toolResult, and replay renders
 * them as raw hnx/note events. Display-only notes (rebinds) stay invisible
 * to both.
 */

const noteRow = (seq: number, text: string, modelVisible?: true): AssistantMessageRow => ({
  seq,
  type: 'note',
  text,
  ...(modelVisible !== undefined ? { modelVisible } : {}),
});

describe('#68 modelVisible notes', () => {
  it('fold into the NEXT user turn as [platform note] text — never standalone', () => {
    const rows: AssistantMessageRow[] = [
      { seq: 1, type: 'user', blocks: [{ type: 'text', text: 'run the deploy' }] },
      {
        seq: 2,
        type: 'assistant',
        text: 'dispatching',
        thought: '',
        toolCalls: [],
        stopReason: 'end_turn',
      },
      noteRow(3, 'dispatch c1: the user stopped the driven agent turn manually', true),
      noteRow(4, 'rebound to assistant "other"'),
      { seq: 5, type: 'user', blocks: [{ type: 'text', text: 'what happened?' }] },
    ];
    const msgs = rowsToPiMessages(rows, 'openai-chat', 'm');
    const users = msgs.filter((m) => m.role === 'user');
    expect(users).toHaveLength(2);
    const second = JSON.stringify(users[1]!.content);
    expect(second).toContain('[platform note] dispatch c1');
    expect(second).toContain('what happened?');
    // The display-only rebind note never reaches the model.
    expect(JSON.stringify(msgs)).not.toContain('rebound');
  });

  it('trailing notes (a completion after the last turn) land as a final user turn', () => {
    const rows: AssistantMessageRow[] = [
      { seq: 1, type: 'user', blocks: [{ type: 'text', text: 'run it' }] },
      {
        seq: 2,
        type: 'assistant',
        text: 'dispatched',
        thought: '',
        toolCalls: [],
        stopReason: 'end_turn',
      },
      noteRow(3, 'dispatch c1: the driven turn finished', true),
    ];
    const msgs = rowsToPiMessages(rows, 'openai-chat', 'm');
    const last = msgs[msgs.length - 1]!;
    expect(last.role === 'user').toBe(true);
    expect(JSON.stringify(last.content)).toContain('finished');
  });

  it('replay renders modelVisible notes as raw hnx/note items; display-only stay silent', async () => {
    const rows: AssistantMessageRow[] = [
      { seq: 1, type: 'user', blocks: [{ type: 'text', text: 'run it' }] },
      noteRow(2, 'dispatch c1: the user stopped the driven agent turn manually', true),
      noteRow(3, 'rebound to assistant "other"'),
    ];
    const items = await rowsToHistoryItems(rows);
    const notes = items.filter(
      (i): i is Extract<typeof i, { type: 'event' }> =>
        i.type === 'event' &&
        i.event.kind === 'raw' &&
        (i.event as { method?: string }).method === 'hnx/note',
    );
    expect(notes).toHaveLength(1);
    expect(((notes[0]!.event as { params?: { message?: string } }).params ?? {}).message).toContain(
      'user stopped',
    );
  });
});
