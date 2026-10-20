// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon, PlusIcon, XIcon } from 'lucide-react';
import { useI18n, type TranslationKey } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { LabelText } from '@/components/kit';
import type { DeepseekConfig, RuntimeConfigSpec } from '@harness-nexus/sdk';

/**
 * #64 — the dsh dedicated panel. From the provider-config flow only the
 * CONNECTION (provider/credential/baseURL) carries in; the panel owns
 * everything model-shaped:
 *
 *  - models: default model + the switchable rows (dsh's `models:` list IS the
 *    session-switchable set)
 *  - per-model detail: display name, contextWindow, maxTokens (a CONFIGURED
 *    value also becomes that model's per-request default), vision (`input:
 *    ["text","image"]`)
 *
 * Deliberately thin: dsh's settings schema has NO sampling knobs, and the
 * `reasoningEfforts` / route `reasoning` / `compat` surfaces need per-gateway
 * wire spellings we cannot guess (v1 follow-ups) — no behavior section. The
 * writer's per-field precedence is panel value > #51 modelEntries seed > key
 * omitted (the route's own defaults apply, never a guessed value).
 */

export interface DsModelDraft {
  name: string;
  contextWindow: string;
  maxOutputTokens: string;
  vision: boolean;
}

export interface DsDraft {
  details: Record<string, DsModelDraft>;
}

/** Registry chat-model shape the pickers consume (structural — #51 rows). */
interface ChatModelOption {
  id: string;
  displayName?: string;
}

export function emptyDsModelDraft(): DsModelDraft {
  return { name: '', contextWindow: '', maxOutputTokens: '', vision: false };
}

export function emptyDsDraft(): DsDraft {
  return { details: {} };
}

export function dsDraftFromSpec(spec: RuntimeConfigSpec | null): DsDraft {
  const draft = emptyDsDraft();
  if (spec?.deepseek === undefined) return draft;
  for (const m of spec.deepseek.models ?? []) {
    draft.details[m.id] = {
      name: m.name ?? '',
      contextWindow: m.contextWindow?.toString() ?? '',
      maxOutputTokens: m.maxOutputTokens?.toString() ?? '',
      vision: m.vision === true,
    };
  }
  return draft;
}

/** First blocking problem, or null — gates Apply AND renders inline (#63 lesson). */
export function dsIssue(draft: DsDraft, ids: readonly string[]): TranslationKey | null {
  for (const id of ids) {
    const d = draft.details[id];
    if (d === undefined) continue;
    const ctx = d.contextWindow.trim();
    if (ctx !== '') {
      const n = Number(ctx);
      if (!Number.isInteger(n) || n < 1) return 'machineDetail.dsNumBadContext';
    }
    const out = d.maxOutputTokens.trim();
    if (out !== '') {
      const n = Number(out);
      if (!Number.isInteger(n) || n < 1) return 'machineDetail.dsNumBadOutput';
    }
  }
  return null;
}

/**
 * Wire shape — details serialize only for ids in the switchable set and only
 * when at least one knob is set; an all-default draft serializes to
 * `undefined` (untouched rows keep their pre-#64 shape). Assumes
 * `dsIssue(draft, ids) === null`.
 */
export function serializeDsDraft(
  draft: DsDraft,
  ids: readonly string[],
): DeepseekConfig | undefined {
  const models = ids.flatMap((id) => {
    const d = draft.details[id];
    if (d === undefined) return [];
    const any =
      d.name.trim() !== '' ||
      d.contextWindow.trim() !== '' ||
      d.maxOutputTokens.trim() !== '' ||
      d.vision;
    if (!any) return [];
    return [
      {
        id,
        ...(d.name.trim() !== '' ? { name: d.name.trim() } : {}),
        ...(d.contextWindow.trim() !== '' ? { contextWindow: Number(d.contextWindow) } : {}),
        ...(d.maxOutputTokens.trim() !== '' ? { maxOutputTokens: Number(d.maxOutputTokens) } : {}),
        ...(d.vision ? { vision: true } : {}),
      },
    ];
  });
  const cfg: DeepseekConfig = models.length > 0 ? { models } : {};
  return cfg.models === undefined ? undefined : cfg;
}

export function DeepseekPanel({
  draft,
  onChange,
  defaultModel,
  onDefaultModelChange,
  extraModels,
  onExtraModelsChange,
  chatModels,
}: {
  draft: DsDraft;
  onChange: (next: DsDraft) => void;
  defaultModel: string;
  onDefaultModelChange: (next: string) => void;
  extraModels: string[];
  onExtraModelsChange: (next: string[]) => void;
  chatModels: readonly ChatModelOption[];
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const useModelSelect = chatModels.length > 0;
  const ids = switchableIds(defaultModel, extraModels);
  const issue = dsIssue(draft, ids);

  const setDetail = (id: string, patch: Partial<DsModelDraft>): void => {
    onChange({
      ...draft,
      details: {
        ...draft.details,
        [id]: { ...(draft.details[id] ?? emptyDsModelDraft()), ...patch },
      },
    });
  };

  return (
    <section className="flex flex-col gap-5 rounded-lg border p-4">
      <div>
        <p className="text-sm font-medium">{t('machineDetail.dsTitle')}</p>
        <p className="text-muted-foreground text-xs">{t('machineDetail.dsDesc')}</p>
      </div>

      {/* ---- models ---- */}
      <div className="flex flex-col gap-3">
        <LabelText as="p">{t('machineDetail.dsSectionModels')}</LabelText>
        <div className="flex max-w-2xl items-end gap-4">
          <div className="grid min-w-52 flex-1 gap-2">
            <Label htmlFor="ds-model">{t('machineDetail.modelDefaultLabel')}</Label>
            {useModelSelect ? (
              <Select value={defaultModel} onValueChange={onDefaultModelChange}>
                <SelectTrigger id="ds-model" className="w-full font-mono text-xs">
                  <SelectValue placeholder={t('machineDetail.pickModel')} />
                </SelectTrigger>
                <SelectContent>
                  {defaultModel.trim() !== '' &&
                  !chatModels.some((m) => m.id === defaultModel.trim()) ? (
                    <SelectItem value={defaultModel.trim()} className="font-mono text-xs">
                      {defaultModel.trim()}
                    </SelectItem>
                  ) : null}
                  {chatModels.map((m) => (
                    <SelectItem key={m.id} value={m.id} className="font-mono text-xs">
                      {m.displayName ?? m.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                id="ds-model"
                value={defaultModel}
                onChange={(e) => onDefaultModelChange(e.target.value)}
                className="font-mono text-xs"
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-sm leading-none font-medium">
              {t('machineDetail.extraModelsTitle')}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs [@media(pointer:coarse)]:h-9"
              onClick={() => onExtraModelsChange([...extraModels, ''])}
            >
              <PlusIcon className="size-3.5" />
              {t('machineDetail.extraModelsAdd')}
            </Button>
          </div>
          {extraModels.map((m, i) => {
            const used = new Set(
              [defaultModel, ...extraModels.filter((_, j) => j !== i)]
                .map((x) => x.trim())
                .filter((x) => x !== ''),
            );
            const rowOptions = chatModels.filter((mm) => mm.id === m.trim() || !used.has(mm.id));
            return (
              <div key={i} className="flex max-w-2xl flex-wrap items-center gap-2">
                {useModelSelect ? (
                  <Select
                    value={m}
                    onValueChange={(v) =>
                      onExtraModelsChange(extraModels.map((x, j) => (j === i ? v : x)))
                    }
                  >
                    <SelectTrigger
                      aria-label={t('machineDetail.pickModel')}
                      className="min-w-0 flex-1 font-mono text-xs"
                    >
                      <SelectValue placeholder={t('machineDetail.pickModel')} />
                    </SelectTrigger>
                    <SelectContent>
                      {m.trim() !== '' && !chatModels.some((mm) => mm.id === m.trim()) ? (
                        <SelectItem value={m.trim()} className="font-mono text-xs">
                          {m.trim()}
                        </SelectItem>
                      ) : null}
                      {rowOptions.map((mm) => (
                        <SelectItem key={mm.id} value={mm.id} className="font-mono text-xs">
                          {mm.displayName ?? mm.id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Input
                    value={m}
                    onChange={(e) =>
                      onExtraModelsChange(extraModels.map((x, j) => (j === i ? e.target.value : x)))
                    }
                    placeholder={t('machineDetail.extraModelsPlaceholder')}
                    className="min-w-0 flex-1 font-mono text-xs"
                    autoComplete="off"
                    spellCheck={false}
                  />
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground h-(--control-h) shrink-0 px-2 text-xs hover:text-foreground"
                  disabled={m.trim() === '' || m.trim() === defaultModel.trim()}
                  onClick={() => {
                    const id = m.trim();
                    const old = defaultModel;
                    onDefaultModelChange(id);
                    const kept = extraModels.filter((_, j) => j !== i);
                    if (old !== '' && old !== id && !kept.some((x) => x.trim() === old)) {
                      kept.push(old);
                    }
                    onExtraModelsChange(kept);
                  }}
                >
                  {t('machineDetail.extraModelsMakeDefault')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground size-8 shrink-0 hover:text-danger"
                  onClick={() => onExtraModelsChange(extraModels.filter((_, j) => j !== i))}
                  aria-label={t('machineDetail.extraModelsRemove', {
                    model: m === '' ? '…' : m,
                  })}
                >
                  <XIcon className="size-3.5" />
                </Button>
              </div>
            );
          })}
          <p className="text-muted-foreground text-xs">{t('machineDetail.dsExtrasHint')}</p>
        </div>
      </div>

      {/* ---- per-model details ---- */}
      <div className="flex flex-col gap-2 border-t pt-4">
        <LabelText as="p">{t('machineDetail.dsSectionDetails')}</LabelText>
        <p className="text-muted-foreground text-xs">{t('machineDetail.dsDetailsHint')}</p>
        {ids.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t('machineDetail.dsDetailsEmpty')}</p>
        ) : (
          ids.map((id) => {
            const d = draft.details[id] ?? emptyDsModelDraft();
            const isOpen = expanded[id] === true;
            return (
              <div key={id} className="rounded-md border bg-muted/20">
                <button
                  type="button"
                  className="hover:bg-tray/40 flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2.5 text-left"
                  aria-expanded={isOpen}
                  onClick={() => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }))}
                >
                  <span className="role-data truncate font-mono text-xs">{id}</span>
                  {isOpen ? (
                    <ChevronDownIcon className="text-muted-foreground size-4 shrink-0" />
                  ) : (
                    <ChevronRightIcon className="text-muted-foreground size-4 shrink-0" />
                  )}
                </button>
                {isOpen ? (
                  <div className="grid gap-3 border-t p-3">
                    <div className="grid gap-1">
                      <Label htmlFor={`ds-name-${cssEscape(id)}`}>
                        {t('machineDetail.dsNameLabel')}
                      </Label>
                      <Input
                        id={`ds-name-${cssEscape(id)}`}
                        value={d.name}
                        onChange={(e) => setDetail(id, { name: e.target.value })}
                        placeholder={t('machineDetail.dsNamePh')}
                        className="text-xs"
                        autoComplete="off"
                      />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="grid gap-1">
                        <Label htmlFor={`ds-ctx-${cssEscape(id)}`}>
                          {t('machineDetail.dsContextLabel')}
                        </Label>
                        <Input
                          id={`ds-ctx-${cssEscape(id)}`}
                          type="number"
                          value={d.contextWindow}
                          onChange={(e) => setDetail(id, { contextWindow: e.target.value })}
                          min={1}
                          step={1}
                          className="font-mono text-xs"
                          autoComplete="off"
                        />
                        <p className="text-muted-foreground text-xs">
                          {t('machineDetail.dsContextHint')}
                        </p>
                      </div>
                      <div className="grid gap-1">
                        <Label htmlFor={`ds-out-${cssEscape(id)}`}>
                          {t('machineDetail.dsOutputLabel')}
                        </Label>
                        <Input
                          id={`ds-out-${cssEscape(id)}`}
                          type="number"
                          value={d.maxOutputTokens}
                          onChange={(e) => setDetail(id, { maxOutputTokens: e.target.value })}
                          min={1}
                          step={1}
                          className="font-mono text-xs"
                          autoComplete="off"
                        />
                        <p className="text-muted-foreground text-xs">
                          {t('machineDetail.dsOutputHint')}
                        </p>
                      </div>
                    </div>
                    <label className="flex items-center gap-2 py-1 text-sm [@media(pointer:coarse)]:py-2.5">
                      <Checkbox
                        checked={d.vision}
                        onCheckedChange={(v) => setDetail(id, { vision: v === true })}
                      />
                      {t('machineDetail.dsVision')}
                    </label>
                    <p className="text-muted-foreground text-xs">
                      {t('machineDetail.dsVisionHint')}
                    </p>
                  </div>
                ) : null}
              </div>
            );
          })
        )}
        {/* The validation gate renders inline (the #63 lesson). */}
        {issue !== null ? <p className="text-danger text-xs">{t(issue)}</p> : null}
      </div>
    </section>
  );
}

/** The switchable set: the default plus the extras, trimmed, deduped. */
function switchableIds(defaultModel: string, extraModels: string[]): string[] {
  return [...new Set([defaultModel, ...extraModels].map((x) => x.trim()).filter((x) => x !== ''))];
}

/** ids are provider model ids — dots/colons are legal, CSS escapes are not. */
function cssEscape(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}
