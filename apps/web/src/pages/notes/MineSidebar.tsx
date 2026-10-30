// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useMemo, useState } from 'react';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
} from 'lucide-react';
import type { FeedNoteView, NoteCategory, NoteStatus } from '@harness-nexus/sdk';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { FormDialog } from '@/components/ui/form-dialog';
import { ConfirmDialog, Field, Panel, PanelBody, PanelHeader } from '@/components/kit';
import { Lamp } from '@/components/kit/lamp';
import type { MineFilters } from './NotesPage';
import { NOTE_STATUSES, NOTE_STATUS_KEY, NOTE_STATUS_STATE } from './vocabulary';

/** Tags shown before the 展开 toggle — the cloud is a filter, not an inventory. */
const TAG_PREVIEW = 8;

/**
 * 我的信息流侧栏 — 搜索 → 目录 → 筛选（状态 + 标签）. Counts derive from the
 * loaded window (never from the filtered view — a count must not move because
 * a filter is active); the last panel stretches to the feed's height on
 * desktop and everything stacks under the feed on a phone.
 */
export function MineSidebar({
  notes,
  categories,
  filters,
  onFilters,
  onSaveCategory,
  onDeleteCategory,
}: {
  notes: FeedNoteView[] | null;
  categories: NoteCategory[] | null;
  filters: MineFilters;
  onFilters: (next: MineFilters) => void;
  onSaveCategory: (input: {
    id?: string;
    parentId: string | null;
    name: string;
  }) => Promise<boolean>;
  onDeleteCategory: (id: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<NoteCategory | null>(null);
  const [pendingDelete, setPendingDelete] = useState<NoteCategory | null>(null);
  const [showAllTags, setShowAllTags] = useState(false);

  const byParent = useMemo(() => {
    const map = new Map<string | null, NoteCategory[]>();
    for (const c of categories ?? []) {
      const list = map.get(c.parentId) ?? [];
      list.push(c);
      map.set(c.parentId, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return map;
  }, [categories]);

  const counts = useMemo(() => {
    const perCategory = new Map<string, number>();
    let uncategorized = 0;
    for (const n of notes ?? []) {
      if (n.categoryId === null) uncategorized += 1;
      else perCategory.set(n.categoryId, (perCategory.get(n.categoryId) ?? 0) + 1);
    }
    return { perCategory, uncategorized };
  }, [notes]);

  const statusCounts = useMemo(() => {
    const counts2 = new Map<NoteStatus, number>();
    for (const s of NOTE_STATUSES) counts2.set(s, 0);
    for (const n of notes ?? []) counts2.set(n.status, (counts2.get(n.status) ?? 0) + 1);
    return counts2;
  }, [notes]);

  const tagCounts = useMemo(() => {
    const counts2 = new Map<string, number>();
    for (const n of notes ?? [])
      for (const tg of n.tags) counts2.set(tg, (counts2.get(tg) ?? 0) + 1);
    return [...counts2.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [notes]);

  return (
    <aside className="flex w-full shrink-0 flex-col gap-2.5 max-[900px]:gap-3 min-[900px]:w-[240px]">
      <div className="relative">
        <SearchIcon className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
        <Input
          value={filters.q}
          onChange={(e) => onFilters({ ...filters, q: e.target.value })}
          placeholder={t('notes.searchPlaceholder')}
          className="h-8 pl-8 text-xs"
          autoComplete="off"
          spellCheck={false}
          aria-label={t('notes.searchPlaceholder')}
        />
      </div>

      <CollapsiblePanel
        label={t('notes.categoriesLabel')}
        meta={String((categories ?? []).length)}
        actions={
          <Button
            variant="ghost"
            size="icon"
            className="size-5"
            onClick={() => setCreating(true)}
            aria-label={t('notes.addCategory')}
            title={t('notes.addCategory')}
          >
            <PlusIcon className="size-3.5" />
          </Button>
        }
      >
        <div className="flex flex-col p-1">
          <CategoryRow
            label={t('notes.categoryAll')}
            count={notes !== null ? notes.length : undefined}
            active={filters.category === null}
            onClick={() => onFilters({ ...filters, category: null })}
          />
          {[...(byParent.get(null) ?? [])].map((c) => (
            <CategoryNode
              key={c.id}
              category={c}
              depth={0}
              byParent={byParent}
              showCounts={notes !== null}
              counts={counts.perCategory}
              activeId={filters.category}
              onSelect={(id) => onFilters({ ...filters, category: id })}
              onRename={setRenaming}
              onDelete={setPendingDelete}
            />
          ))}
          <CategoryRow
            label={t('notes.categoryUncategorized')}
            count={notes !== null ? counts.uncategorized : undefined}
            active={filters.category === 'uncategorized'}
            onClick={() =>
              onFilters({
                ...filters,
                category: filters.category === 'uncategorized' ? null : 'uncategorized',
              })
            }
          />
        </div>
      </CollapsiblePanel>

      <CollapsiblePanel
        label={t('notes.filtersLabel')}
        meta={t('notes.filtersMeta')}
        className="min-h-0 min-[900px]:flex-1"
      >
        <div className="overflow-y-auto">
          <div className="flex flex-col px-1 pt-1.5">
            {NOTE_STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onFilters({ ...filters, status: filters.status === s ? null : s })}
                className={
                  filters.status === s
                    ? 'bg-tray text-foreground flex min-h-6 items-center gap-1.5 rounded px-1.5 py-1 text-xs font-semibold'
                    : 'text-muted-foreground hover:bg-tray/60 hover:text-foreground flex min-h-6 items-center gap-1.5 rounded px-1.5 py-1 text-xs'
                }
                aria-pressed={filters.status === s}
              >
                <Lamp state={NOTE_STATUS_STATE[s]} size="sm" />
                {t(NOTE_STATUS_KEY[s])}
                {notes !== null ? (
                  <span className="role-data-sm ml-auto">{statusCounts.get(s) ?? 0}</span>
                ) : null}
              </button>
            ))}
          </div>
          <div className="border-t" role="separator" />
          <p className="role-label-sm text-muted-foreground px-3 pt-1.5 pb-1">
            {t('notes.tagsLabel')}
          </p>
          {notes !== null && tagCounts.length === 0 ? (
            <p className="text-muted-foreground px-3 pb-2 text-[11px]">{t('notes.emptyHint')}</p>
          ) : notes === null ? null : (
            <div className="flex flex-wrap gap-[5px] px-2.5 pb-2.5">
              {(showAllTags ? tagCounts : tagCounts.slice(0, TAG_PREVIEW)).map(([name, count]) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => onFilters({ ...filters, tag: filters.tag === name ? null : name })}
                  aria-pressed={filters.tag === name}
                  className={
                    filters.tag === name
                      ? 'bg-tray text-foreground border-border role-data-sm inline-flex h-6 items-center gap-[5px] rounded border px-[7px] font-medium'
                      : 'text-muted-foreground hover:text-foreground bg-card border-border role-data-sm inline-flex h-6 items-center gap-[5px] rounded border px-[7px]'
                  }
                >
                  {name} <b className="font-mono text-[10px] font-normal">{count}</b>
                </button>
              ))}
              {tagCounts.length > TAG_PREVIEW ? (
                <button
                  type="button"
                  className="role-data-sm text-muted-foreground hover:text-foreground self-center"
                  onClick={() => setShowAllTags((v) => !v)}
                >
                  {showAllTags ? t('notes.showFewerTags') : t('notes.showAllTags')}
                </button>
              ) : null}
            </div>
          )}
        </div>
      </CollapsiblePanel>

      {creating ? (
        <CategoryDialog
          categories={categories ?? []}
          onClose={() => setCreating(false)}
          onSave={(name, parentId) => onSaveCategory({ parentId, name })}
        />
      ) : null}
      {renaming !== null ? (
        <CategoryDialog
          categories={categories ?? []}
          initial={renaming}
          onClose={() => setRenaming(null)}
          onSave={(name) => onSaveCategory({ id: renaming.id, parentId: renaming.parentId, name })}
        />
      ) : null}
      {pendingDelete !== null ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) setPendingDelete(null);
          }}
          title={t('notes.deleteCategory')}
          consequence={t('notes.deleteCategoryConsequence')}
          impact={[{ label: t('notes.impactCategory'), value: pendingDelete.name }]}
          actionLabel={t('notes.deleteCategory')}
          onConfirm={() => {
            const id = pendingDelete.id;
            setPendingDelete(null);
            void onDeleteCategory(id);
          }}
        />
      ) : null}
    </aside>
  );
}

/** A panel whose header folds its body — the sidebar's density valve. */
function CollapsiblePanel({
  label,
  meta,
  actions,
  className,
  children,
}: {
  label: string;
  meta?: string;
  actions?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <Panel className={className}>
      <PanelHeader
        label={label}
        meta={meta}
        actions={
          <>
            {actions}
            <Button
              variant="ghost"
              size="icon"
              className="size-5"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              aria-label={label}
            >
              <ChevronDownIcon
                className={`size-3.5 transition-transform ${open ? '' : '-rotate-90'}`}
              />
            </Button>
          </>
        }
      />
      {open ? (
        <PanelBody variant="flush" className="min-h-0">
          {children}
        </PanelBody>
      ) : null}
    </Panel>
  );
}

function CategoryNode({
  category,
  depth,
  byParent,
  counts,
  showCounts,
  activeId,
  onSelect,
  onRename,
  onDelete,
}: {
  category: NoteCategory;
  depth: number;
  byParent: Map<string | null, NoteCategory[]>;
  counts: Map<string, number>;
  showCounts: boolean;
  activeId: string | 'uncategorized' | null;
  onSelect: (id: string) => void;
  onRename: (c: NoteCategory) => void;
  onDelete: (c: NoteCategory) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(true);
  const children = byParent.get(category.id) ?? [];
  const active = activeId === category.id;
  return (
    <div>
      <div
        className={
          active
            ? 'bg-tray text-foreground group flex min-h-6 items-center gap-1.5 rounded px-1.5 py-1 text-xs font-semibold'
            : 'text-muted-foreground hover:bg-tray/60 hover:text-foreground group flex min-h-6 items-center gap-1.5 rounded px-1.5 py-1 text-xs'
        }
        style={{ paddingLeft: `${6 + depth * 16}px` }}
      >
        {children.length > 0 ? (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            aria-label={category.name}
            className="flex size-4 shrink-0 items-center justify-center"
          >
            <ChevronRightIcon
              className={`size-3 transition-transform ${open ? 'rotate-90' : ''}`}
            />
          </button>
        ) : (
          <span aria-hidden="true" className="size-4 shrink-0" />
        )}
        <button
          type="button"
          onClick={() => onSelect(category.id)}
          className="min-w-0 flex-1 truncate text-left font-medium"
          aria-pressed={active}
        >
          {category.name}
        </button>
        {showCounts ? (
          <span className="role-data-sm text-muted-foreground">{counts.get(category.id) ?? 0}</span>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground size-6 shrink-0 opacity-60 hover:opacity-100"
              aria-label={t('common.openMenu')}
            >
              <MoreHorizontalIcon className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onClick={() => onRename(category)}>
              <PencilIcon /> {t('notes.renameCategory')}
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onClick={() => onDelete(category)}>
              <TrashIcon /> {t('notes.deleteCategory')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {open
        ? children.map((c) => (
            <CategoryNode
              key={c.id}
              category={c}
              depth={depth + 1}
              byParent={byParent}
              showCounts={showCounts}
              counts={counts}
              activeId={activeId}
              onSelect={onSelect}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))
        : null}
    </div>
  );
}

function CategoryRow({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  /** Omitted (not zero) until the list has loaded — a failed load renders nothing. */
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={
        active
          ? 'bg-tray text-foreground flex min-h-6 items-center gap-1.5 rounded px-1.5 py-1 text-xs font-semibold'
          : 'text-muted-foreground hover:bg-tray/60 hover:text-foreground flex min-h-6 items-center gap-1.5 rounded px-1.5 py-1 text-xs'
      }
    >
      <span aria-hidden="true" className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-left font-medium">{label}</span>
      {count !== undefined ? (
        <span className="role-data-sm text-muted-foreground">{count}</span>
      ) : null}
    </button>
  );
}

/** Create (with parent) / rename a category — one dialog, two verbs. */
function CategoryDialog({
  categories,
  initial,
  onClose,
  onSave,
}: {
  categories: NoteCategory[];
  initial?: NoteCategory;
  onClose: () => void;
  onSave: (name: string, parentId: string | null) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(initial?.name ?? '');
  const [parentId, setParentId] = useState<string>('root');
  const [busy, setBusy] = useState(false);

  const options = useMemo(() => flattenForSelect(categories), [categories]);

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    const ok = await onSave(name.trim(), parentId === 'root' ? null : parentId);
    setBusy(false);
    if (ok) onClose();
  }

  return (
    <FormDialog
      open
      onClose={onClose}
      title={t(initial !== undefined ? 'notes.renameCategory' : 'notes.addCategory')}
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label={t('common.name')} htmlFor="cat-name" required>
          <Input
            id="cat-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
            required
            maxLength={64}
          />
        </Field>
        {initial === undefined ? (
          <Field label={t('notes.categoryLabel')} htmlFor="cat-parent">
            <Select value={parentId} onValueChange={setParentId}>
              <SelectTrigger id="cat-parent">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="root">{t('notes.categoryAll')}</SelectItem>
                {options.map(([id, label]) => (
                  <SelectItem key={id} value={id}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={busy || name.trim() === ''}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </FormDialog>
  );
}

function flattenForSelect(categories: NoteCategory[]): [string, string][] {
  const byParent = new Map<string | null, NoteCategory[]>();
  for (const c of categories) {
    const list = byParent.get(c.parentId) ?? [];
    list.push(c);
    byParent.set(c.parentId, list);
  }
  const out: [string, string][] = [];
  const walk = (parent: string | null, depth: number): void => {
    for (const c of (byParent.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
      out.push([c.id, `${'— '.repeat(depth)}${c.name}`]);
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}
