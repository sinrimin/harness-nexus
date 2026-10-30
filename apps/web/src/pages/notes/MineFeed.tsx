// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  DownloadIcon,
  GlobeIcon,
  HighlighterIcon,
  LockIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
} from 'lucide-react';
import type { FeedNoteView } from '@harness-nexus/sdk';
import { HarnessNexusError } from '@harness-nexus/sdk';
import { useI18n } from '@/i18n';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ConfirmDialog, EmptyState, Skeleton } from '@/components/kit';
import { Lamp } from '@/components/kit/lamp';
import { NOTES_PAGE_SIZE, type CategoryFilter, type MineFilters } from './NotesPage';
import { NOTE_STATUS_KEY, NOTE_STATUS_STATE, downloadNoteMarkdown, shortDate } from './vocabulary';

/**
 * 我的信息流 — blog-shaped cards over the client-filtered window. The whole
 * card is the destination (a stretched link on the title row); the menu and
 * the annotation figure stay outside the hit area.
 */
export function MineFeed({
  notes,
  error,
  filters,
  categoryPath,
  onFilters,
  onRetry,
  onDelete,
}: {
  notes: FeedNoteView[] | null;
  error: unknown;
  filters: MineFilters;
  categoryPath: (id: string | null) => string;
  onFilters: (next: MineFilters) => void;
  onRetry: () => void;
  onDelete: (id: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [pending, setPending] = useState<FeedNoteView | null>(null);
  const [busy, setBusy] = useState(false);

  const visible = useMemo(() => {
    if (notes === null) return null;
    const q = filters.q.trim().toLowerCase();
    return notes.filter(
      (n) =>
        (q === '' ||
          n.title.toLowerCase().includes(q) ||
          (n.summary ?? '').toLowerCase().includes(q) ||
          n.contentMd.toLowerCase().includes(q)) &&
        categoryMatches(filters.category, n.categoryId) &&
        (filters.status === null || n.status === filters.status) &&
        (filters.tag === null || n.tags.includes(filters.tag)),
    );
  }, [notes, filters]);

  useEffect(() => {
    setPage(1);
  }, [filters]);

  const pageCount = visible === null ? 1 : Math.max(1, Math.ceil(visible.length / NOTES_PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pageRows =
    visible === null
      ? null
      : visible.slice((safePage - 1) * NOTES_PAGE_SIZE, safePage * NOTES_PAGE_SIZE);
  const capped = notes !== null && notes.length >= 100;

  async function confirmRemove(): Promise<void> {
    if (pending === null) return;
    setBusy(true);
    try {
      await onDelete(pending.id);
      setPending(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col min-[900px]:min-h-0">
      {/* Desktop owns the scroll (the row is height-capped); below 900px the
       * column stacks naturally inside the page's scroller — a fixed-height
       * list here made the cards spill over the sidebar beneath it. */}
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
        {pageRows !== null && pageRows.length === 0 ? (
          notes !== null && notes.length === 0 ? (
            <EmptyState
              title={t('notes.emptyTitle')}
              hint={t('notes.emptyHint')}
              action={
                <Button onClick={() => navigate('/notes/new')}>
                  <PlusIcon className="size-4" />
                  {t('notes.create')}
                </Button>
              }
            />
          ) : (
            <EmptyState
              title={t('notes.emptyFilteredTitle')}
              hint={t('notes.emptyFilteredHint')}
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onFilters({ q: '', category: null, status: null, tag: null })}
                >
                  {t('kit.clearFilters')}
                </Button>
              }
            />
          )
        ) : null}
        {pageRows?.map((n) => (
          <NoteCard
            key={n.id}
            note={n}
            categoryLine={categoryPath(n.categoryId)}
            onEdit={() => navigate(`/notes/${n.id}/edit`)}
            onDelete={() => setPending(n)}
          />
        ))}
      </div>

      {visible !== null && pageCount > 1 ? (
        <div className="flex shrink-0 flex-wrap items-center justify-center gap-2.5 pt-2">
          <span className="role-data-sm text-muted-foreground">
            {capped ? t('notes.loadedCap', { count: notes?.length ?? 0 }) : ''}
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

      {pending !== null ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) setPending(null);
          }}
          title={t('notes.delete')}
          consequence={t('notes.deleteConsequence')}
          impact={[{ label: t('notes.impactNote'), value: pending.title }]}
          actionLabel={t('notes.delete')}
          busy={busy}
          onConfirm={() => void confirmRemove()}
        />
      ) : null}
    </div>
  );
}

function categoryMatches(filter: CategoryFilter, noteCategoryId: string | null): boolean {
  if (filter === null) return true;
  if (filter === 'uncategorized') return noteCategoryId === null;
  return noteCategoryId === filter;
}

function NoteCard({
  note,
  categoryLine,
  onEdit,
  onDelete,
}: {
  note: FeedNoteView;
  categoryLine: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t, lang } = useI18n();
  return (
    <article className="bg-card text-card-foreground shadow-(--shadow-panel) relative flex flex-col gap-[5px] rounded-(--radius-panel) border px-4 pb-2.5 pt-3">
      {categoryLine !== '' ? (
        <span className="role-data-sm text-muted-foreground font-mono">{categoryLine}</span>
      ) : null}
      <h3 className="text-sm leading-snug font-semibold tracking-tight">
        <Link to={`/notes/${note.id}`} className="after:absolute after:inset-0">
          {note.title}
        </Link>
      </h3>
      {note.summary !== null && note.summary !== '' ? (
        <p className="text-muted-foreground line-clamp-2 text-xs leading-relaxed">{note.summary}</p>
      ) : null}
      <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
        <Lamp
          state={NOTE_STATUS_STATE[note.status]}
          word={t(NOTE_STATUS_KEY[note.status])}
          size="sm"
        />
        <Badge variant="outline" className="text-muted-foreground gap-1 px-1.5 py-0 text-[10.5px]">
          {note.visibility === 'public' ? (
            <GlobeIcon className="size-3" />
          ) : (
            <LockIcon className="size-3" />
          )}
          {t(note.visibility === 'public' ? 'notes.publicChip' : 'notes.privateChip')}
        </Badge>
        {note.tags.map((tag) => (
          <Badge
            key={tag}
            variant="secondary"
            className="text-muted-foreground px-1.5 py-0 text-[10.5px] font-normal"
          >
            {tag}
          </Badge>
        ))}
        {note.annotationCount > 0 ? (
          <span
            className={
              note.openAnnotationCount > 0
                ? 'role-data-sm text-state-warn-ink inline-flex items-center gap-1'
                : 'role-data-sm text-muted-foreground inline-flex items-center gap-1'
            }
          >
            <HighlighterIcon className="size-3" />
            {note.openAnnotationCount > 0
              ? t('notes.annotationOpenCount', { count: note.openAnnotationCount })
              : t('notes.annotationDoneCount', { count: note.annotationCount })}
          </span>
        ) : null}
        <span className="role-data-sm text-muted-foreground ml-auto">
          {shortDate(note.updatedAt, lang)}
        </span>
      </div>
      <div className="absolute top-1.5 right-1.5 z-10">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-(--row-ctl-h)">
              <MoreHorizontalIcon className="size-4" />
              <span className="sr-only">{t('common.openMenu')}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={onEdit}>
              <PencilIcon /> {t('notes.edit')}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => downloadNoteMarkdown(note.title, note.contentMd)}>
              <DownloadIcon /> {t('notes.download')}
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <TrashIcon /> {t('common.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </article>
  );
}
