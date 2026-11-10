// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { Fragment, memo, useMemo, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import { CopyButton } from './blocks.js';
import {
  buildDiffFiles,
  highlightLines,
  markSegments,
  unifiedText,
  type DiffFile,
  type DiffHunk,
  type DiffLine,
  type DiffSource,
  type MarkedSegment,
  type SyntaxSegment,
} from './diff-model.js';
import { langFromPath } from './tool-meta.js';

/**
 * #121 — the edit diff: GitLab's STRUCTURE in the theme's MATERIALS. From
 * GitLab: old/new line-number gutters, a sign column, `@@` hunk bands,
 * word-level marks on paired changed lines, a file header with +N −M. From
 * the console's design language: it is protocol material in a well; the
 * tints are faint and derived from the well's own status inks (`--diff-*`,
 * declared per well so a skin's LCD inks carry); code keeps the well ink plus
 * the token-based syntax colours; hunk bands are neutral (never the accent);
 * and the sign column is always there — colour is never the only signal.
 */

/** `+N −M` in the status inks (`page` on a card header, `well` inside one). */
export function DiffStatText({
  added,
  removed,
  tone,
}: {
  added: number;
  removed: number;
  tone: 'page' | 'well';
}) {
  const { t } = useI18n();
  const label = t('chat.diffStatTitle', { added, removed });
  return (
    <span
      className="shrink-0 font-mono text-[10px] tabular-nums"
      title={label}
      aria-label={label}
      data-diff-stat
    >
      <span className={tone === 'well' ? 'text-well-ok' : 'text-state-ok-ink'}>+{added}</span>{' '}
      <span className={tone === 'well' ? 'text-well-fail' : 'text-state-fail-ink'}>−{removed}</span>
    </span>
  );
}

function Segments({ segs, kind }: { segs: MarkedSegment[]; kind: DiffLine['kind'] }) {
  return (
    <>
      {segs.map((s, i) => {
        let node: ReactNode = s.text;
        for (let c = s.classes.length - 1; c >= 0; c -= 1) {
          node = <span className={s.classes[c]}>{node}</span>;
        }
        return s.marked ? (
          <span
            key={i}
            data-diff-mark
            className={cn(
              'rounded-[2px]',
              kind === 'add' ? 'bg-(--diff-add-word)' : 'bg-(--diff-del-word)',
            )}
          >
            {node}
          </span>
        ) : (
          <Fragment key={i}>{node}</Fragment>
        );
      })}
    </>
  );
}

/** A side's syntax line, only if it reproduces the diff line verbatim. */
function syntaxFor(lines: SyntaxSegment[][] | null, idx: number | undefined, text: string) {
  if (lines === null || idx === undefined) return null;
  const segs = lines[idx];
  if (segs === undefined) return null;
  return segs.map((s) => s.text).join('') === text ? segs : null;
}

const GUTTER =
  'text-muted-foreground/60 w-[1%] px-2 text-right align-top whitespace-nowrap tabular-nums select-none';

function HunkRows({
  hunk,
  first,
  lang,
  numbered,
}: {
  hunk: DiffHunk;
  first: boolean;
  lang: string | undefined;
  numbered: boolean;
}) {
  const oldSyntax = useMemo(() => highlightLines(hunk.oldText, lang), [hunk.oldText, lang]);
  const newSyntax = useMemo(() => highlightLines(hunk.newText, lang), [hunk.newText, lang]);
  const span = numbered ? 4 : 2;
  return (
    <>
      {hunk.header !== null ? (
        <tr data-diff-row="hunk">
          <td
            colSpan={span}
            className="bg-(--diff-hunk-bg) px-3 text-[11px] text-(--diff-hunk-ink) select-none"
          >
            {hunk.header}
          </td>
        </tr>
      ) : !first ? (
        <tr data-diff-row="gap">
          <td colSpan={span} className="text-muted-foreground/60 px-3 select-none">
            ⋯
          </td>
        </tr>
      ) : null}
      {hunk.lines.map((line, i) => {
        const syntax =
          line.kind === 'del'
            ? syntaxFor(oldSyntax, line.oldIdx, line.text)
            : syntaxFor(newSyntax, line.newIdx, line.text);
        const edge =
          line.kind === 'add'
            ? 'shadow-[inset_2px_0_0_var(--diff-add-edge)]'
            : line.kind === 'del'
              ? 'shadow-[inset_2px_0_0_var(--diff-del-edge)]'
              : '';
        return (
          <tr
            key={i}
            data-diff-row={line.kind}
            className={cn(
              line.kind === 'add' && 'bg-(--diff-add-row)',
              line.kind === 'del' && 'bg-(--diff-del-row)',
            )}
          >
            {numbered ? (
              <>
                <td className={cn(GUTTER, edge)}>{line.oldNo ?? ''}</td>
                <td className={GUTTER}>{line.newNo ?? ''}</td>
              </>
            ) : null}
            <td
              className={cn(
                'w-[1%] pr-1 pl-2 text-center align-top whitespace-pre select-none',
                !numbered && edge,
                line.kind === 'add' && 'text-(--diff-sign-add)',
                line.kind === 'del' && 'text-(--diff-sign-del)',
              )}
            >
              {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
            </td>
            <td className="pr-3 whitespace-pre">
              <Segments segs={markSegments(line.text, syntax, line.marks)} kind={line.kind} />
            </td>
          </tr>
        );
      })}
    </>
  );
}

function FileDiff({ file }: { file: DiffFile }) {
  const lang = langFromPath(file.path);
  const numbered = file.hunks.some((h) =>
    h.lines.some((l) => l.oldNo !== undefined || l.newNo !== undefined),
  );
  const copy = useMemo(() => unifiedText([file]), [file]);
  return (
    <section data-diff-file={file.path}>
      <div className="text-muted-foreground flex items-center justify-between gap-2 border-b px-3 py-1">
        <span className="truncate font-mono text-[11px]" title={file.path}>
          {file.path}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <DiffStatText added={file.added} removed={file.removed} tone="well" />
          <CopyButton text={copy} />
        </span>
      </div>
      <div className="max-h-96 overflow-auto">
        <table className="w-full border-collapse font-mono text-xs leading-5">
          <tbody>
            {file.hunks.map((hunk, i) => (
              <HunkRows key={i} hunk={hunk} first={i === 0} lang={lang} numbered={numbered} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export const DiffView = memo(function DiffView({ sources }: { sources: DiffSource[] }) {
  const files = useMemo(() => buildDiffFiles(sources), [sources]);
  if (files.length === 0) return null;
  return (
    <div
      data-surface="well"
      data-slot="diff-view"
      className="bg-muted/50 divide-y overflow-hidden rounded-md border"
    >
      {files.map((file, i) => (
        <FileDiff key={i} file={file} />
      ))}
    </div>
  );
});
