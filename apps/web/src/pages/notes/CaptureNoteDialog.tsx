// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { SparklesIcon } from 'lucide-react';
import type { NoteCategory, NoteStatus, NoteVisibility } from '@harness-nexus/sdk';
import { HarnessNexusError } from '@harness-nexus/sdk';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n } from '@/i18n';
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
import { FormDialog } from '@/components/ui/form-dialog';
import { Field } from '@/components/kit';
import { NOTE_STATUSES, NOTE_STATUS_KEY } from './vocabulary';

/**
 * 保存为笔记 (#88 capture) — one assistant reply becomes a note. The body
 * arrives from the chat row; title defaults to the first markdown heading
 * (or the leading line); the summary can be AI-seeded in place (one-shot
 * server pass); the source records where it came from.
 */
export function CaptureNoteDialog({
  markdown,
  sourceRef,
  onClose,
}: {
  markdown: string;
  sourceRef: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { logout } = useAuth();
  const [title, setTitle] = useState(() => titleFromMarkdown(markdown));
  const [summary, setSummary] = useState('');
  const [seeding, setSeeding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [categories, setCategories] = useState<NoteCategory[]>([]);
  const [categoryId, setCategoryId] = useState('none');
  const [status, setStatus] = useState<NoteStatus>('inbox');
  const [visibility, setVisibility] = useState<NoteVisibility>('private');

  useEffect(() => {
    void (async () => {
      try {
        const res = await withAuthGuard(() => api.listNoteCategories(), logout);
        setCategories(res.categories);
      } catch {
        // The category select falls back to uncategorized on failure.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const categoryOptions = useMemo(() => flattenCategories(categories), [categories]);

  async function seedSummary(): Promise<void> {
    setSeeding(true);
    try {
      const res = await withAuthGuard(
        () =>
          api.summarizeNote({
            ...(title.trim() !== '' ? { title: title.trim() } : {}),
            contentMd: markdown,
          }),
        logout,
      );
      setSummary(res.summary);
    } catch (e) {
      toast.error(
        e instanceof HarnessNexusError && e.code === 'NOTE_AI_NO_PROVIDER'
          ? t('notes.aiNoProvider')
          : t('notes.aiFailed'),
      );
    } finally {
      setSeeding(false);
    }
  }

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    try {
      await withAuthGuard(
        () =>
          api.createNote({
            title: title.trim() === '' ? titleFromMarkdown(markdown) : title.trim(),
            ...(summary.trim() !== '' ? { summary: summary.trim() } : {}),
            contentMd: markdown,
            categoryId: categoryId === 'none' ? null : categoryId,
            tags: [],
            status,
            visibility,
            source: { kind: 'chat', ref: sourceRef },
          }),
        logout,
      );
      toast.success(t('notes.captureSaved'));
      onClose();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.createFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog open onClose={onClose} title={t('notes.captureTitle')}>
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <Field label={t('notes.titleLabel')} htmlFor="cap-title" required>
          <Input
            id="cap-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={200}
            autoComplete="off"
            required
          />
        </Field>
        <Field
          label={t('notes.summaryLabel')}
          htmlFor="cap-summary"
          aside={
            <button
              type="button"
              onClick={() => void seedSummary()}
              disabled={seeding}
              className="text-muted-foreground hover:text-foreground role-data-sm inline-flex items-center gap-1 rounded border px-1.5 py-0.5 transition-colors disabled:opacity-50"
            >
              <SparklesIcon className="size-3" />
              {seeding ? t('notes.aiSummarizing') : t('notes.aiSummarize')}
            </button>
          }
        >
          <Textarea
            id="cap-summary"
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder={t('notes.summaryPlaceholder')}
            maxLength={1000}
            autoComplete="off"
            className="max-h-40 min-h-16 resize-none overflow-y-auto text-xs leading-relaxed"
          />
        </Field>
        <Field label={t('notes.categoryLabel')} htmlFor="cap-category">
          <Select value={categoryId} onValueChange={setCategoryId}>
            <SelectTrigger id="cap-category" className="w-full justify-between">
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
        <div className="grid grid-cols-2 gap-2">
          <Field label={t('notes.statusLabel')} htmlFor="cap-status">
            <Select value={status} onValueChange={(v) => setStatus(v as NoteStatus)}>
              <SelectTrigger id="cap-status" className="w-full justify-between">
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
          <Field label={t('notes.visibilityLabel')} htmlFor="cap-visibility">
            <Select value={visibility} onValueChange={(v) => setVisibility(v as NoteVisibility)}>
              <SelectTrigger id="cap-visibility" className="w-full justify-between">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="private">{t('notes.privateChip')}</SelectItem>
                <SelectItem value="public">{t('notes.publicChip')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={busy}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </FormDialog>
  );
}

/** First `# heading` or the leading non-empty line, trimmed to a title. */
export function titleFromMarkdown(markdown: string): string {
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(trimmed);
    const text = (heading?.[1] ?? trimmed).trim();
    if (text !== '') return text.slice(0, 80);
  }
  return '—';
}

function flattenCategories(categories: NoteCategory[]): [string, string][] {
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
