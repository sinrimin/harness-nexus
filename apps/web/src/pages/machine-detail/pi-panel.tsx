// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon, PlusIcon, XIcon } from 'lucide-react';
import { useI18n, type TranslationKey } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { LabelText, TagCombobox } from '@/components/kit';
import { EXTRA_BODY_BOOLEAN_KEYS, type PiConfig, type RuntimeConfigSpec } from '@harness-nexus/sdk';

/**
 * #65 — the pi dedicated panel. From the provider-config flow only the
 * CONNECTION (provider/credential/baseURL) carries in; the panel owns
 * everything model-shaped:
 *
 *  - models: default model + the switchable rows (settings `enabledModels`)
 *  - per-model detail: display name, contextWindow, maxTokens, vision +
 *    pi's OWN knob vocabulary — `reasoning: true` (a boolean capability
 *    declaration) and `samplingParams` (free request-body keys, edited with
 *    the #56 TagCombobox + Switch/JSON idiom; effective on the openai wires,
 *    silently ignored on anthropic — the registry's warn-not-reject stance).
 *
 * Writer precedence per field: panel value > #51 modelEntries seed > key
 * omitted (reasoning/samplingParams are panel-only). No behavior section —
 * pi's settings.json (default route + enabledModels) is already fully
 * managed by the W16 writer, and its 55 fields carry nothing sampling-shaped.
 */

/** One samplingParams entry's editor state (#56 idiom). */
export interface PiParamEntry {
  key: string;
  text: string;
  bool: boolean;
}

export interface PiModelDraft {
  name: string;
  contextWindow: string;
  maxOutputTokens: string;
  vision: boolean;
  reasoning: boolean;
  samplingParams: PiParamEntry[];
}

export interface PiDraft {
  details: Record<string, PiModelDraft>;
}

/** Registry chat-model shape the pickers consume (structural — #51 rows). */
interface ChatModelOption {
  id: string;
  displayName?: string;
}

export function emptyPiModelDraft(): PiModelDraft {
  return {
    name: '',
    contextWindow: '',
    maxOutputTokens: '',
    vision: false,
    reasoning: false,
    samplingParams: [],
  };
}

export function emptyPiDraft(): PiDraft {
  return { details: {} };
}

export function piDraftFromSpec(spec: RuntimeConfigSpec | null): PiDraft {
  const draft = emptyPiDraft();
  if (spec?.pi === undefined) return draft;
  for (const m of spec.pi.models ?? []) {
    draft.details[m.id] = {
      name: m.name ?? '',
      contextWindow: m.contextWindow?.toString() ?? '',
      maxOutputTokens: m.maxOutputTokens?.toString() ?? '',
      vision: m.vision === true,
      reasoning: m.reasoning === true,
      samplingParams: Object.entries(m.samplingParams ?? {}).map(([key, v]) => ({
        key,
        bool: EXTRA_BODY_BOOLEAN_KEYS.has(key) && v === true,
        text: EXTRA_BODY_BOOLEAN_KEYS.has(key) || v === undefined ? '' : (JSON.stringify(v) ?? ''),
      })),
    };
  }
  return draft;
}

/** First blocking problem, or null — gates Apply AND renders inline (#63 lesson). */
export function piIssue(draft: PiDraft, ids: readonly string[]): TranslationKey | null {
  for (const id of ids) {
    const d = draft.details[id];
    if (d === undefined) continue;
    const ctx = d.contextWindow.trim();
    if (ctx !== '') {
      const n = Number(ctx);
      if (!Number.isInteger(n) || n < 1) return 'machineDetail.piNumBadContext';
    }
    const out = d.maxOutputTokens.trim();
    if (out !== '') {
      const n = Number(out);
      if (!Number.isInteger(n) || n < 1) return 'machineDetail.piNumBadOutput';
    }
    const fault = paramsFault(d);
    if (fault !== null) return fault;
  }
  return null;
}

/**
 * Wire shape — details serialize only for ids in the switchable set and only
 * when at least one knob is set; an all-default draft serializes to
 * `undefined` (untouched rows keep their pre-#65 shape). Assumes
 * `piIssue(draft, ids) === null`.
 */
export function serializePiDraft(draft: PiDraft, ids: readonly string[]): PiConfig | undefined {
  const models = ids.flatMap((id) => {
    const d = draft.details[id];
    if (d === undefined) return [];
    const samplingParams = Object.fromEntries(
      d.samplingParams.map((e) => [
        e.key,
        EXTRA_BODY_BOOLEAN_KEYS.has(e.key) ? e.bool : JSON.parse(e.text),
      ]),
    );
    const any =
      d.name.trim() !== '' ||
      d.contextWindow.trim() !== '' ||
      d.maxOutputTokens.trim() !== '' ||
      d.vision ||
      d.reasoning ||
      d.samplingParams.length > 0;
    if (!any) return [];
    return [
      {
        id,
        ...(d.name.trim() !== '' ? { name: d.name.trim() } : {}),
        ...(d.contextWindow.trim() !== '' ? { contextWindow: Number(d.contextWindow) } : {}),
        ...(d.maxOutputTokens.trim() !== '' ? { maxOutputTokens: Number(d.maxOutputTokens) } : {}),
        ...(d.vision ? { vision: true } : {}),
        ...(d.reasoning ? { reasoning: true } : {}),
        ...(d.samplingParams.length > 0 ? { samplingParams } : {}),
      },
    ];
  });
  const cfg: PiConfig = models.length > 0 ? { models } : {};
  return cfg.models === undefined ? undefined : cfg;
}

export function PiPanel({
  draft,
  onChange,
  defaultModel,
  onDefaultModelChange,
  extraModels,
  onExtraModelsChange,
  chatModels,
}: {
  draft: PiDraft;
  onChange: (next: PiDraft) => void;
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
  const issue = piIssue(draft, ids);

  const setDetail = (id: string, patch: Partial<PiModelDraft>): void => {
    onChange({
      ...draft,
      details: {
        ...draft.details,
        [id]: { ...(draft.details[id] ?? emptyPiModelDraft()), ...patch },
      },
    });
  };

  return (
    <section className="flex flex-col gap-5 rounded-lg border p-4">
      <div>
        <p className="text-sm font-medium">{t('machineDetail.piTitle')}</p>
        <p className="text-muted-foreground text-xs">{t('machineDetail.piDesc')}</p>
      </div>

      {/* ---- models ---- */}
      <div className="flex flex-col gap-3">
        <LabelText as="p">{t('machineDetail.piSectionModels')}</LabelText>
        <div className="flex max-w-2xl items-end gap-4">
          <div className="grid min-w-52 flex-1 gap-2">
            <Label htmlFor="pi-model">{t('machineDetail.modelDefaultLabel')}</Label>
            {useModelSelect ? (
              <Select value={defaultModel} onValueChange={onDefaultModelChange}>
                <SelectTrigger id="pi-model" className="w-full font-mono text-xs">
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
                id="pi-model"
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
          <p className="text-muted-foreground text-xs">{t('machineDetail.piExtrasHint')}</p>
        </div>
      </div>

      {/* ---- per-model details ---- */}
      <div className="flex flex-col gap-2 border-t pt-4">
        <LabelText as="p">{t('machineDetail.piSectionDetails')}</LabelText>
        <p className="text-muted-foreground text-xs">{t('machineDetail.piDetailsHint')}</p>
        {ids.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t('machineDetail.piDetailsEmpty')}</p>
        ) : (
          ids.map((id) => {
            const d = draft.details[id] ?? emptyPiModelDraft();
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
                      <Label htmlFor={`pi-name-${cssEscape(id)}`}>
                        {t('machineDetail.piNameLabel')}
                      </Label>
                      <Input
                        id={`pi-name-${cssEscape(id)}`}
                        value={d.name}
                        onChange={(e) => setDetail(id, { name: e.target.value })}
                        placeholder={t('machineDetail.piNamePh')}
                        className="text-xs"
                        autoComplete="off"
                      />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="grid gap-1">
                        <Label htmlFor={`pi-ctx-${cssEscape(id)}`}>
                          {t('machineDetail.piContextLabel')}
                        </Label>
                        <Input
                          id={`pi-ctx-${cssEscape(id)}`}
                          type="number"
                          value={d.contextWindow}
                          onChange={(e) => setDetail(id, { contextWindow: e.target.value })}
                          min={1}
                          step={1}
                          className="font-mono text-xs"
                          autoComplete="off"
                        />
                        <p className="text-muted-foreground text-xs">
                          {t('machineDetail.piContextHint')}
                        </p>
                      </div>
                      <div className="grid gap-1">
                        <Label htmlFor={`pi-out-${cssEscape(id)}`}>
                          {t('machineDetail.piOutputLabel')}
                        </Label>
                        <Input
                          id={`pi-out-${cssEscape(id)}`}
                          type="number"
                          value={d.maxOutputTokens}
                          onChange={(e) => setDetail(id, { maxOutputTokens: e.target.value })}
                          min={1}
                          step={1}
                          className="font-mono text-xs"
                          autoComplete="off"
                        />
                        <p className="text-muted-foreground text-xs">
                          {t('machineDetail.piOutputHint')}
                        </p>
                      </div>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {(
                        [
                          ['vision', 'piVision'],
                          ['reasoning', 'piReasoning'],
                        ] as const
                      ).map(([key, label]) => (
                        <label
                          key={key}
                          className="flex items-center gap-2 py-1 text-sm [@media(pointer:coarse)]:py-2.5"
                        >
                          <Checkbox
                            checked={d[key]}
                            onCheckedChange={(v) => setDetail(id, { [key]: v === true })}
                          />
                          {t(`machineDetail.${label}` as TranslationKey)}
                        </label>
                      ))}
                    </div>
                    <p className="text-muted-foreground text-xs">
                      {t('machineDetail.piReasoningHint')}
                    </p>
                    <div className="grid gap-1.5">
                      <Label htmlFor={`pi-params-${cssEscape(id)}`}>
                        {t('machineDetail.piParamsLabel')}
                      </Label>
                      <TagCombobox
                        id={`pi-params-${cssEscape(id)}`}
                        value={d.samplingParams.map((e) => e.key)}
                        options={[]}
                        onChange={(keys) =>
                          setDetail(id, {
                            samplingParams: keys.map((key) => {
                              const hit = d.samplingParams.find((e) => e.key === key);
                              return hit ?? { key, text: '', bool: false };
                            }),
                          })
                        }
                        placeholder={t('machineDetail.piParamsKeyPh')}
                        addLabel={(value) => t('llmProviders.tagComboboxAdd', { value })}
                        removeLabel={(value) => t('llmProviders.tagComboboxRemove', { value })}
                        ariaLabel={`${id} ${t('machineDetail.piParamsLabel')}`}
                        className="min-h-(--control-h) text-xs"
                      />
                      {d.samplingParams.map((e) => (
                        <div
                          key={e.key}
                          className="grid gap-1.5 sm:grid-cols-[minmax(0,220px)_minmax(0,1fr)] sm:items-center"
                        >
                          <span className="role-data-sm truncate font-mono text-xs" title={e.key}>
                            {e.key}
                          </span>
                          {EXTRA_BODY_BOOLEAN_KEYS.has(e.key) ? (
                            <div className="flex h-(--control-h) items-center">
                              <Switch
                                checked={e.bool}
                                onCheckedChange={(v) =>
                                  setDetail(id, {
                                    samplingParams: d.samplingParams.map((x) =>
                                      x.key === e.key ? { ...x, bool: v } : x,
                                    ),
                                  })
                                }
                                aria-label={e.key}
                              />
                            </div>
                          ) : (
                            <Input
                              value={e.text}
                              onChange={(ev) =>
                                setDetail(id, {
                                  samplingParams: d.samplingParams.map((x) =>
                                    x.key === e.key ? { ...x, text: ev.target.value } : x,
                                  ),
                                })
                              }
                              placeholder={t('llmProviders.extraBodyValuePlaceholder')}
                              className="font-mono text-xs"
                              autoComplete="off"
                              spellCheck={false}
                            />
                          )}
                        </div>
                      ))}
                      <p className="text-muted-foreground text-xs">
                        {t('machineDetail.piParamsHint')}
                      </p>
                    </div>
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

/** One model's samplingParams fault, or null — rendered inside its group. */
function paramsFault(d: PiModelDraft): TranslationKey | null {
  for (const e of d.samplingParams) {
    if (EXTRA_BODY_BOOLEAN_KEYS.has(e.key)) continue;
    try {
      JSON.parse(e.text);
    } catch {
      return 'llmProviders.extraBodyInvalid';
    }
  }
  return null;
}

/** The switchable set: the default plus the extras, trimmed, deduped. */
function switchableIds(defaultModel: string, extraModels: string[]): string[] {
  return [...new Set([defaultModel, ...extraModels].map((x) => x.trim()).filter((x) => x !== ''))];
}

/** ids are provider model ids — dots/colons are legal, CSS escapes are not. */
function cssEscape(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}
