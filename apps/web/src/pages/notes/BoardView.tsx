// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRightIcon, HighlighterIcon, MoreHorizontalIcon, TrashIcon } from 'lucide-react';
import type { FeedNoteView, NoteStatus } from '@harness-nexus/sdk';
import { HarnessNexusError } from '@harness-nexus/sdk';
import { useI18n } from '@/i18n';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ConfirmDialog, EmptyState } from '@/components/kit';
import { Lamp } from '@/components/kit/lamp';
import { NOTE_STATUSES, NOTE_STATUS_KEY, NOTE_STATUS_STATE, shortDate } from './vocabulary';

/** Per-column card cap — the board is a pipeline overview, not a second feed. */
const COLUMN_CAP = 6;

/**
 * 看板 — the personal reading pipeline. Own private notes only: a note the
 * owner has opened to the square left the pipeline (its audience is no longer
 * just the owner's reading flow), which keeps the columns finite.
 */
export function BoardView({
  notes,
  error,
  onRetry,
  onMove,
  onDelete,
}: {
  notes: FeedNoteView[] | null;
  error: unknown;
  onRetry: () => void;
  onMove: (id: string, status: NoteStatus) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [pending, setPending] = useState<FeedNoteView | null>(null);

  const columns = NOTE_STATUSES.map((status) => ({
    status,
    // Own PRIVATE notes only — a note opened to the square left the pipeline
    // (the hint row says so; this is where it is true).
    rows: (notes ?? []).filter((n) => n.status === status && n.visibility === 'private'),
  }));

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <p className="text-muted-foreground shrink-0 pb-2 text-right text-[11px]">
        {t('notes.boardHint')}
      </p>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1 max-[900px]:pr-0 min-[900px]:grid min-[900px]:grid-cols-4 min-[900px]:overflow-hidden">
        {error !== null && notes === null ? (
          <EmptyState
            className="min-[900px]:col-span-4"
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
          ? NOTE_STATUSES.map((s) => <SkeletonColumn key={s} />)
          : null}
        {notes !== null && notes.length === 0 ? (
          <EmptyState
            className="min-[900px]:col-span-4"
            title={t('notes.boardEmptyTitle')}
            hint={t('notes.boardEmptyHint')}
          />
        ) : null}
        {notes === null
          ? null
          : columns.map((col) => (
              <section
                key={col.status}
                className="bg-tray/55 border-border/55 flex min-h-0 flex-col gap-2 overflow-y-auto rounded-lg border p-2.5 max-[900px]:shrink-0"
                aria-label={t(NOTE_STATUS_KEY[col.status])}
              >
                <header className="flex items-center gap-1.5 px-0.5 pb-0.5">
                  <Lamp state={NOTE_STATUS_STATE[col.status]} size="sm" />
                  <h3 className="text-[10.5px] font-semibold tracking-wide">
                    {t(NOTE_STATUS_KEY[col.status])}
                  </h3>
                  <span className="role-data-sm text-muted-foreground ml-auto">
                    {col.rows.length}
                  </span>
                </header>
                {col.rows.slice(0, COLUMN_CAP).map((n) => (
                  <BoardCard key={n.id} note={n} onMove={onMove} onDelete={setPending} />
                ))}
                {col.rows.length > COLUMN_CAP ? (
                  <p className="text-muted-foreground role-data-sm py-1 text-center">
                    {t('notes.boardMore', { count: col.rows.length - COLUMN_CAP })}
                  </p>
                ) : null}
              </section>
            ))}
      </div>

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
          onConfirm={() => {
            const id = pending.id;
            setPending(null);
            void onDelete(id);
          }}
        />
      ) : null}
    </div>
  );
}

function SkeletonColumn() {
  return (
    <div className="bg-tray/55 border-border/55 flex min-h-24 flex-col gap-2 rounded-lg border p-2.5">
      <div className="bg-muted h-3 w-20 rounded" />
      <div className="bg-card h-14 rounded border" />
    </div>
  );
}

function BoardCard({
  note,
  onMove,
  onDelete,
}: {
  note: FeedNoteView;
  onMove: (id: string, status: NoteStatus) => Promise<void>;
  onDelete: (note: FeedNoteView) => void;
}) {
  const { t, lang } = useI18n();
  return (
    <article className="bg-card text-card-foreground shadow-(--shadow-panel) relative flex flex-col gap-1.5 rounded-md border p-2.5">
      <h4 className="relative text-xs leading-relaxed font-medium">
        <Link to={`/notes/${note.id}`} className="after:absolute after:inset-0">
          {note.title}
        </Link>
      </h4>
      {note.tags.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {note.tags.slice(0, 3).map((tag) => (
            <Badge
              key={tag}
              variant="secondary"
              className="text-muted-foreground px-1.5 py-0 text-[10.5px] font-normal"
            >
              {tag}
            </Badge>
          ))}
        </div>
      ) : null}
      <div className="text-muted-foreground flex items-center gap-2">
        <span className="role-data-sm">{shortDate(note.updatedAt, lang)}</span>
        {note.openAnnotationCount > 0 ? (
          <span className="role-data-sm text-state-warn-ink inline-flex items-center gap-1">
            <HighlighterIcon className="size-3" />
            {t('notes.annotationOpenCount', { count: note.openAnnotationCount })}
          </span>
        ) : null}
      </div>
      <div className="absolute top-1 right-1 z-10">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-(--row-ctl-h)">
              <MoreHorizontalIcon className="size-4" />
              <span className="sr-only">{t('common.openMenu')}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{t('notes.moveTo')}</DropdownMenuLabel>
            {NOTE_STATUSES.filter((s) => s !== note.status).map((s) => (
              <DropdownMenuItem key={s} onClick={() => void onMove(note.id, s)}>
                <ArrowRightIcon /> {t(NOTE_STATUS_KEY[s])}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => onDelete(note)}>
              <TrashIcon /> {t('common.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </article>
  );
}
