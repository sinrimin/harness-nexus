// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import type { ChatToolCallView } from '@/realtime';
import { createFoldState, fold, type FoldState } from './fold';
import { sessionEditStats } from './hud-stats';

/**
 * #124 — the HUD's edit totals. These walk the SAME diff helpers as the Edit
 * card (`diffSources` → `buildDiffFiles`), so the strip's +N/−M can never
 * disagree with the cards above it.
 */

function withCalls(calls: ChatToolCallView[]): FoldState {
  let state = createFoldState();
  for (const call of calls) {
    state = fold(state, { type: 'event', event: { kind: 'tool_call', call } });
  }
  return state;
}

describe('sessionEditStats', () => {
  it('returns null when nothing was edited', () => {
    expect(sessionEditStats(createFoldState().rows)).toBeNull();
    expect(
      sessionEditStats(
        withCalls([{ toolCallId: 'c1', toolName: 'Read', status: 'completed', output: 'text' }])
          .rows,
      ),
    ).toBeNull();
  });

  it('dedupes by path and sums both halves of every hunk', () => {
    const state = withCalls([
      {
        toolCallId: 'e1',
        toolName: 'Edit',
        status: 'completed',
        content: [{ type: 'diff', path: 'src/a.ts', oldText: 'a\nb', newText: 'a\nc' }],
      },
      {
        toolCallId: 'e2',
        toolName: 'Edit',
        status: 'completed',
        content: [{ type: 'diff', path: 'src/a.ts', oldText: 'a\nc', newText: 'a\nc\nd' }],
      },
      {
        toolCallId: 'w1',
        toolName: 'Write',
        status: 'completed',
        rawInput: { file_path: 'docs/N.md', content: 'x\ny' },
      },
    ]);
    expect(sessionEditStats(state.rows)).toEqual({
      files: 2,
      added: 4,
      removed: 1,
      pathless: false,
      list: [
        { path: 'src/a.ts', added: 2, removed: 1 },
        { path: 'docs/N.md', added: 2, removed: 0 },
      ],
    });
  });

  it('counts a path-less hunk and marks the file count as a lower bound', () => {
    const state = withCalls([
      {
        toolCallId: 'e1',
        toolName: 'Edit',
        status: 'completed',
        content: [{ type: 'diff', oldText: 'a', newText: 'b' }],
      },
    ]);
    const stats = sessionEditStats(state.rows);
    expect(stats).not.toBeNull();
    expect(stats!.pathless).toBe(true);
    expect(stats!.files).toBe(0);
    expect(stats!.added).toBe(1);
    expect(stats!.removed).toBe(1);
  });

  it('includes sub-agent edits (the child fold is part of the session work)', () => {
    let state = createFoldState();
    state = fold(state, {
      type: 'event',
      event: { kind: 'subagent_spawned', subagentId: 's1', name: 'scout', task: 'look' },
    });
    state = fold(state, {
      type: 'event',
      event: {
        kind: 'subagent_update',
        subagentId: 's1',
        event: {
          kind: 'tool_call',
          call: {
            toolCallId: 'c1',
            toolName: 'Edit',
            status: 'completed',
            content: [{ type: 'diff', path: 'src/child.ts', oldText: 'old', newText: 'new\nline' }],
          },
        },
      },
    });
    const stats = sessionEditStats(state.rows);
    expect(stats?.files).toBe(1);
    expect(stats?.list[0]?.path).toBe('src/child.ts');
    expect(stats?.added).toBe(2);
    expect(stats?.removed).toBe(1);
  });
});
