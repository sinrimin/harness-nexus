// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { diffArrays, diffWordsWithSpace } from 'diff';
import { common, createLowlight } from 'lowlight';

/**
 * #121 — the diff model behind the transcript's GitLab-structured diff view.
 * The old DiffBlock had no diff algorithm at all (every old line printed as
 * `-`, every new line as `+`); this computes real line diffs (jsdiff), line
 * numbers, word-level marks and syntax segments, as pure data the renderer
 * only paints.
 *
 * Inputs are what the wire carries — never a whole file:
 * - claude-agent-acp's PostToolUse hook sends ONE diff block per hunk (three
 *   context lines in both texts) with `locations[i].line` = the hunk's
 *   new-side start line;
 * - before the hook lands (and for other agents) a block is the raw
 *   old_string / new_string snippet with no position;
 * - a Write carries the whole new content with `oldText` absent.
 *
 * Line numbers are only ever real: the new side from the hunk's start, the
 * old side derived from it (minus the net growth of the same file's earlier
 * hunks), a new file numbers 1..N, and an unknown start leaves the gutters
 * empty — no invented numbers.
 */

export interface DiffSource {
  path: string;
  /** null = the whole new content of a (new) file: every line is an add. */
  oldText: string | null;
  /** null = a pure deletion: every line is a removal. */
  newText: string | null;
  /** The hunk's new-side 1-based start line, when the agent sent one. */
  newStart?: number;
}

export type DiffLineKind = 'context' | 'add' | 'del';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldNo?: number;
  newNo?: number;
  /** Line index within the hunk's old / new text (syntax segment lookup). */
  oldIdx?: number;
  newIdx?: number;
  /** Word-level changed ranges in `text`, [start, end), sorted. */
  marks?: [number, number][];
}

export interface DiffHunk {
  /** `@@ -a,b +c,d @@`, or null when the position is unknown. */
  header: string | null;
  lines: DiffLine[];
  oldText: string;
  newText: string;
}

export interface DiffFile {
  path: string;
  hunks: DiffHunk[];
  added: number;
  removed: number;
}

/** Lines of a text block: one trailing newline is not an extra line. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return body.split('\n');
}

/** Word marks only for lines this long or shorter (diffWords is O(n·d)). */
const MARK_LINE_MAX = 1000;
/** Below this share of unchanged chars a pair is a rewrite, not an edit. */
const MARK_SIMILARITY_MIN = 0.4;

function wordMarks(oldLine: string, newLine: string): [DiffLine['marks'], DiffLine['marks']] {
  if (oldLine.length > MARK_LINE_MAX || newLine.length > MARK_LINE_MAX)
    return [undefined, undefined];
  const parts = diffWordsWithSpace(oldLine, newLine);
  const oldMarks: [number, number][] = [];
  const newMarks: [number, number][] = [];
  let o = 0;
  let n = 0;
  let same = 0;
  for (const p of parts) {
    const len = p.value.length;
    if (p.added) {
      newMarks.push([n, n + len]);
      n += len;
    } else if (p.removed) {
      oldMarks.push([o, o + len]);
      o += len;
    } else {
      same += len;
      o += len;
      n += len;
    }
  }
  const longest = Math.max(oldLine.length, newLine.length);
  if (longest === 0 || same / longest < MARK_SIMILARITY_MIN) return [undefined, undefined];
  return [oldMarks.length > 0 ? oldMarks : undefined, newMarks.length > 0 ? newMarks : undefined];
}

/** Pair each change block's removed lines with its added lines, in order. */
function markPairs(lines: DiffLine[]): void {
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.kind !== 'del') {
      i += 1;
      continue;
    }
    const delStart = i;
    while (i < lines.length && lines[i]!.kind === 'del') i += 1;
    const addStart = i;
    while (i < lines.length && lines[i]!.kind === 'add') i += 1;
    const pairs = Math.min(addStart - delStart, i - addStart);
    for (let k = 0; k < pairs; k += 1) {
      const del = lines[delStart + k]!;
      const add = lines[addStart + k]!;
      const [om, nm] = wordMarks(del.text, add.text);
      if (om !== undefined) del.marks = om;
      if (nm !== undefined) add.marks = nm;
    }
  }
}

function rangeLabel(start: number, count: number): string {
  // Unified-diff convention: an empty side names the line BEFORE it.
  return `${String(count === 0 ? start - 1 : start)},${String(count)}`;
}

function buildHunk(
  source: DiffSource,
  oldStart: number | undefined,
  newStart: number | undefined,
): DiffHunk {
  const oldText = source.oldText ?? '';
  const newText = source.newText ?? '';
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const lines: DiffLine[] = [];
  let o = 0;
  let n = 0;
  const push = (kind: DiffLineKind, text: string) => {
    const line: DiffLine = { kind, text };
    if (kind !== 'add') {
      line.oldIdx = o;
      if (oldStart !== undefined) line.oldNo = oldStart + o;
      o += 1;
    }
    if (kind !== 'del') {
      line.newIdx = n;
      if (newStart !== undefined) line.newNo = newStart + n;
      n += 1;
    }
    lines.push(line);
  };
  if (source.oldText === null) {
    for (const l of newLines) push('add', l);
  } else if (source.newText === null) {
    for (const l of oldLines) push('del', l);
  } else {
    for (const part of diffArrays(oldLines, newLines)) {
      const kind: DiffLineKind = part.added ? 'add' : part.removed ? 'del' : 'context';
      for (const l of part.value) push(kind, l);
    }
  }
  markPairs(lines);
  const header =
    oldStart !== undefined && newStart !== undefined
      ? `@@ -${rangeLabel(oldStart, oldLines.length)} +${rangeLabel(newStart, newLines.length)} @@`
      : null;
  return { header, lines, oldText, newText };
}

/**
 * Sources → files (consecutive sources on the same path share a file, in
 * order — one tool call's hunks arrive sorted). The old-side start of a hunk
 * is its new-side start minus the net growth of the file's earlier hunks.
 */
export function buildDiffFiles(sources: readonly DiffSource[]): DiffFile[] {
  const files: DiffFile[] = [];
  let growth = 0;
  for (const source of sources) {
    if (source.oldText === null && source.newText === null) continue;
    let file = files[files.length - 1];
    if (file === undefined || file.path !== source.path) {
      file = { path: source.path, hunks: [], added: 0, removed: 0 };
      files.push(file);
      growth = 0;
    }
    const newStart =
      source.newStart !== undefined ? source.newStart : source.oldText === null ? 1 : undefined;
    // A new file's empty old side reads `-0,0` (rangeLabel names the line
    // before an empty side).
    const oldStart =
      newStart === undefined ? undefined : source.oldText === null ? 1 : newStart - growth;
    const hunk = buildHunk(source, oldStart, newStart);
    let added = 0;
    let removed = 0;
    for (const l of hunk.lines) {
      if (l.kind === 'add') added += 1;
      else if (l.kind === 'del') removed += 1;
    }
    file.added += added;
    file.removed += removed;
    growth += added - removed;
    file.hunks.push(hunk);
  }
  return files;
}

/** Exact line counts across every source (context lines never count). */
export function diffTotals(files: readonly DiffFile[]): { added: number; removed: number } {
  return files.reduce(
    (acc, f) => ({ added: acc.added + f.added, removed: acc.removed + f.removed }),
    { added: 0, removed: 0 },
  );
}

/** The files as unified-diff text (the copy button's payload). */
export function unifiedText(files: readonly DiffFile[]): string {
  const out: string[] = [];
  for (const f of files) {
    out.push(`--- ${f.path}`, `+++ ${f.path}`);
    for (const h of f.hunks) {
      if (h.header !== null) out.push(h.header);
      for (const l of h.lines) {
        out.push(`${l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}${l.text}`);
      }
    }
  }
  return out.join('\n');
}

// ---- syntax segments ----

export interface SyntaxSegment {
  text: string;
  /** Enclosing hljs classes, outermost first (rendered as nested spans). */
  classes: string[];
}

const lowlight = createLowlight(common);

/** Highlighting is skipped past this much text (one hunk, both sides). */
const HIGHLIGHT_CHAR_MAX = 60_000;

interface HastText {
  type: 'text';
  value: string;
}
interface HastElement {
  type: 'element';
  properties?: { className?: unknown };
  children: HastNode[];
}
type HastNode = HastText | HastElement | { type: string };

/**
 * Highlight a contiguous block and cut it into lines of segments. The whole
 * block is highlighted at once, so a construct spanning lines (a block
 * comment, a template string) keeps its colour on every line. null = no
 * grammar for `lang` (or the block is too big): render plain.
 */
export function highlightLines(text: string, lang: string | undefined): SyntaxSegment[][] | null {
  if (lang === undefined || text.length > HIGHLIGHT_CHAR_MAX || !lowlight.registered(lang)) {
    return null;
  }
  let tree: { children: HastNode[] };
  try {
    tree = lowlight.highlight(lang, text) as unknown as { children: HastNode[] };
  } catch {
    return null;
  }
  const lines: SyntaxSegment[][] = [[]];
  const walk = (nodes: HastNode[], classes: string[]) => {
    for (const node of nodes) {
      if (node.type === 'text') {
        const parts = (node as HastText).value.split('\n');
        parts.forEach((part, i) => {
          if (i > 0) lines.push([]);
          if (part !== '') lines[lines.length - 1]!.push({ text: part, classes });
        });
      } else if (node.type === 'element') {
        const el = node as HastElement;
        const cls = el.properties?.className;
        const own = Array.isArray(cls) ? cls.filter((c): c is string => typeof c === 'string') : [];
        walk(el.children, own.length > 0 ? [...classes, own.join(' ')] : classes);
      }
    }
  };
  walk(tree.children, []);
  // Mirror splitLines: one trailing newline is not an extra line.
  if (text.endsWith('\n') && lines.length > 1 && lines[lines.length - 1]!.length === 0) {
    lines.pop();
  }
  return lines;
}

export interface MarkedSegment extends SyntaxSegment {
  marked: boolean;
}

/**
 * One line's syntax segments cut at the word-mark boundaries. `segments`
 * null = the line rendered plain (one unclassed segment).
 */
export function markSegments(
  text: string,
  segments: SyntaxSegment[] | null,
  marks: DiffLine['marks'],
): MarkedSegment[] {
  const base = segments ?? (text === '' ? [] : [{ text, classes: [] }]);
  if (marks === undefined || marks.length === 0) return base.map((s) => ({ ...s, marked: false }));
  const out: MarkedSegment[] = [];
  let pos = 0;
  let m = 0;
  for (const seg of base) {
    let start = 0;
    while (start < seg.text.length) {
      const abs = pos + start;
      while (m < marks.length && marks[m]![1] <= abs) m += 1;
      const mark = marks[m];
      const inMark = mark !== undefined && mark[0] <= abs;
      const boundary = inMark ? mark[1] : mark !== undefined ? mark[0] : Infinity;
      const end = Math.min(seg.text.length, boundary - pos);
      out.push({ text: seg.text.slice(start, end), classes: seg.classes, marked: inMark });
      start = end;
    }
    pos += seg.text.length;
  }
  return out;
}
