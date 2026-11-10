// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import {
  buildDiffFiles,
  diffTotals,
  highlightLines,
  markSegments,
  unifiedText,
  type DiffLine,
} from './diff-model';
import type { ToolCallNode } from './fold';
import { diffSources } from './tool-meta';

/** `kind old/new text` per line, e.g. `= 10/10 a`, `- 11/· b`, `+ ·/11 B`. */
function rows(lines: DiffLine[]): string[] {
  const sign = { context: '=', add: '+', del: '-' } as const;
  return lines.map(
    (l) => `${sign[l.kind]} ${String(l.oldNo ?? '·')}/${String(l.newNo ?? '·')} ${l.text}`,
  );
}

function node(partial: Partial<ToolCallNode>): ToolCallNode {
  return { callId: 'c1', status: 'completed', startedAt: 0, ...partial };
}

describe('buildDiffFiles', () => {
  it('numbers a positioned hunk from its new-side start (claude hook hunk)', () => {
    const [file] = buildDiffFiles([
      { path: 'a.ts', oldText: 'a\nb\nc\nd\n', newText: 'a\nB\nc\nd\ne\n', newStart: 10 },
    ]);
    const hunk = file!.hunks[0]!;
    expect(hunk.header).toBe('@@ -10,4 +10,5 @@');
    expect(rows(hunk.lines)).toEqual([
      '= 10/10 a',
      '- 11/· b',
      '+ ·/11 B',
      '= 12/12 c',
      '= 13/13 d',
      '+ ·/14 e',
    ]);
    expect([file!.added, file!.removed]).toEqual([2, 1]);
  });

  it('derives each later hunk’s old start from the earlier hunks’ net growth', () => {
    const files = buildDiffFiles([
      { path: 'a.ts', oldText: 'x\ny', newText: 'x\ny\nz', newStart: 5 },
      { path: 'a.ts', oldText: 'p\nq\nr', newText: 'p\nr', newStart: 20 },
    ]);
    expect(files).toHaveLength(1);
    expect(files[0]!.hunks.map((h) => h.header)).toEqual(['@@ -5,2 +5,3 @@', '@@ -19,3 +20,2 @@']);
    expect(rows(files[0]!.hunks[1]!.lines)).toEqual(['= 19/20 p', '- 20/· q', '= 21/21 r']);
  });

  it('numbers a new file 1..N with the conventional empty old side', () => {
    const [file] = buildDiffFiles([{ path: 'n.md', oldText: null, newText: 'one\ntwo\nthree\n' }]);
    expect(file!.hunks[0]!.header).toBe('@@ -0,0 +1,3 @@');
    expect(rows(file!.hunks[0]!.lines)).toEqual(['+ ·/1 one', '+ ·/2 two', '+ ·/3 three']);
    expect(diffTotals([file!])).toEqual({ added: 3, removed: 0 });
  });

  it('never invents numbers for an unpositioned snippet; a deletion is all removals', () => {
    const [file] = buildDiffFiles([
      { path: 'a.ts', oldText: 'gone\nalso gone', newText: null },
      { path: 'a.ts', oldText: 'k', newText: 'K' },
    ]);
    expect(file!.hunks.map((h) => h.header)).toEqual([null, null]);
    expect(rows(file!.hunks[0]!.lines)).toEqual(['- ·/· gone', '- ·/· also gone']);
    expect([file!.added, file!.removed]).toEqual([1, 3]);
  });

  it('counts only changed lines (the old footer counted context on both sides)', () => {
    const files = buildDiffFiles([{ path: 'a', oldText: 'a\nb\nc', newText: 'a\nX\nc' }]);
    expect(diffTotals(files)).toEqual({ added: 1, removed: 1 });
  });

  it('starts a new file block when the path changes', () => {
    const files = buildDiffFiles([
      { path: 'one', oldText: 'a', newText: 'b' },
      { path: 'two', oldText: null, newText: 'c' },
    ]);
    expect(files.map((f) => f.path)).toEqual(['one', 'two']);
  });

  it('marks changed words on paired lines, and only on similar pairs', () => {
    const [file] = buildDiffFiles([
      {
        path: 'a.ts',
        oldText: 'const total = price * qty;\nfoo()',
        newText: 'const total = price * quantity;\ncompletely different words here',
      },
    ]);
    const lines = file!.hunks[0]!.lines;
    const [del1, del2, add1, add2] = [lines[0]!, lines[1]!, lines[2]!, lines[3]!];
    expect(del1.text.slice(...del1.marks![0]!)).toBe('qty');
    expect(add1.text.slice(...add1.marks![0]!)).toBe('quantity');
    // A rewrite (little in common) carries no word marks.
    expect(del2.marks).toBeUndefined();
    expect(add2.marks).toBeUndefined();
  });

  it('renders unified text for the copy button', () => {
    const files = buildDiffFiles([{ path: 'f', oldText: 'a\nb', newText: 'a\nc', newStart: 3 }]);
    expect(unifiedText(files)).toBe('--- f\n+++ f\n@@ -3,2 +3,2 @@\n a\n-b\n+c');
  });
});

describe('diffSources', () => {
  it('reads every diff item and positions them when locations align', () => {
    const sources = diffSources(
      node({
        content: [
          { type: 'diff', path: '/w/a.ts', oldText: 'x', newText: 'y' },
          { type: 'diff', path: '/w/a.ts', oldText: 'p', newText: 'q' },
        ],
        locations: [
          { path: '/w/a.ts', line: 4 },
          { path: '/w/a.ts', line: 30 },
        ],
      }),
    );
    expect(sources?.map((s) => s.newStart)).toEqual([4, 30]);
  });

  it('leaves positions out when locations do not align (the pre-hook snippet)', () => {
    const sources = diffSources(
      node({
        content: [{ type: 'diff', path: '/w/a.ts', oldText: 'x', newText: 'y' }],
        locations: [{ path: '/w/a.ts' }],
      }),
    );
    expect(sources).toEqual([{ path: '/w/a.ts', oldText: 'x', newText: 'y' }]);
  });

  it('reads an absent oldText as new content and an absent newText as a deletion', () => {
    expect(diffSources(node({ content: [{ type: 'diff', path: 'n', newText: 'hello' }] }))).toEqual(
      [{ path: 'n', oldText: null, newText: 'hello' }],
    );
    expect(diffSources(node({ content: [{ type: 'diff', path: 'd', oldText: 'bye' }] }))).toEqual([
      { path: 'd', oldText: 'bye', newText: null },
    ]);
  });

  it('falls back to rawInput: Edit strings, EVERY MultiEdit edit, a Write body', () => {
    expect(
      diffSources(node({ rawInput: { file_path: '/a', old_string: 'x', new_string: '' } })),
    ).toEqual([{ path: '/a', oldText: 'x', newText: null }]);
    expect(
      diffSources(
        node({
          rawInput: {
            file_path: '/m',
            edits: [
              { old_string: 'a', new_string: 'b' },
              { old_string: 'c', new_string: 'd' },
            ],
          },
        }),
      )?.length,
    ).toBe(2);
    expect(diffSources(node({ rawInput: { file_path: '/w', content: 'body' } }))).toEqual([
      { path: '/w', oldText: null, newText: 'body' },
    ]);
    expect(diffSources(node({ rawInput: { file_path: '/r' } }))).toBeNull();
  });
});

describe('highlightLines / markSegments', () => {
  it('keeps a multi-line construct’s class on every line it spans', () => {
    const lines = highlightLines('/* a\nb */\nconst x = 1;\n', 'typescript')!;
    expect(lines).toHaveLength(3);
    expect(lines[0]!.some((s) => s.classes.join(' ').includes('hljs-comment'))).toBe(true);
    expect(lines[1]!.some((s) => s.classes.join(' ').includes('hljs-comment'))).toBe(true);
    expect(lines[2]!.map((s) => s.text).join('')).toBe('const x = 1;');
  });

  it('renders plain for an unknown language', () => {
    expect(highlightLines('x', 'no-such-lang')).toBeNull();
    expect(highlightLines('x', undefined)).toBeNull();
  });

  it('cuts syntax segments at word-mark boundaries, keeping their classes', () => {
    const segs = markSegments(
      'let qty = 1',
      [
        { text: 'let', classes: ['hljs-keyword'] },
        { text: ' qty = ', classes: [] },
        { text: '1', classes: ['hljs-number'] },
      ],
      [[4, 7]],
    );
    expect(segs.map((s) => [s.text, s.marked, s.classes.join(' ')])).toEqual([
      ['let', false, 'hljs-keyword'],
      [' ', false, ''],
      ['qty', true, ''],
      [' = ', false, ''],
      ['1', false, 'hljs-number'],
    ]);
  });
});
