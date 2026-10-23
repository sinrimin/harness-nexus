// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { CheckIcon, MessageSquareIcon, PencilIcon } from 'lucide-react';
import type { Note, NoteCategory, NoteStatus, NoteVisibility } from '@harness-nexus/sdk';
import { HarnessNexusError } from '@harness-nexus/sdk';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Field, Panel, Skeleton } from '@/components/kit';
import { TagCombobox } from '@/components/kit/tag-combobox';
import { PageSlot, usePageTitle } from '@/components/shell/page-slots';
import { MarkdownText } from '@/components/chat/markdown-text';
import { NOTE_STATUSES, NOTE_STATUS_KEY, fullDate } from './vocabulary';

/**
 * 笔记编辑器 — one page for create and edit (prototype screen 04). Content is
 * plain markdown in a mono textarea with a preview toggle; metadata lives in
 * the side panel. Saving is EXPLICIT: every content save bumps an immutable
 * version, so a 30s autosave would mint versions — drafts persist locally
 * (`hnx.noteDraft.*`) until Save.
 */
export function NoteEditorPage() {
  const { t, lang } = useI18n();
  const { logout } = useAuth();
  const navigate = useNavigate();
  const { id } = useParams();
  const isNew = id === undefined;

  const [note, setNote] = useState<Note | null>(isNew ? EMPTY_NOTE : null);
  const [categories, setCategories] = useState<NoteCategory[] | null>(null);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Form state seeds from the note (or the empty default for a new note).
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [contentMd, setContentMd] = useState('');
  const [categoryId, setCategoryId] = useState<string>('none');
  const [tags, setTags] = useState<string[]>([]);
  const [status, setStatus] = useState<NoteStatus>('inbox');
  const [visibility, setVisibility] = useState<NoteVisibility>('private');
  const [draftKey] = useState(() => `hnx.noteDraft.${id ?? 'new'}`);

  useEffect(() => {
    async function load(): Promise<void> {
      try {
        const tasks: [Promise<{ note: Note }>, Promise<{ categories: NoteCategory[] }>] = [
          isNew
            ? Promise.resolve({ note: EMPTY_NOTE })
            : withAuthGuard(() => api.getNote(id!), logout),
          withAuthGuard(() => api.listNoteCategories(), logout),
        ];
        const [noteRes, catRes] = await Promise.all(tasks);
        setNote(noteRes.note);
        setCategories(catRes.categories);
        setTitle(noteRes.note.title);
        setSummary(noteRes.note.summary ?? '');
        setContentMd(noteRes.note.contentMd);
        setCategoryId(noteRes.note.categoryId ?? 'none');
        setTags(noteRes.note.tags);
        setStatus(noteRes.note.status);
        setVisibility(noteRes.note.visibility);
        // A local draft (unsaved edits from a previous visit) wins over the
        // stored row — otherwise the textarea would silently swallow it.
        const draft = localStorage.getItem(draftKey);
        if (draft !== null) {
          try {
            const d = JSON.parse(draft) as Partial<DraftShape>;
            if (d.title !== undefined) setTitle(d.title);
            if (d.summary !== undefined) setSummary(d.summary);
            if (d.contentMd !== undefined) setContentMd(d.contentMd);
          } catch {
            localStorage.removeItem(draftKey);
          }
        }
        setLoaded(true);
      } catch (e) {
        toast.error(e instanceof HarnessNexusError ? e.message : t('notes.loadFailed'));
        navigate('/notes', { replace: true });
      }
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const baseline = useMemo(
    () =>
      JSON.stringify({
        title: note?.title ?? '',
        summary: note?.summary ?? '',
        contentMd: note?.contentMd ?? '',
        categoryId: note?.categoryId ?? 'none',
        tags: note?.tags ?? [],
        status: note?.status ?? 'inbox',
        visibility: note?.visibility ?? 'private',
      }),
    [note],
  );
  const current = useMemo(
    () => JSON.stringify({ title, summary, contentMd, categoryId, tags, status, visibility }),
    [title, summary, contentMd, categoryId, tags, status, visibility],
  );
  const dirty = loaded && current !== baseline;
  const hasDraft = localStorage.getItem(draftKey) !== null;

  // Persist unsaved work locally — never to the server (version discipline).
  useEffect(() => {
    if (!loaded) return;
    if (dirty) localStorage.setItem(draftKey, JSON.stringify({ title, summary, contentMd }));
    else localStorage.removeItem(draftKey);
  }, [draftKey, dirty, loaded, title, summary, contentMd]);

  usePageTitle(isNew ? t('notes.newTitle') : (note?.title ?? t('notes.editTitle')));

  const categoryOptions = useMemo(() => {
    const byParent = new Map<string | null, NoteCategory[]>();
    for (const c of categories ?? []) {
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
  }, [categories]);

  async function save(): Promise<void> {
    if (title.trim() === '' || contentMd.trim() === '') return;
    setBusy(true);
    const categoryIdOut = categoryId === 'none' ? null : categoryId;
    const summaryOut = summary.trim() === '' ? null : summary;
    try {
      const res = isNew
        ? await withAuthGuard(
            () =>
              api.createNote({
                title: title.trim(),
                summary: summaryOut,
                contentMd,
                categoryId: categoryIdOut,
                tags,
                status,
                visibility,
                source: { kind: 'manual' },
              }),
            logout,
          )
        : await withAuthGuard(
            () =>
              api.updateNote(id!, {
                title: title.trim(),
                summary: summaryOut,
                contentMd,
                categoryId: categoryIdOut,
                tags,
                status,
                visibility,
              }),
            logout,
          );
      localStorage.removeItem(draftKey);
      toast.success(t('notes.savedToast'));
      navigate(`/notes/${res.note.id}`, { replace: true });
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.saveFailed'));
    } finally {
      setBusy(false);
    }
  }

  const contentChanged = note !== null && contentMd !== note.contentMd;
  const versionMeta = isNew
    ? t('notes.versionNew')
    : contentChanged
      ? t('notes.versionPreview', {
          from: note?.contentVersion ?? 1,
          to: (note?.contentVersion ?? 1) + 1,
        })
      : t('notes.versionChip', { version: note?.contentVersion ?? 1 });

  if (!loaded) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-[18px] px-[18px] pt-[18px] pb-11 max-[640px]:px-3">
        <Skeleton className="h-8 w-64" />
        <div className="flex min-h-0 flex-1 flex-col gap-3 min-[900px]:flex-row">
          <Skeleton className="min-h-0 flex-1" />
          <Skeleton className="hidden min-[900px]:w-[280px]" />
        </div>
      </div>
    );
  }

  return (
    <>
      <PageSlot slot="actions">
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => navigate(-1)} disabled={busy}>
            {t('notes.cancel')}
          </Button>
          <Button
            onClick={() => void save()}
            disabled={busy || title.trim() === '' || contentMd.trim() === ''}
          >
            <CheckIcon className="size-4" />
            {t('notes.save')}
          </Button>
        </div>
      </PageSlot>

      <div className="flex h-full min-h-0 flex-col gap-[18px] px-[18px] pt-[18px] pb-11 max-[640px]:px-3">
        <div className="flex min-h-0 flex-1 flex-col gap-3 min-[900px]:flex-row">
          <Panel className="min-h-0 min-w-0 flex-1">
            <div className="flex h-9 shrink-0 items-stretch border-b px-2.5" role="tablist">
              {(['edit', 'preview'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={mode === m}
                  data-state={mode === m ? 'live' : 'inactive'}
                  onClick={() => setMode(m)}
                  className={cn(
                    'mb-[-1px] inline-flex items-center border-b-2 px-2.5 text-xs font-medium',
                    mode === m
                      ? 'border-foreground text-foreground font-semibold'
                      : 'text-muted-foreground hover:text-foreground border-b-transparent',
                  )}
                >
                  {m === 'edit' ? <PencilIcon className="mr-1 size-3" /> : null}
                  {t(m === 'edit' ? 'notes.tabEdit' : 'notes.tabPreview')}
                </button>
              ))}
            </div>

            {mode === 'edit' ? (
              <>
                <Input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={t('notes.titlePlaceholder')}
                  aria-label={t('notes.titleLabel')}
                  maxLength={200}
                  className="text-foreground h-auto rounded-none border-0 bg-transparent px-[18px] pt-4 pb-1 text-lg font-semibold tracking-tight shadow-none focus-visible:ring-0"
                />
                <textarea
                  value={contentMd}
                  onChange={(e) => setContentMd(e.target.value)}
                  placeholder={t('notes.bodyPlaceholder')}
                  aria-label={t('notes.tabEdit')}
                  spellCheck
                  className="font-mono text-foreground placeholder:text-muted-foreground min-h-0 flex-1 resize-none bg-transparent px-[18px] pt-2.5 pb-4 text-xs leading-[1.8] outline-none max-[900px]:h-[50vh] max-[900px]:flex-none"
                />
              </>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto px-[18px] pt-4 pb-4">
                <h2 className="mb-3 text-lg font-semibold tracking-tight">
                  {title.trim() === '' ? t('notes.titlePlaceholder') : title}
                </h2>
                <MarkdownText text={contentMd} />
              </div>
            )}

            <div className="role-data-sm text-muted-foreground flex shrink-0 flex-wrap items-center gap-x-3 border-t px-[18px] py-[7px]">
              <span>Markdown</span>
              <span className="ml-auto">
                {t('notes.charCount', { count: contentMd.length })} ·{' '}
                {dirty
                  ? t('notes.editorFootDirty')
                  : hasDraft
                    ? t('notes.editorFootLocal')
                    : !isNew && note !== null && note.updatedAt !== ''
                      ? t('notes.editorFootSaved', { time: fullDate(note.updatedAt, lang) })
                      : t('notes.versionNew')}
              </span>
            </div>
          </Panel>

          <Panel className="min-h-0 shrink-0 min-[900px]:w-[280px] max-[900px]:flex-none">
            <div className="role-label text-foreground flex min-h-(--panel-head-h) shrink-0 items-center gap-x-2 border-b px-3 py-1">
              {t('notes.metaLabel')}
              <span className="role-data-sm text-muted-foreground ml-auto">{versionMeta}</span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
              <Field
                label={t('notes.summaryLabel')}
                htmlFor="note-summary"
                hint={t('notes.summaryHint')}
              >
                <Textarea
                  id="note-summary"
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  placeholder={t('notes.summaryPlaceholder')}
                  maxLength={1000}
                  className="min-h-16 text-xs leading-relaxed"
                />
              </Field>
              <Field label={t('notes.categoryLabel')} htmlFor="note-category">
                <Select value={categoryId} onValueChange={setCategoryId}>
                  <SelectTrigger id="note-category" className="w-full justify-between">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">{t('notes.categoryNone')}</SelectItem>
                    {categoryOptions.map(([cid, label]) => (
                      <SelectItem key={cid} value={cid}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label={t('notes.tagsLabelEdit')}>
                <TagCombobox
                  value={tags}
                  options={[]}
                  onChange={setTags}
                  placeholder={t('notes.tagAddPlaceholder')}
                  addLabel={(v) => v}
                  removeLabel={(v) => v}
                  ariaLabel={t('notes.tagsLabelEdit')}
                />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label={t('notes.statusLabel')} htmlFor="note-status">
                  <Select value={status} onValueChange={(v) => setStatus(v as NoteStatus)}>
                    <SelectTrigger id="note-status" className="w-full justify-between">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {NOTE_STATUSES.map((s) => (
                        <SelectItem key={s} value={s}>
                          {t(NOTE_STATUS_KEY[s])}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field label={t('notes.visibilityLabel')} htmlFor="note-visibility">
                  <Select
                    value={visibility}
                    onValueChange={(v) => setVisibility(v as NoteVisibility)}
                  >
                    <SelectTrigger id="note-visibility" className="w-full justify-between">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="private">{t('notes.privateChip')}</SelectItem>
                      <SelectItem value="public">{t('notes.publicChip')}</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              <Field label={t('notes.sourceLabel')}>
                <div className="bg-(--well) border-border flex items-center gap-2 rounded border px-2.5 py-1.5">
                  {note !== null && note.source.kind === 'chat' ? (
                    <MessageSquareIcon className="text-muted-foreground size-3 shrink-0" />
                  ) : (
                    <PencilIcon className="text-muted-foreground size-3 shrink-0" />
                  )}
                  <span className="role-data-sm text-foreground truncate">
                    {note !== null ? sourceLine(note, t) : ''}
                  </span>
                </div>
              </Field>
              <p className="text-muted-foreground mt-auto border-t pt-2 text-[10.5px] leading-relaxed">
                {t('notes.saveHint')}
              </p>
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}

interface DraftShape {
  title: string;
  summary: string;
  contentMd: string;
}

const EMPTY_NOTE: Note = {
  id: 'new',
  ownerId: '',
  title: '',
  summary: null,
  contentMd: '',
  contentVersion: 1,
  categoryId: null,
  tags: [],
  status: 'inbox',
  visibility: 'private',
  source: { kind: 'manual' },
  createdAt: '',
  updatedAt: '',
};

function sourceLine(note: Note, t: ReturnType<typeof useI18n>['t']): string {
  const kind =
    note.source.kind === 'chat'
      ? t('notes.sourceChat')
      : note.source.kind === 'url'
        ? t('notes.sourceUrl')
        : t('notes.sourceManual');
  return note.source.ref !== undefined ? `${kind} · ${note.source.ref}` : kind;
}
