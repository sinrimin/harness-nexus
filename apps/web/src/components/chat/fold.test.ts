import { describe, expect, it } from 'vitest';
import type { HistoryItem } from '@/realtime';
import { createFoldState, fold } from './fold';

/**
 * #8 — replay batches (claude-code load capture, resync ring) carry no
 * per-turn turn_result, only a trailing one. The exact sequence the rig
 * session dumped; with the pre-fix fold, the reply to Q1 patched Q0's
 * still-open step and rendered ABOVE Q1.
 */
const replayedTurns: HistoryItem[] = [
  { type: 'user', blocks: [{ type: 'text', text: 'Q0' }] },
  { type: 'event', event: { kind: 'message_delta', delta: 'reply to Q0' } },
  { type: 'user', blocks: [{ type: 'text', text: 'Q1' }] },
  { type: 'event', event: { kind: 'thought_delta', delta: 'thinking about Q1' } },
  { type: 'event', event: { kind: 'message_delta', delta: 'reply to Q1' } },
  { type: 'user', blocks: [{ type: 'text', text: 'Q2' }] },
  { type: 'event', event: { kind: 'message_delta', delta: 'reply to Q2' } },
];

const rowKinds = (items: HistoryItem[]) =>
  fold(createFoldState(), { type: 'history', items }).rows.map((r) => r.row);

function userTextAt(state: ReturnType<typeof createFoldState>, idx: number): string {
  const row = state.rows[idx];
  if (row === undefined || row.row !== 'user') throw new Error(`row ${idx} is not a user row`);
  return row.blocks.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join(' ');
}

function stepTextAt(state: ReturnType<typeof createFoldState>, idx: number): string {
  const row = state.rows[idx];
  if (row === undefined || row.row !== 'assistant') {
    throw new Error(`row ${idx} is not an assistant step`);
  }
  return row.step.blocks.map((b) => b.text).join(' ');
}

describe('fold history ingestion (#8: user item = turn boundary)', () => {
  it("places each turn's reply BELOW its question, not above it", () => {
    const state = fold(createFoldState(), { type: 'history', items: replayedTurns });
    // Rows: user Q0, step(reply Q0), user Q1, step(reply Q1), user Q2,
    // step(reply Q2), and the trailing synthetic turn-tail from the
    // end-of-batch sweep.
    expect(rowKinds(replayedTurns)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
      'turn-tail',
    ]);
    expect(userTextAt(state, 0)).toBe('Q0');
    expect(stepTextAt(state, 1)).toBe('reply to Q0');
    expect(userTextAt(state, 2)).toBe('Q1');
    expect(stepTextAt(state, 3)).toBe('thinking about Q1 reply to Q1');
    expect(userTextAt(state, 4)).toBe('Q2');
    expect(stepTextAt(state, 5)).toBe('reply to Q2');
    // No row stays running after ingestion.
    expect(
      state.rows.every((r) => (r.row === 'assistant' ? r.step.status !== 'running' : true)),
    ).toBe(true);
  });

  it('closes the open step even when the user item renders no blocks', () => {
    const items: HistoryItem[] = [
      { type: 'user', blocks: [{ type: 'text', text: 'Q0' }] },
      { type: 'event', event: { kind: 'message_delta', delta: 'reply to Q0' } },
      { type: 'user', blocks: [{ type: 'text', text: '' }] }, // dropped row, real turn break
      { type: 'event', event: { kind: 'message_delta', delta: 'reply to Q1' } },
    ];
    const state = fold(createFoldState(), { type: 'history', items });
    expect(rowKinds(items)).toEqual(['user', 'assistant', 'assistant', 'turn-tail']);
    expect(stepTextAt(state, 1)).toBe('reply to Q0');
    expect(stepTextAt(state, 2)).toBe('reply to Q1');
  });

  it('keeps batches WITH per-turn turn_result markers unchanged', () => {
    const items: HistoryItem[] = [
      { type: 'user', blocks: [{ type: 'text', text: 'Q0' }] },
      { type: 'event', event: { kind: 'message_delta', delta: 'reply to Q0' } },
      { type: 'event', event: { kind: 'turn_result', stopReason: 'end_turn' } },
      { type: 'user', blocks: [{ type: 'text', text: 'Q1' }] },
      { type: 'event', event: { kind: 'message_delta', delta: 'reply to Q1' } },
      { type: 'event', event: { kind: 'turn_result', stopReason: 'end_turn' } },
    ];
    const state = fold(createFoldState(), { type: 'history', items });
    expect(rowKinds(items)).toEqual([
      'user',
      'assistant',
      'turn-tail',
      'user',
      'assistant',
      'turn-tail',
    ]);
    expect(userTextAt(state, 3)).toBe('Q1');
    expect(stepTextAt(state, 4)).toBe('reply to Q1');
  });

  it('#10: queue_state parks and clears the chip without transcript rows', () => {
    const parked: HistoryItem[] = [
      { type: 'user', blocks: [{ type: 'text', text: 'Q0' }] },
      { type: 'event', event: { kind: 'message_delta', delta: 'reply to Q0' } },
    ];
    let state = fold(createFoldState(), { type: 'history', items: parked });
    state = fold(state, {
      type: 'event',
      event: { kind: 'queue_state', prompt: [{ type: 'text', text: 'meanwhile' }], flushed: false },
    });
    expect(state.queued?.[0]).toEqual({ type: 'text', text: 'meanwhile' });
    const rowsBefore = state.rows.length;
    // A cancel clear drops the chip WITHOUT folding a user row.
    state = fold(state, {
      type: 'event',
      event: { kind: 'queue_state', prompt: null, flushed: false },
    });
    expect(state.queued).toBeNull();
    expect(state.rows.length).toBe(rowsBefore);
  });

  it('#10/#11: a flush clears the chip; the user_message echo paints the row', () => {
    let state = fold(createFoldState(), {
      type: 'event',
      event: {
        kind: 'queue_state',
        prompt: [{ type: 'text', text: 'next question' }],
        flushed: false,
      },
    });
    state = fold(state, {
      type: 'event',
      event: { kind: 'queue_state', prompt: null, flushed: true },
    });
    expect(state.queued).toBeNull();
    // The flush clear alone adds NO row — the echo does.
    expect(state.rows.filter((r) => r.row === 'user')).toHaveLength(0);
    state = fold(state, {
      type: 'event',
      event: { kind: 'user_message', blocks: [{ type: 'text', text: 'next question' }] },
    });
    const last = state.rows[state.rows.length - 2];
    if (last === undefined || last.row !== 'user') throw new Error('expected a user row');
    expect(last.blocks).toEqual([{ type: 'text', text: 'next question' }]);
    expect(state.turnActive).toBe(true);
  });

  it('#11: a user_message echo starts the turn for a viewer that did not send', () => {
    const state = fold(createFoldState(), {
      type: 'event',
      event: { kind: 'user_message', blocks: [{ type: 'text', text: 'from the other tab' }] },
    });
    expect(state.rows.map((r) => r.row)).toEqual(['user', 'assistant']);
    expect(state.rows[0]?.row === 'user' && state.rows[0].blocks[0]?.type === 'text').toBe(true);
    expect(state.turnActive).toBe(true);
    expect(state.rows[1]?.row === 'assistant' && state.rows[1].step.status).toBe('running');
  });

  it('re-ingesting the same batch converges (resync idempotence)', () => {
    const once = fold(createFoldState(), { type: 'history', items: replayedTurns });
    const twice = fold(once, { type: 'history', items: replayedTurns });
    expect(twice.rows.map((r) => r.row)).toEqual(once.rows.map((r) => r.row));
    expect(twice.rows.length).toBe(once.rows.length);
  });
});
