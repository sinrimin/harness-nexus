import type { ToolCallNode } from './fold.js';

/**
 * Pure helpers feeding the tool cards (Phase 9 W6) — ported from the portal
 * reference's model/toolMeta.ts: one-line argument previews, cwd-relative
 * paths, Read-line windows (with the `cat -n` fence hint), search-output
 * parsing, and Bash command/description splitting.
 */

type UnknownRecord = Record<string, unknown>;

export function relativizeToCwd(path: string, cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return path;
  if (path === cwd) return '.';
  if (path.startsWith(cwd + '/')) return path.slice(cwd.length + 1);
  return path;
}

/** Main path of a file tool: locations → rawInput.file_path/path → content. */
export function mainPath(node: ToolCallNode): string | undefined {
  const loc = node.locations?.[0]?.path;
  if (loc !== undefined && loc !== '') return loc;
  const raw = (node.rawInput ?? {}) as UnknownRecord;
  if (typeof raw.file_path === 'string') return raw.file_path;
  if (typeof raw.path === 'string') return raw.path;
  return node.content?.find((c) => c.path !== undefined)?.path;
}

/** A short argument preview for collapsed rows (never the full payload). */
export function toolArgumentsPreview(node: ToolCallNode): string {
  const raw = (node.rawInput ?? {}) as UnknownRecord;
  for (const key of [
    'pattern',
    'query',
    'url',
    'prompt',
    'description',
    'path',
    'file_path',
    'command',
  ]) {
    const v = raw[key];
    if (typeof v === 'string' && v !== '') return v.length > 120 ? `${v.slice(0, 117)}…` : v;
  }
  if (node.title !== undefined && node.title !== '') {
    return node.title.length > 120 ? `${node.title.slice(0, 117)}…` : node.title;
  }
  return '';
}

export function firstOutputLine(node: ToolCallNode): string | null {
  if (typeof node.output !== 'string' || node.output === '') return null;
  const i = node.output.indexOf('\n');
  const line = i === -1 ? node.output : node.output.slice(0, i);
  return line.trim() === '' ? null : line;
}

interface ReadParse {
  lines: { number: number; text: string }[];
  totalLines: number;
  /** Fence hint some tools prefix: `cat -n` output carries leading numbers. */
  langHint?: string;
}

/** Read bodies: `output` text → numbered lines; fenced suffixes honored. */
export function parseReadLines(text: string): ReadParse {
  if (text === '') return { lines: [], totalLines: 0 };
  const catStyle = /^\s{1,6}(\d+)\t(.*)$/.exec(text.split('\n')[0] ?? '');
  if (catStyle !== null && /^\s{1,6}\d+\t/.test(text.split('\n')[1] ?? 'x')) {
    const lines = text
      .split('\n')
      .map((line) => /^\s{1,6}(\d+)\t(.*)$/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({ number: Number(m[1]), text: m[2] ?? '' }));
    return { lines, totalLines: lines.length };
  }
  const raw = text.split('\n');
  const body = raw[raw.length - 1] === '' ? raw.slice(0, -1) : raw;
  return {
    lines: body.map((line, i) => ({ number: i + 1, text: line })),
    totalLines: body.length,
  };
}

interface BashParts {
  command: string;
  description: string | null;
}

export function bashCommandParts(node: ToolCallNode): BashParts {
  const raw = (node.rawInput ?? {}) as UnknownRecord;
  const command = typeof raw.command === 'string' ? raw.command : (node.title ?? '');
  const description =
    typeof raw.description === 'string' && raw.description !== '' ? raw.description : null;
  return { command, description };
}

interface EditParts {
  path: string;
  oldText: string | null;
  newText: string | null;
}

/** Edit/Write diff inputs: structured content first, rawInput fallback. */
export function editDiffParts(node: ToolCallNode): EditParts | null {
  const diff = node.content?.find((c) => c.type === 'diff');
  if (diff !== undefined) {
    return {
      path: diff.path ?? mainPath(node) ?? '',
      oldText: diff.oldText ?? null,
      newText: diff.newText ?? null,
    };
  }
  const raw = (node.rawInput ?? {}) as UnknownRecord;
  const hasEdit =
    (typeof raw.old_string === 'string' && typeof raw.new_string === 'string') ||
    (typeof raw.edits === 'object' && raw.edits !== null);
  if (!hasEdit) return null;
  const path = mainPath(node) ?? '';
  if (typeof raw.old_string === 'string' && typeof raw.new_string === 'string') {
    return { path, oldText: raw.old_string, newText: raw.new_string };
  }
  const edits = Array.isArray(raw.edits)
    ? (raw.edits as UnknownRecord[]).filter((e) => typeof e === 'object' && e !== null)
    : [];
  if (edits.length === 0) return null;
  return {
    path,
    oldText: typeof edits[0]?.old_string === 'string' ? (edits[0]!.old_string as string) : null,
    newText: typeof edits[0]?.new_string === 'string' ? (edits[0]!.new_string as string) : null,
  };
}

type SearchParse =
  | { kind: 'matches'; files: { path: string; matches: { lineNumber: number; line: string }[] }[] }
  | { kind: 'paths'; paths: string[] };

/** Grep-style output (`path:line:text`) vs Glob-style (one path per line). */
export function parseSearchOutput(text: string): SearchParse | null {
  if (text === '') return null;
  const lines = text.split('\n').filter((l) => l !== '');
  if (lines.length === 0) return null;
  const matchLines = lines.filter((l) => /^[^:\s]+:\d+:/.test(l));
  if (matchLines.length >= Math.ceil(lines.length / 2)) {
    const files = new Map<string, { lineNumber: number; line: string }[]>();
    for (const line of lines) {
      const m = /^([^:\s]+):(\d+):(.*)$/.exec(line);
      if (m === null) continue;
      const list = files.get(m[1]!) ?? [];
      list.push({ lineNumber: Number(m[2]), line: m[3] ?? '' });
      files.set(m[1]!, list);
    }
    return {
      kind: 'matches',
      files: [...files.entries()].map(([path, matches]) => ({ path, matches })),
    };
  }
  return { kind: 'paths', paths: lines };
}

/** Language tag from a path extension (Read block banner). */
export function langFromPath(path: string): string | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  if (ext === undefined) return undefined;
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    md: 'markdown',
    py: 'python',
    rs: 'rust',
    go: 'go',
    sh: 'bash',
    bash: 'bash',
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'toml',
    css: 'css',
    html: 'html',
    sql: 'sql',
  };
  return map[ext] ?? ext;
}
