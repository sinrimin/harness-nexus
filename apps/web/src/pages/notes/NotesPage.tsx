// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import type { FeedNoteView, NoteCategory, NoteStatus, SquareNoteView } from '@harness-nexus/sdk';
import { HarnessNexusError } from '@harness-nexus/sdk';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n } from '@/i18n';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageSlot } from '@/components/shell/page-slots';
import { PageAction } from '@/components/shell/page-action';
import { MineFeed } from './MineFeed';
import { SquareFeed } from './SquareFeed';
import { BoardView } from './BoardView';
import { MineSidebar } from './MineSidebar';
import { NOTE_STATUS_KEY } from './vocabulary';

/**
 * Notes landing (#88) — three in-page tabs over one nav slot, mirroring the
 * Skills page's pattern: the tab is a URL parameter so a filtered view or the
 * square is shareable and back returns here.
 *
 * Data model: a personal library is dozens-to-hundreds of rows, so the page
 * loads the most recent 100 own notes (and the square's first 100) once and
 * filters/paginates client-side; the server-side search/pagination stays for
 * API/MCP consumers. The loaded cap is surfaced honestly (notes.loadedCap).
 */
export const NOTES_PAGE_SIZE = 20;
const NOTES_LOAD_CAP = 100;

/** `null` = all, `'uncategorized'` = the explicit null bucket, else a category id. */
export type CategoryFilter = string | 'uncategorized' | null;

export interface MineFilters {
  q: string;
  category: CategoryFilter;
  status: NoteStatus | null;
  tag: string | null;
}

export const EMPTY_FILTERS: MineFilters = { q: '', category: null, status: null, tag: null };

export function NotesPage() {
  const { t } = useI18n();
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab =
    params.get('tab') === 'square' ? 'square' : params.get('tab') === 'board' ? 'board' : 'mine';

  const [mine, setMine] = useState<FeedNoteView[] | null>(null);
  const [square, setSquare] = useState<SquareNoteView[] | null>(null);
  const [categories, setCategories] = useState<NoteCategory[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [filters, setFilters] = useState<MineFilters>(EMPTY_FILTERS);

  async function refresh(): Promise<void> {
    try {
      const [mineRes, squareRes, catRes] = await withAuthGuard(
        () =>
          Promise.all([
            api.listNotes({ limit: NOTES_LOAD_CAP }),
            api.listSquareNotes({ limit: NOTES_LOAD_CAP }),
            api.listNoteCategories(),
          ]),
        logout,
      );
      setMine(mineRes.notes);
      setSquare(squareRes.notes);
      setCategories(catRes.categories);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const selectTab = (next: 'mine' | 'square' | 'board'): void => {
    const params2 = new URLSearchParams(params);
    if (next === 'mine') params2.delete('tab');
    else params2.set('tab', next);
    setParams(params2, { replace: true });
  };

  /** Ancestor names joined with ' / ' — the card's mono category line. */
  const categoryPath = useMemo(() => {
    const byId = new Map((categories ?? []).map((c) => [c.id, c]));
    return (id: string | null): string => {
      if (id === null) return '';
      const names: string[] = [];
      let cur = byId.get(id);
      while (cur !== undefined) {
        names.unshift(cur.name);
        cur = cur.parentId !== null ? byId.get(cur.parentId) : undefined;
      }
      return names.join(' / ');
    };
  }, [categories]);

  async function removeNote(id: string): Promise<void> {
    try {
      await withAuthGuard(() => api.deleteNote(id), logout);
      setMine((prev) => prev?.filter((n) => n.id !== id) ?? prev);
      toast.success(t('notes.deletedToast'));
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.deleteFailed'));
    }
  }

  async function moveStatus(id: string, status: NoteStatus): Promise<void> {
    try {
      await withAuthGuard(() => api.updateNote(id, { status }), logout);
      setMine((prev) => prev?.map((n) => (n.id === id ? { ...n, status } : n)) ?? prev);
      toast.success(t('notes.statusMovedToast', { status: t(NOTE_STATUS_KEY[status]) }));
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.saveFailed'));
    }
  }

  async function refreshCategories(): Promise<void> {
    try {
      const catRes = await withAuthGuard(() => api.listNoteCategories(), logout);
      setCategories(catRes.categories);
    } catch {
      // A failed sidebar refresh keeps the previous tree; the main list is intact.
    }
  }

  /** Deleting a category re-shelves its notes — the tree AND the rows move. */
  async function removeCategory(id: string): Promise<void> {
    try {
      await withAuthGuard(() => api.deleteNoteCategory(id), logout);
      await refresh();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.deleteFailed'));
    }
  }

  async function saveCategory(input: {
    id?: string;
    parentId: string | null;
    name: string;
  }): Promise<boolean> {
    try {
      await withAuthGuard(
        () =>
          input.id !== undefined
            ? api.updateNoteCategory(input.id, { name: input.name })
            : api.createNoteCategory({ parentId: input.parentId, name: input.name }),
        logout,
      );
      await refreshCategories();
      return true;
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.saveFailed'));
      return false;
    }
  }

  return (
    <>
      <PageSlot slot="actions">
        <PageAction label={t('notes.create')} onClick={() => navigate('/notes/new')} />
      </PageSlot>

      <div className="flex h-full min-h-0 flex-col">
        <div className="shrink-0 px-[18px] max-[640px]:px-3">
          <Tabs value={tab} onValueChange={(v) => selectTab(v as 'mine' | 'square' | 'board')}>
            <TabsList aria-label={t('notes.title')}>
              <TabsTrigger value="mine">{t('notes.tabMine')}</TabsTrigger>
              <TabsTrigger value="square">{t('notes.tabSquare')}</TabsTrigger>
              <TabsTrigger value="board">{t('notes.tabBoard')}</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-[18px] pt-[18px] pb-11 min-[900px]:flex-row min-[900px]:overflow-hidden max-[640px]:px-3">
          {tab === 'mine' ? (
            <>
              <MineFeed
                notes={mine}
                error={error}
                filters={filters}
                categoryPath={categoryPath}
                onFilters={setFilters}
                onRetry={() => void refresh()}
                onDelete={removeNote}
              />
              <MineSidebar
                notes={mine}
                categories={categories}
                filters={filters}
                onFilters={setFilters}
                onSaveCategory={saveCategory}
                onDeleteCategory={removeCategory}
              />
            </>
          ) : null}
          {tab === 'square' ? (
            <SquareFeed notes={square} error={error} onRetry={() => void refresh()} />
          ) : null}
          {tab === 'board' ? (
            <BoardView
              notes={mine}
              error={error}
              onRetry={() => void refresh()}
              onMove={moveStatus}
              onDelete={removeNote}
            />
          ) : null}
        </div>
      </div>
    </>
  );
}
