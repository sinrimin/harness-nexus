// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SquareNoteView } from '@harness-nexus/sdk';
import { HarnessNexusError } from '@harness-nexus/sdk';
import { useI18n } from '@/i18n';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SearchIcon } from 'lucide-react';
import { EmptyState, Panel, PanelBody, PanelHeader, Skeleton } from '@/components/kit';
import { NOTES_PAGE_SIZE } from './NotesPage';
import { shortDate } from './vocabulary';

/**
 * 广场 — every user's public notes, read-only. The card carries the author
 * (avatar initial + name, enriched server-side) and the note's content
 * version; annotations and edit actions do not exist here by design — the
 * public surface is the note ROW, nothing else (#88 scope rule).
 */
export function SquareFeed({
  notes,
  error,
  onRetry,
}: {
  notes: SquareNoteView[] | null;
  error: unknown;
  onRetry: () => void;
}) {
  const { t, lang } = useI18n();
  const [q, setQ] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const visible = useMemo(() => {
    if (notes === null) return null;
    const needle = q.trim().toLowerCase();
    return notes.filter(
      (n) =>
        (needle === '' ||
          n.title.toLowerCase().includes(needle) ||
          (n.summary ?? '').toLowerCase().includes(needle)) &&
        (tag === null || n.tags.includes(tag)),
    );
  }, [notes, q, tag]);

  const pageCount = visible === null ? 1 : Math.max(1, Math.ceil(visible.length / NOTES_PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const rows =
    visible === null
      ? null
      : visible.slice((safePage - 1) * NOTES_PAGE_SIZE, safePage * NOTES_PAGE_SIZE);

  const hotTags = useMemo(() => {
    if (notes === null) return [];
    const counts = new Map<string, number>();
    for (const n of notes) for (const tg of n.tags) counts.set(tg, (counts.get(tg) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [notes]);

  function selectTag(next: string | null): void {
    setTag(next);
    setPage(1);
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-[18px] min-[900px]:flex-row">
      <div className="flex min-w-0 flex-1 flex-col min-[900px]:min-h-0">
        <div className="flex min-[900px]:min-h-0 min-[900px]:flex-1 flex-col gap-[9px] min-[900px]:overflow-y-auto min-[900px]:pr-1">
          {error !== null && notes === null ? (
            <EmptyState
              title={t('notes.loadFailed')}
              code={error instanceof HarnessNexusError ? error.code : undefined}
              action={
                <Button variant="outline" size="sm" onClick={onRetry}>
                  {t('notes.retry')}
                </Button>
              }
            />
          ) : null}
          {notes === null && error === null
            ? [0, 1, 2].map((i) => <Skeleton key={i} className="h-28 w-full" />)
            : null}
          {rows !== null && rows.length === 0 ? (
            <EmptyState title={t('notes.squareEmptyTitle')} hint={t('notes.squareEmptyHint')} />
          ) : null}
          {rows?.map((n) => (
            <article
              key={`${n.ownerId}/${n.id}`}
              className="bg-card text-card-foreground shadow-(--shadow-panel) relative flex flex-col gap-[5px] rounded-(--radius-panel) border px-4 pb-2.5 pt-3"
            >
              <div className="flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="bg-tray border text-muted-foreground role-data-sm flex size-[18px] items-center justify-center rounded-full"
                >
                  {n.ownerName.slice(0, 1)}
                </span>
                <span className="text-xs font-medium">{n.ownerName}</span>
                <span className="role-data-sm text-muted-foreground">
                  · {shortDate(n.createdAt, lang)}
                </span>
              </div>
              <h3 className="text-sm leading-snug font-semibold tracking-tight">
                <Link to={`/notes/${n.id}`} className="after:absolute after:inset-0">
                  {n.title}
                </Link>
              </h3>
              {n.summary !== null && n.summary !== '' ? (
                <p className="text-muted-foreground line-clamp-2 text-xs leading-relaxed">
                  {n.summary}
                </p>
              ) : null}
              <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                {n.tags.map((tg) => (
                  <Badge
                    key={tg}
                    variant="secondary"
                    className="text-muted-foreground px-1.5 py-0 text-[10.5px] font-normal"
                  >
                    {tg}
                  </Badge>
                ))}
                <span className="role-data-sm text-muted-foreground ml-auto">
                  {t('notes.versionChip', { version: n.contentVersion })}
                </span>
              </div>
            </article>
          ))}
        </div>
        {visible !== null && pageCount > 1 ? (
          <div className="flex shrink-0 flex-wrap items-center justify-center gap-2.5 pt-2">
            <span className="role-data-sm text-muted-foreground">
              {t('notes.pageOf', { page: safePage })} / {pageCount}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={safePage <= 1}
              onClick={() => setPage(safePage - 1)}
            >
              {t('notes.prevPage')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={safePage >= pageCount}
              onClick={() => setPage(safePage + 1)}
            >
              {t('notes.nextPage')}
            </Button>
          </div>
        ) : null}
      </div>

      <aside className="flex w-full shrink-0 flex-col gap-2.5 min-[900px]:w-[240px]">
        <div className="relative">
          <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
          <Input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            placeholder={t('notes.squareSearchPlaceholder')}
            className="h-8 pl-8 text-xs"
            autoComplete="off"
            spellCheck={false}
            aria-label={t('notes.squareSearchPlaceholder')}
          />
        </div>
        <Panel className="min-h-0 min-[900px]:flex-1">
          <PanelHeader label={t('notes.squareHotTags')} />
          <PanelBody variant="flush" className="overflow-y-auto">
            {notes !== null && hotTags.length === 0 ? (
              <p className="text-muted-foreground p-3 text-xs">{t('notes.squareEmptyHint')}</p>
            ) : notes === null ? null : (
              <div className="flex flex-wrap gap-[5px] p-2.5 pb-3">
                {hotTags.map(([name, count]) => (
                  <button
                    key={name}
                    type="button"
                    aria-pressed={tag === name}
                    onClick={() => selectTag(tag === name ? null : name)}
                    className={
                      tag === name
                        ? 'bg-tray text-foreground border-border role-data-sm inline-flex h-6 items-center gap-[5px] rounded border px-[7px] font-medium'
                        : 'text-muted-foreground hover:text-foreground bg-card border-border role-data-sm inline-flex h-6 items-center gap-[5px] rounded border px-[7px]'
                    }
                  >
                    {name} <b className="font-mono text-[10px] font-normal">{count}</b>
                  </button>
                ))}
              </div>
            )}
          </PanelBody>
        </Panel>
      </aside>
    </div>
  );
}
