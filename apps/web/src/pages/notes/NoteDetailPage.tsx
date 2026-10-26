// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  BotIcon,
  CheckIcon,
  GlobeIcon,
  HighlighterIcon,
  LinkIcon,
  LockIcon,
  MessageSquareIcon,
  MoreHorizontalIcon,
  PencilIcon,
  RotateCcwIcon,
  SparklesIcon,
  TrashIcon,
} from 'lucide-react';
import type { Note, NoteAnnotation } from '@harness-nexus/sdk';
import { HarnessNexusError } from '@harness-nexus/sdk';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n } from '@/i18n';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ConfirmDialog, EmptyState, Skeleton } from '@/components/kit';
import { Lamp } from '@/components/kit/lamp';
import { PageSlot, usePageTitle } from '@/components/shell/page-slots';
import { AnnotatedMarkdown, circled, type AnnotationMarkModel } from './AnnotatedMarkdown';
import { NOTE_STATUS_KEY, NOTE_STATUS_STATE, fullDate } from './vocabulary';

/** Context captured around the selection: ≤200 chars each side (#88 anchor). */
const CONTEXT_CHARS = 200;

/** The editor popover's width (mirrors its `w-[300px]` + clamping margin). */
const EDITOR_POPOVER_W = 300;
const POPOVER_MARGIN = 8;
/** Half-width allowance for the compact toolbar pill (auto-width, centered). */
const TOOLBAR_HALF = 56;
/** selectionchange debounce — the event fires continuously while handles drag. */
const SELECTION_SETTLE_MS = 350;

interface PendingSelection {
  quote: string;
  contextPrefix: string;
  contextSuffix: string;
  top: number;
  /** Toolbar pill anchor: selection center, clamped into the pane. */
  centerX: number;
  /** Editor popover left edge, clamped so the box stays inside the pane. */
  left: number;
}

/**
 * 笔记详情 — read pane + annotation pane (prototype screen 05). Annotations
 * are owner-only working material: a public visitor gets the note and nothing
 * else. Selecting text opens the annotation popover; the anchor is the quote
 * plus surrounding context, never offsets.
 */
export function NoteDetailPage() {
  const { t, lang } = useI18n();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { id } = useParams();

  const [note, setNote] = useState<Note | null>(null);
  const [annotations, setAnnotations] = useState<NoteAnnotation[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [matchedIds, setMatchedIds] = useState<Set<string>>(new Set());
  const [pendingSel, setPendingSel] = useState<PendingSelection | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<NoteAnnotation | null>(null);
  const [confirmDeleteNote, setConfirmDeleteNote] = useState(false);
  const [confirmRevise, setConfirmRevise] = useState(false);
  const [revising, setRevising] = useState(false);

  const paneRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    async function load(): Promise<void> {
      if (id === undefined) return;
      try {
        const noteRes = await withAuthGuard(() => api.getNote(id), logout);
        setNote(noteRes.note);
        setError(null);
        if (noteRes.note.ownerId === user?.id) {
          const annRes = await withAuthGuard(() => api.listNoteAnnotations(id), logout);
          setAnnotations(annRes.annotations);
        } else {
          setAnnotations(null);
        }
      } catch (e) {
        setError(e);
      }
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const isOwner = note !== null && note.ownerId === user?.id;
  usePageTitle(note?.title ?? t('notes.title'));

  const marks = useMemo<AnnotationMarkModel[]>(
    () =>
      (annotations ?? []).map((a, i) => ({
        id: a.id,
        quote: a.quote,
        state: a.state,
        index: i + 1,
      })),
    [annotations],
  );

  const onMatchedChange = useCallback((matched: Set<string>) => {
    setMatchedIds((prev) =>
      prev.size === matched.size && [...matched].every((x) => prev.has(x))
        ? prev
        : new Set(matched),
    );
  }, []);

  const onFocusMark = useCallback((markId: string) => {
    setFocusId(markId);
  }, []);

  // Focusing a mark (or a pane card) reveals the counterpart card.
  useEffect(() => {
    if (focusId === null) return;
    cardRefs.current.get(focusId)?.scrollIntoView({ block: 'nearest' });
  }, [focusId]);

  function onMouseUp(e: React.MouseEvent): void {
    if (!isOwner || bodyRef.current === null || paneRef.current === null) return;
    // A mouseup INSIDE the popover (its buttons) is the popover's own
    // business — re-running the selection handler here would wipe the typed
    // comment before the click lands.
    if ((e.target as Element).closest('[data-annotation-popover]') !== null) return;
    const sel = window.getSelection();
    // A collapsed selection (plain click) dismisses the popover.
    if (sel === null || sel.isCollapsed || sel.rangeCount === 0) {
      setPendingSel(null);
      setDraftOpen(false);
      return;
    }
    captureSelection();
  }

  /**
   * Snapshot the current selection into a toolbar anchor. Shared by the
   * desktop mouseup path and the mobile selectionchange path.
   */
  function captureSelection(): void {
    const sel = window.getSelection();
    if (sel === null || sel.isCollapsed || sel.rangeCount === 0) return;
    if (bodyRef.current === null || paneRef.current === null) return;
    const text = sel.toString();
    if (
      text.trim() === '' ||
      text.length > 2000 ||
      bodyRef.current.contains(sel.anchorNode) === false
    ) {
      return;
    }
    const full = bodyRef.current.innerText;
    const at = full.indexOf(text);
    const pane = paneRef.current;
    const paneRect = pane.getBoundingClientRect();
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    // Both anchors live in the pane's scrolled coordinate space, clamped so a
    // selection near an edge keeps its popover inside the pane (the old
    // left-2 box ignored the selection horizontally).
    const centerX = rect.left + rect.width / 2 - paneRect.left + pane.scrollLeft;
    const editorW = Math.min(EDITOR_POPOVER_W, pane.clientWidth - 2 * POPOVER_MARGIN);
    setPendingSel({
      quote: text,
      contextPrefix: at >= 0 ? full.slice(Math.max(0, at - CONTEXT_CHARS), at) : '',
      contextSuffix: at >= 0 ? full.slice(at + text.length, at + text.length + CONTEXT_CHARS) : '',
      top: rect.bottom - paneRect.top + pane.scrollTop,
      centerX: Math.min(Math.max(centerX, TOOLBAR_HALF), pane.clientWidth - TOOLBAR_HALF),
      left: Math.min(
        Math.max(centerX - editorW / 2, POPOVER_MARGIN),
        pane.clientWidth - editorW - POPOVER_MARGIN,
      ),
    });
    setComment('');
    setDraftOpen(false);
    setFocusId(null);
  }

  /**
   * Mobile: a long-press selection never fires mouseup — settle on the
   * document's selectionchange instead (debounced: the event fires
   * continuously while the drag handles move). A collapse (tap elsewhere)
   * closes the TOOLBAR; the draft survives, because caret moves inside the
   * comment textarea land here too.
   */
  useEffect(() => {
    if (!isOwner) return;
    let timer: number | undefined;
    const onChange = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const sel = window.getSelection();
        if (sel === null || sel.rangeCount === 0 || sel.isCollapsed) {
          if (!draftOpen) setPendingSel(null);
          return;
        }
        const node = sel.anchorNode;
        if (node !== null && bodyRef.current?.contains(node) === true) captureSelection();
      }, SELECTION_SETTLE_MS);
    };
    document.addEventListener('selectionchange', onChange);
    return () => {
      document.removeEventListener('selectionchange', onChange);
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOwner, draftOpen]);

  // Escape closes whatever phase of the popover is up.
  useEffect(() => {
    if (pendingSel === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setPendingSel(null);
        setDraftOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pendingSel]);

  async function saveAnnotation(): Promise<void> {
    if (pendingSel === null || id === undefined || comment.trim() === '') return;
    setBusy(true);
    try {
      await withAuthGuard(
        () =>
          api.createNoteAnnotation(id, {
            quote: pendingSel.quote,
            contextPrefix: pendingSel.contextPrefix,
            contextSuffix: pendingSel.contextSuffix,
            comment: comment.trim(),
          }),
        logout,
      );
      const annRes = await withAuthGuard(() => api.listNoteAnnotations(id), logout);
      setAnnotations(annRes.annotations);
      window.getSelection()?.removeAllRanges();
      setPendingSel(null);
      setDraftOpen(false);
      setComment('');
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.saveFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function setAnnotationState(
    annotation: NoteAnnotation,
    state: 'open' | 'done',
  ): Promise<void> {
    if (id === undefined) return;
    try {
      await withAuthGuard(() => api.updateNoteAnnotation(id, annotation.id, { state }), logout);
      const annRes = await withAuthGuard(() => api.listNoteAnnotations(id), logout);
      setAnnotations(annRes.annotations);
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.saveFailed'));
    }
  }

  async function removeAnnotation(): Promise<void> {
    if (pendingDelete === null || id === undefined) return;
    try {
      await withAuthGuard(() => api.deleteNoteAnnotation(id, pendingDelete.id), logout);
      const annRes = await withAuthGuard(() => api.listNoteAnnotations(id), logout);
      setAnnotations(annRes.annotations);
      setPendingDelete(null);
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.deleteFailed'));
    }
  }

  /**
   * #88 revision loop — every open annotation + the body go to the model
   * server-side; the rewritten markdown lands as the next immutable version
   * and the addressed annotations flip to done. Long-running: the button
   * holds a busy state through the whole LLM turn.
   */
  async function revise(): Promise<void> {
    if (note === null || id === undefined) return;
    setRevising(true);
    try {
      const res = await withAuthGuard(() => api.reviseNote(id), logout);
      setNote(res.note);
      const annRes = await withAuthGuard(() => api.listNoteAnnotations(id), logout);
      setAnnotations(annRes.annotations);
      toast.success(t('notes.reviseDone', { version: res.note.contentVersion }));
    } catch (e) {
      toast.error(
        e instanceof HarnessNexusError && e.code === 'NOTE_AI_NO_PROVIDER'
          ? t('notes.aiNoProvider')
          : e instanceof HarnessNexusError && e.code === 'NOTE_NO_OPEN_ANNOTATIONS'
            ? t('notes.reviseNeedOpen')
            : t('notes.reviseFailed'),
      );
    } finally {
      setRevising(false);
      setConfirmRevise(false);
    }
  }

  async function removeNote(): Promise<void> {
    if (note === null) return;
    try {
      await withAuthGuard(() => api.deleteNote(note.id), logout);
      toast.success(t('notes.deletedToast'));
      navigate('/notes', { replace: true });
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.deleteFailed'));
    }
  }

  if (error !== null && note === null) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-6">
        <EmptyState
          title={t('notes.loadFailed')}
          code={error instanceof HarnessNexusError ? error.code : 'NOTE_NOT_FOUND'}
          action={
            <Button variant="outline" size="sm" onClick={() => navigate('/notes')}>
              {t('notes.backToList')}
            </Button>
          }
        />
      </div>
    );
  }

  if (note === null) {
    return (
      <div className="mx-auto flex h-full min-h-0 w-full max-w-[700px] flex-col gap-4 p-6">
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const openCount = (annotations ?? []).filter((a) => a.state === 'open').length;

  return (
    <>
      {isOwner ? (
        <PageSlot slot="actions">
          <div className="flex items-center gap-2">
            <Button
              onClick={() => setConfirmRevise(true)}
              disabled={revising || openCount === 0}
              title={openCount === 0 ? t('notes.reviseNeedOpen') : t('notes.revise')}
              aria-label={t('notes.revise')}
              className="max-sm:w-(--control-h) max-sm:px-0"
            >
              <SparklesIcon
                className={
                  revising ? 'size-4 animate-pulse max-sm:mx-auto' : 'size-4 max-sm:mx-auto'
                }
              />
              <span className="max-sm:hidden">
                {revising ? t('notes.reviseBusy') : t('notes.revise')}
              </span>
            </Button>
            <Button
              variant="outline"
              onClick={() => navigate(`/notes/${note.id}/edit`)}
              aria-label={t('notes.edit')}
              title={t('notes.edit')}
              className="max-sm:w-(--control-h) max-sm:px-0"
            >
              <PencilIcon className="size-4 max-sm:mx-auto" />
              <span className="max-sm:hidden">{t('notes.edit')}</span>
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={t('common.openMenu')}>
                  <MoreHorizontalIcon className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem variant="destructive" onClick={() => setConfirmDeleteNote(true)}>
                  <TrashIcon /> {t('notes.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </PageSlot>
      ) : null}

      <div className="flex h-full min-h-0 flex-col min-[900px]:flex-row">
        <div
          ref={paneRef}
          onMouseUp={onMouseUp}
          onScroll={() => {
            // The popovers anchor in content coordinates, so they ride pane
            // scrolls correctly — dismiss the TOOLBAR (its selection is
            // usually gone by then) but keep the draft: a mobile soft
            // keyboard scrolls the pane while the comment is being typed.
            if (!draftOpen) setPendingSel(null);
          }}
          className="bg-card relative min-h-0 min-w-0 flex-1 overflow-y-auto"
        >
          <div className="mx-auto max-w-[700px] px-6 pt-6 pb-10 max-[640px]:px-4">
            <h1 className="text-foreground text-xl leading-snug font-semibold tracking-tight text-balance">
              {note.title}
            </h1>
            <div className="mt-3 mb-1 flex flex-wrap items-center gap-1.5">
              <Lamp
                state={NOTE_STATUS_STATE[note.status]}
                word={t(NOTE_STATUS_KEY[note.status])}
                size="sm"
              />
              <Badge
                variant="outline"
                className="text-muted-foreground gap-1 px-1.5 py-0 text-[10.5px]"
              >
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
              <span className="role-data-sm text-muted-foreground">
                {fullDate(note.updatedAt, lang)}
              </span>
              <span className="role-data-sm text-muted-foreground rounded border px-[5px] py-px">
                {t('notes.versionChip', { version: note.contentVersion })}
              </span>
            </div>

            {note.summary !== null && note.summary !== '' ? (
              <div className="bg-well border-well-edge mt-3 rounded-(--radius-well) border p-3">
                <p className="role-label-sm text-muted-foreground">{t('notes.summaryLead')}</p>
                <p className="text-muted-foreground mt-1.5 text-xs leading-relaxed">
                  {note.summary}
                </p>
              </div>
            ) : null}

            <div className="bg-well border-well-edge mt-3 flex flex-wrap items-center gap-2 rounded-(--radius-well) border px-2.5 py-1.5">
              {note.source.kind === 'chat' ? (
                <MessageSquareIcon className="text-muted-foreground size-3 shrink-0" />
              ) : note.source.kind === 'agent' ? (
                <BotIcon className="text-muted-foreground size-3 shrink-0" />
              ) : note.source.kind === 'url' ? (
                <LinkIcon className="text-muted-foreground size-3 shrink-0" />
              ) : (
                <PencilIcon className="text-muted-foreground size-3 shrink-0" />
              )}
              <span className="role-label-sm text-muted-foreground">{t('notes.sourceLabel')}</span>
              <span className="role-data-sm text-foreground truncate">{sourceLine(note, t)}</span>
              <span className="role-data-sm text-muted-foreground ml-auto">
                {fullDate(note.createdAt, lang)}
              </span>
            </div>

            <div ref={bodyRef} className="mt-5">
              <AnnotatedMarkdown
                text={note.contentMd}
                marks={marks}
                focusId={focusId}
                onFocusMark={onFocusMark}
                onMatchedChange={onMatchedChange}
              />
            </div>
          </div>

          {pendingSel !== null && !draftOpen ? (
            <div
              data-annotation-popover
              // preventDefault on mousedown keeps the selection (and copy)
              // alive while the toolbar is up — focus only moves when the
              // user explicitly opens the comment draft.
              onMouseDown={(e) => e.preventDefault()}
              className="bg-popover text-popover-foreground absolute z-30 -translate-x-1/2 rounded-full border py-0.5 pl-0.5 pr-1.5 shadow-(--shadow-panel)"
              style={{ top: `${pendingSel.top + 6}px`, left: `${pendingSel.centerX}px` }}
            >
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1.5 rounded-full px-2 text-xs"
                onClick={() => setDraftOpen(true)}
              >
                <HighlighterIcon className="size-3.5" />
                {t('notes.annotateAction')}
              </Button>
            </div>
          ) : null}

          {pendingSel !== null && draftOpen ? (
            <div
              data-annotation-popover
              className="bg-popover text-popover-foreground absolute z-30 w-[300px] max-w-[calc(100%-16px)] rounded-lg border p-3 shadow-(--shadow-panel)"
              style={{ top: `${pendingSel.top + 6}px`, left: `${pendingSel.left}px` }}
            >
              <div className="flex items-center gap-2">
                <span className="role-data-sm text-signal font-medium">
                  {t('notes.addAnnotation')}
                </span>
                <HighlighterIcon className="text-muted-foreground ml-auto size-3" />
              </div>
              <p className="bg-well border-well-edge text-muted-foreground role-data-sm mt-2 line-clamp-2 rounded-r-sm border-l-2 px-2 py-1.5 leading-normal">
                {pendingSel.quote}
              </p>
              <Textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder={t('notes.annotationPlaceholder')}
                maxLength={2000}
                autoFocus
                className="mt-2 min-h-14 text-xs"
              />
              <div className="mt-2 flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setPendingSel(null)}>
                  {t('notes.cancelAnnotation')}
                </Button>
                <Button
                  size="sm"
                  disabled={busy || comment.trim() === ''}
                  onClick={() => void saveAnnotation()}
                >
                  {t('notes.saveAnnotation')}
                </Button>
              </div>
            </div>
          ) : null}
        </div>

        {isOwner ? (
          <aside className="bg-card flex min-h-0 w-full shrink-0 flex-col border-t min-[900px]:w-[300px] min-[900px]:border-t-0 min-[900px]:border-l max-[900px]:max-h-[45%]">
            <header className="flex min-h-[34px] shrink-0 items-center gap-2 border-b px-3.5">
              <span className="role-label text-foreground">{t('notes.annotationsLabel')}</span>
              <span className="role-data-sm text-muted-foreground">
                {annotations?.length ?? 0}
                {openCount > 0 ? (
                  <>
                    {' · '}
                    <b className="text-state-warn-ink font-medium">
                      {t('notes.annotationsOpen', { count: openCount })}
                    </b>
                  </>
                ) : null}
              </span>
            </header>
            <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2.5">
              {(annotations ?? []).length === 0 ? (
                <p className="text-muted-foreground p-2 text-xs leading-relaxed">
                  {t('notes.selectToAnnotate')}
                </p>
              ) : null}
              {(annotations ?? []).map((a, i) => (
                <AnnotationCard
                  key={a.id}
                  annotation={a}
                  index={i + 1}
                  lost={!matchedIds.has(a.id)}
                  focused={focusId === a.id}
                  registerRef={(el) => {
                    if (el === null) cardRefs.current.delete(a.id);
                    else cardRefs.current.set(a.id, el);
                  }}
                  onFocus={() => setFocusId(a.id)}
                  onToggle={() => void setAnnotationState(a, a.state === 'open' ? 'done' : 'open')}
                  onDelete={() => setPendingDelete(a)}
                />
              ))}
            </div>
            <p className="text-muted-foreground mt-auto shrink-0 border-t px-3 py-2.5 text-[10.5px] leading-relaxed">
              {t('notes.annotationsHint')}
            </p>
          </aside>
        ) : (
          <aside className="hidden min-[900px]:flex min-[900px]:w-[300px] min-[900px]:shrink-0 min-[900px]:items-center min-[900px]:justify-center min-[900px]:border-l">
            <p className="text-muted-foreground p-4 text-center text-[11px]">
              {t('notes.annotationsHidden')}
            </p>
          </aside>
        )}
      </div>

      {pendingDelete !== null ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) setPendingDelete(null);
          }}
          title={t('notes.delete')}
          consequence={t('notes.annotationDeleteConsequence')}
          impact={[{ label: t('notes.impactAnnotation'), value: pendingDelete.comment }]}
          actionLabel={t('notes.delete')}
          onConfirm={() => void removeAnnotation()}
        />
      ) : null}

      {confirmRevise ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o && !revising) setConfirmRevise(false);
          }}
          title={t('notes.revise')}
          consequence={t('notes.reviseConsequence', {
            version: (note?.contentVersion ?? 1) + 1,
          })}
          impact={[{ label: 'note', value: note?.title ?? '' }]}
          actionLabel={t('notes.revise')}
          busy={revising}
          onConfirm={() => void revise()}
        />
      ) : null}

      {confirmDeleteNote ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) setConfirmDeleteNote(false);
          }}
          title={t('notes.delete')}
          consequence={t('notes.deleteConsequence')}
          impact={[{ label: t('notes.impactNote'), value: note.title }]}
          actionLabel={t('notes.delete')}
          onConfirm={() => {
            setConfirmDeleteNote(false);
            void removeNote();
          }}
        />
      ) : null}
    </>
  );
}

function AnnotationCard({
  annotation,
  index,
  lost,
  focused,
  registerRef,
  onFocus,
  onToggle,
  onDelete,
}: {
  annotation: NoteAnnotation;
  index: number;
  lost: boolean;
  focused: boolean;
  registerRef: (el: HTMLDivElement | null) => void;
  onFocus: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const { t, lang } = useI18n();
  return (
    <div
      ref={registerRef}
      data-annotation={annotation.id}
      data-state={annotation.state}
      data-focus={focused ? 'true' : undefined}
      onClick={onFocus}
      className={
        focused
          ? 'border-signal bg-card flex flex-col gap-1.5 rounded-md border p-2.5 ring-1 ring-signal/40'
          : 'border-border bg-card flex flex-col gap-1.5 rounded-md border p-2.5'
      }
    >
      <div className="flex items-center gap-1.5">
        <span
          className={
            annotation.state === 'open'
              ? 'role-data-sm text-signal font-medium'
              : 'role-data-sm text-muted-foreground font-medium'
          }
        >
          {circled(index)}
        </span>
        <Badge
          variant="outline"
          className={
            annotation.state === 'open'
              ? 'text-state-warn-ink border-state-warn-ink/40 px-1.5 py-0 text-[10px]'
              : 'text-muted-foreground px-1.5 py-0 text-[10px]'
          }
        >
          {t(
            annotation.state === 'open' ? 'notes.annotationStateOpen' : 'notes.annotationStateDone',
          )}
        </Badge>
        {lost ? (
          <span className="role-data-sm text-state-fail-ink">{t('notes.annotationLost')}</span>
        ) : null}
        <span className="ml-auto flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            onClick={onToggle}
            aria-label={t(
              annotation.state === 'open' ? 'notes.resolveAnnotation' : 'notes.reopenAnnotation',
            )}
            title={t(
              annotation.state === 'open' ? 'notes.resolveAnnotation' : 'notes.reopenAnnotation',
            )}
          >
            {annotation.state === 'open' ? (
              <CheckIcon className="size-3" />
            ) : (
              <RotateCcwIcon className="size-3" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground size-6"
            onClick={onDelete}
            aria-label={t('notes.delete')}
          >
            <TrashIcon className="size-3" />
          </Button>
        </span>
      </div>
      <p className="bg-well border-well-edge text-muted-foreground role-data-sm line-clamp-2 rounded-r-sm border-l-2 px-2 py-1.5 leading-normal">
        {annotation.quote}
      </p>
      <p className="text-xs leading-relaxed">{annotation.comment}</p>
      <p className="role-data-sm text-muted-foreground">{fullDate(annotation.createdAt, lang)}</p>
    </div>
  );
}

function sourceLine(note: Note, t: ReturnType<typeof useI18n>['t']): string {
  const kind =
    note.source.kind === 'chat'
      ? t('notes.sourceChat')
      : note.source.kind === 'agent'
        ? t('notes.sourceAgent')
        : note.source.kind === 'url'
          ? t('notes.sourceUrl')
          : t('notes.sourceManual');
  return note.source.ref !== undefined ? `${kind} · ${note.source.ref}` : kind;
}
