import { memo, useMemo, useState } from 'react';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import { useCopyFeedback } from './copy-feedback.js';

/**
 * The Block family — expandable tool-card bodies (Phase 9 W6), ported from
 * the portal reference: Read (line numbers + head/tail cap), Diff (pure text
 * colors), Terminal (banner + capped output), Search (grouped matches / path
 * list), IoCard (IN/OUT), Todo checklist. Shared chrome: 8-line head/tail
 * cap with in-place expand, copy with 1s settle, IBM Plex Mono for anything
 * machine-shaped.
 */

const MAX_LINES = 8;

function headTailCap(
  count: number,
  expanded: boolean,
): {
  hidden: number;
  capped: boolean;
  headLines: number;
  tailLines: number;
} {
  const hidden = count - MAX_LINES;
  const capped = hidden > 0 && !expanded;
  const headLines = Math.ceil(MAX_LINES / 2);
  return { hidden, capped, headLines, tailLines: MAX_LINES - headLines };
}

function ExpandButton({
  expanded,
  hidden,
  onClick,
}: {
  expanded: boolean;
  hidden: number;
  onClick: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onClick}
      className="text-muted-foreground hover:text-foreground w-full py-1 text-center text-[11px] transition-colors"
    >
      {expanded ? t('chat.collapse') : t('chat.moreLines', { count: hidden })}
    </button>
  );
}

function CopyButton({ text }: { text: string }) {
  const { copied, onCopy } = useCopyFeedback();
  return (
    <button
      type="button"
      onClick={() => onCopy(text)}
      className="text-muted-foreground hover:text-foreground flex items-center transition-colors"
      aria-label="Copy"
    >
      {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
    </button>
  );
}

// ---- Read ----

interface ReadLine {
  number: number;
  text: string;
}

export const ReadBlock = memo(function ReadBlock({
  label,
  lines,
  totalLines,
}: {
  label: string;
  lines: ReadLine[];
  totalLines: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const raw = useMemo(() => lines.map((l) => l.text).join('\n'), [lines]);
  const windowed = lines.length < totalLines;
  const { hidden, capped, headLines, tailLines } = headTailCap(lines.length, expanded);
  const head = capped ? lines.slice(0, headLines) : lines;
  const tail = capped ? lines.slice(lines.length - tailLines) : [];
  const render = (slice: ReadLine[]) =>
    slice.map((l) => (
      <div key={l.number} className="flex gap-3 whitespace-pre">
        <span className="text-muted-foreground/60 w-10 shrink-0 text-right tabular-nums select-none">
          {l.number}
        </span>
        <span className="min-w-0">{l.text}</span>
      </div>
    ));
  return (
    <div data-surface="well" className="bg-muted/50 overflow-hidden rounded-md border">
      <div className="text-muted-foreground flex items-center justify-between gap-2 border-b px-3 py-1">
        <span className="truncate font-mono text-[11px]" title={label}>
          {label}
        </span>
        <span className="flex shrink-0 items-center gap-2 font-mono text-[10px]">
          {windowed ? (
            <span className="tabular-nums">
              {lines.length} / {totalLines}
            </span>
          ) : null}
          <CopyButton text={raw} />
        </span>
      </div>
      <div className="overflow-x-auto p-2 font-mono text-xs leading-5">
        {render(head)}
        {hidden > 0 ? (
          <ExpandButton
            expanded={expanded}
            hidden={hidden}
            onClick={() => setExpanded((v) => !v)}
          />
        ) : null}
        {capped ? render(tail) : null}
      </div>
    </div>
  );
});

// ---- Diff ----

interface DiffHunk {
  path: string;
  oldText: string | null;
  newText: string;
}

interface DiffRow {
  kind: 'path' | 'del' | 'add' | 'gap';
  text: string;
}

function contentLines(text: string): string[] {
  if (text === '') return [];
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return body.split('\n');
}

export const DiffBlock = memo(function DiffBlock({ diffs }: { diffs: DiffHunk[] }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const { rows, added, removed, files } = useMemo(() => {
    const out: DiffRow[] = [];
    const paths = new Set<string>();
    let a = 0;
    let r = 0;
    let prev: string | undefined;
    for (const diff of diffs) {
      paths.add(diff.path);
      if (diff.path !== prev) out.push({ kind: 'path', text: diff.path });
      else out.push({ kind: 'gap', text: '⋯' });
      prev = diff.path;
      if (diff.oldText !== null && diff.oldText !== undefined) {
        for (const line of contentLines(diff.oldText)) {
          out.push({ kind: 'del', text: line });
          r++;
        }
      }
      for (const line of contentLines(diff.newText)) {
        out.push({ kind: 'add', text: line });
        a++;
      }
    }
    return { rows: out, added: a, removed: r, files: paths.size };
  }, [diffs]);

  if (rows.length === 0) return null;
  const { hidden, capped, headLines, tailLines } = headTailCap(rows.length, expanded);
  const head = capped ? rows.slice(0, headLines) : rows;
  const tail = capped ? rows.slice(rows.length - tailLines) : [];
  const render = (slice: DiffRow[], keyPrefix: string) =>
    slice.map((row, i) => (
      <div
        key={`${keyPrefix}${i}`}
        className={cn(
          'flex gap-2 whitespace-pre',
          row.kind === 'path' && 'text-foreground truncate pt-1 font-medium',
          row.kind === 'del' && 'text-danger',
          row.kind === 'add' && 'text-ok',
          row.kind === 'gap' && 'text-muted-foreground/60',
        )}
      >
        <span className="text-muted-foreground/60 w-3 shrink-0 select-none">
          {row.kind === 'del' ? '-' : row.kind === 'add' ? '+' : ''}
        </span>
        <span className="min-w-0">{row.text}</span>
      </div>
    ));
  return (
    <div data-surface="well" className="bg-muted/50 overflow-hidden rounded-md border">
      <div className="relative">
        <div className="text-muted-foreground absolute top-1.5 right-2 z-10">
          <CopyButton
            text={rows
              .map((r) =>
                r.kind === 'del' ? `- ${r.text}` : r.kind === 'add' ? `+ ${r.text}` : r.text,
              )
              .join('\n')}
          />
        </div>
        <div className="overflow-x-auto p-2 font-mono text-xs leading-5">
          {render(head, '')}
          {hidden > 0 ? (
            <ExpandButton
              expanded={expanded}
              hidden={hidden}
              onClick={() => setExpanded((v) => !v)}
            />
          ) : null}
          {capped ? render(tail, 't') : null}
        </div>
      </div>
      <div className="text-muted-foreground border-t px-3 py-1 font-mono text-[10px] tabular-nums">
        └ +{added} -{removed} · {t('chat.diffFiles', { count: files })}
      </div>
    </div>
  );
});

// ---- Terminal ----

export const TerminalBlock = memo(function TerminalBlock({
  command,
  cwd,
  output,
  running,
  failed,
}: {
  command: string;
  cwd?: string;
  output?: string;
  running?: boolean;
  failed?: boolean;
}) {
  const { t } = useI18n();
  const text = output ?? '';
  const lines = useMemo(() => {
    const body = text.endsWith('\n') ? text.slice(0, -1) : text;
    return body === '' ? [] : body.split('\n');
  }, [text]);
  const commandLines = useMemo(() => {
    const body = command.endsWith('\n') ? command.slice(0, -1) : command;
    return body === '' ? [] : body.split('\n');
  }, [command]);
  const promptLabel = cwd !== undefined && cwd !== '' ? `${cwdBasename(cwd)} $` : '$';
  const dot = running ? 'bg-warn lamp-breath' : failed ? 'bg-danger' : 'bg-ok';
  const empty = !running && lines.length === 0;
  return (
    <div data-surface="well" className="bg-muted/50 overflow-hidden rounded-md border">
      <div className="flex items-start gap-2 border-b px-3 py-1.5">
        <span className={cn('mt-1.5 size-1.5 shrink-0 rounded-full', dot)} aria-hidden />
        <div className="min-w-0 flex-1 font-mono text-xs break-all">
          {commandLines.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap">
              <span className="text-muted-foreground">{i === 0 ? promptLabel : '$'}</span> {line}
            </div>
          ))}
        </div>
        {!running && !empty ? (
          <span className="shrink-0">
            <CopyButton text={text} />
          </span>
        ) : null}
      </div>
      {empty ? (
        <div className="text-muted-foreground px-3 py-2 font-mono text-xs">
          {t('chat.noOutput')}
        </div>
      ) : (
        <div className="max-h-56 overflow-auto p-2 font-mono text-xs leading-5">
          {lines.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap break-all">
              {line}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

function cwdBasename(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, '');
  const last = trimmed.split('/').pop();
  return last === undefined || last === '' ? cwd : last;
}

// ---- Search ----

interface SearchFileGroup {
  path: string;
  matches: { lineNumber: number; line: string }[];
}

export const SearchBlock = memo(function SearchBlock({
  kind,
  files = [],
  paths = [],
}: {
  kind: 'matches' | 'paths';
  files?: SearchFileGroup[];
  paths?: string[];
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<number>>(() => new Set());
  const shown = kind === 'paths' ? paths.length : files.reduce((s, f) => s + f.matches.length, 0);
  const summary =
    kind === 'paths'
      ? t('chat.searchPaths', { count: shown })
      : t('chat.searchMatches', { count: shown, files: files.length });
  const rows = useMemo(() => {
    if (kind === 'paths') return paths.map((p) => ({ type: 'path' as const, path: p }));
    const out: (
      | { type: 'file'; path: string; count: number; index: number }
      | { type: 'match'; lineNumber: number; line: string; key: string }
      | { type: 'path'; path: string }
    )[] = [];
    files.forEach((file, index) => {
      out.push({ type: 'file', path: file.path, count: file.matches.length, index });
      if (collapsed.has(index)) return;
      for (const m of file.matches) {
        out.push({
          type: 'match',
          lineNumber: m.lineNumber,
          line: m.line,
          key: `${index}:${m.lineNumber}`,
        });
      }
    });
    return out;
  }, [kind, paths, files, collapsed]);

  if (rows.length === 0) {
    return (
      <div className="text-muted-foreground bg-muted/50 rounded-md border px-3 py-2 font-mono text-xs">
        {t('chat.searchEmpty')}
      </div>
    );
  }
  const { hidden, capped, headLines, tailLines } = headTailCap(rows.length, expanded);
  const head = capped ? rows.slice(0, headLines) : rows;
  const tail = capped ? rows.slice(rows.length - tailLines) : [];
  const render = (slice: typeof rows, keyPrefix: string) =>
    slice.map((row, i) => {
      const key = `${keyPrefix}${i}`;
      if (row.type === 'path') {
        return (
          <div key={key} className="truncate font-mono">
            {row.path}
          </div>
        );
      }
      if (row.type === 'match') {
        return (
          <div key={key} className="text-muted-foreground whitespace-pre font-mono">
            <span className="text-muted-foreground/60 tabular-nums">{row.lineNumber}: </span>
            {row.line}
          </div>
        );
      }
      return (
        <button
          key={key}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setCollapsed((prev) => {
              const next = new Set(prev);
              if (next.has(row.index)) next.delete(row.index);
              else next.add(row.index);
              return next;
            });
          }}
          className="text-foreground flex w-full items-center justify-between gap-2 pt-1 font-mono font-medium"
        >
          <span className="truncate">{row.path}</span>
          <span className="text-muted-foreground shrink-0 text-[10px] tabular-nums">
            {row.count}
          </span>
        </button>
      );
    });
  return (
    <div data-surface="well" className="bg-muted/50 overflow-hidden rounded-md border">
      <div className="text-muted-foreground flex items-center justify-between border-b px-3 py-1 font-mono text-[10px]">
        <span>{summary}</span>
        <CopyButton
          text={
            kind === 'paths'
              ? paths.join('\n')
              : files
                  .map((f) =>
                    [f.path, ...f.matches.map((m) => `${m.lineNumber}: ${m.line}`)].join('\n'),
                  )
                  .join('\n\n')
          }
        />
      </div>
      <div className="overflow-x-auto p-2 font-mono text-xs leading-5">
        {render(head, '')}
        {hidden > 0 ? (
          <ExpandButton
            expanded={expanded}
            hidden={hidden}
            onClick={() => setExpanded((v) => !v)}
          />
        ) : null}
        {capped ? render(tail, 't') : null}
      </div>
    </div>
  );
});

// ---- Io (generic IN/OUT) ----

export const IoCard = memo(function IoCard({
  body,
  output,
  failed,
}: {
  body?: string | null;
  output?: string | null;
  failed?: boolean;
}) {
  const { t } = useI18n();
  if (body === null && output === null) return null;
  return (
    <div className="bg-muted/50 grid gap-px overflow-hidden rounded-md border sm:grid-cols-2">
      {body != null ? (
        <div className="flex gap-2 p-2">
          <span className="text-muted-foreground/60 shrink-0 font-mono text-[10px] tracking-wide uppercase">
            {t('chat.ioIn')}
          </span>
          <pre className="max-h-48 min-w-0 overflow-auto font-mono text-xs leading-5 whitespace-pre-wrap">
            {body}
          </pre>
        </div>
      ) : null}
      {output != null ? (
        <div className="flex gap-2 p-2">
          <span className="text-muted-foreground/60 shrink-0 font-mono text-[10px] tracking-wide uppercase">
            {t('chat.ioOut')}
          </span>
          <pre
            className={cn(
              'max-h-48 min-w-0 overflow-auto font-mono text-xs leading-5 whitespace-pre-wrap',
              failed && 'text-destructive',
            )}
          >
            {output}
          </pre>
        </div>
      ) : null}
    </div>
  );
});

// ---- Todo checklist ----

export const TodoList = memo(function TodoList({
  todos,
}: {
  todos: { content?: string; status?: string }[];
}) {
  const inProgress = todos.filter((x) => x.status === 'in_progress').length;
  const done = todos.filter((x) => x.status === 'completed').length;
  return (
    <div className="bg-muted/50 rounded-md border p-2">
      <ul className="flex flex-col gap-1 text-xs">
        {todos.map((todo, i) => (
          <li key={i} className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0" aria-hidden>
              {todo.status === 'completed' ? '●' : todo.status === 'in_progress' ? '◐' : '○'}
            </span>
            <span
              className={cn(
                'min-w-0',
                todo.status === 'completed' && 'text-muted-foreground line-through',
              )}
            >
              {todo.content ?? ''}
            </span>
          </li>
        ))}
      </ul>
      <div className="text-muted-foreground mt-1.5 font-mono text-[10px] tabular-nums">
        {todos.length} · {done} ✓ · {inProgress} ◐
      </div>
    </div>
  );
});
