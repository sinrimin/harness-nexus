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
import {
  EXTRA_BODY_BOOLEAN_KEYS,
  type OpencodeConfig,
  type RuntimeConfigSpec,
} from '@harness-nexus/sdk';

/**
 * #62 — the opencode dedicated panel. From the provider-config flow only the
 * CONNECTION (provider/credential) carries in; the panel owns everything
 * model-shaped plus opencode's own knobs:
 *
 *  - models: default model + the switchable allowlist rows, and a per-model
 *    detail group (display name, limit.context / limit.output, capability
 *    toggles reasoning / temperature-gate / attachment, `options` body keys)
 *  - behavior: `small_model` (opencode's background model for lightweight
 *    tasks — the analog of claude-code's haiku pin) and `autoupdate: false`
 *
 * Stored on `spec.opencode`; the writer's per-field precedence is panel
 * value > #51 modelEntries seed > conservative fallback — `limit.*` are
 * REQUIRED by opencode's schema, so an unset field falls back instead of
 * deleting a key. Detail groups are labeled blocks at EVERY width (the #60
 * mobile lesson, applied from the start).
 *
 * `options` values reuse the #56 editing idiom: known boolean keys ride a
 * Switch, everything else is raw JSON parsed at the apply boundary.
 */

/** One options entry's editor state (#56 idiom). */
export interface OcOptionEntry {
  key: string;
  text: string;
  bool: boolean;
}

export interface OcModelDraft {
  name: string;
  contextWindow: string;
  maxOutputTokens: string;
  reasoning: boolean;
  temperatureEnabled: boolean;
  vision: boolean;
  options: OcOptionEntry[];
}

export interface OcDraft {
  details: Record<string, OcModelDraft>;
  smallModel: string;
  autoupdateDisabled: boolean;
}

/** Registry chat-model shape the pickers consume (structural — #51 rows). */
interface ChatModelOption {
  id: string;
  displayName?: string;
}

export function emptyOcModelDraft(): OcModelDraft {
  return {
    name: '',
    contextWindow: '',
    maxOutputTokens: '',
    reasoning: false,
    temperatureEnabled: false,
    vision: false,
    options: [],
  };
}

export function emptyOcDraft(): OcDraft {
  return { details: {}, smallModel: '', autoupdateDisabled: false };
}

export function ocDraftFromSpec(spec: RuntimeConfigSpec | null): OcDraft {
  const draft = emptyOcDraft();
  if (spec?.opencode === undefined) return draft;
  for (const m of spec.opencode.models ?? []) {
    draft.details[m.id] = {
      name: m.name ?? '',
      contextWindow: m.contextWindow?.toString() ?? '',
      maxOutputTokens: m.maxOutputTokens?.toString() ?? '',
      reasoning: m.reasoning === true,
      temperatureEnabled: m.temperatureEnabled === true,
      vision: m.vision === true,
      options: Object.entries(m.options ?? {}).map(([key, v]) => ({
        key,
        bool: EXTRA_BODY_BOOLEAN_KEYS.has(key) && v === true,
        text: EXTRA_BODY_BOOLEAN_KEYS.has(key) || v === undefined ? '' : (JSON.stringify(v) ?? ''),
      })),
    };
  }
  draft.smallModel = spec.opencode.smallModel ?? '';
  draft.autoupdateDisabled = spec.opencode.autoupdateDisabled === true;
  return draft;
}

/** First blocking problem, or null — the apply button stays disabled while set. */
export function ocIssue(draft: OcDraft, ids: readonly string[]): TranslationKey | null {
  for (const id of ids) {
    const d = draft.details[id];
    if (d === undefined) continue;
    const ctx = d.contextWindow.trim();
    if (ctx !== '') {
      const n = Number(ctx);
      if (!Number.isInteger(n) || n < 1) return 'machineDetail.ocNumBadContext';
    }
    const out = d.maxOutputTokens.trim();
    if (out !== '') {
      const n = Number(out);
      if (!Number.isInteger(n) || n < 1 || n > 128000) return 'machineDetail.ocNumBadOutput';
    }
    const fault = optionsFault(d);
    if (fault !== null) return fault;
  }
  return null;
}

/**
 * Wire shape — details serialize only for ids in the switchable set and only
 * when at least one knob is set; `smallModel` drops when its id left the set
 * (the writer would point opencode at an unlisted route). An all-default
 * draft serializes to `undefined` (untouched rows keep their pre-#62 shape).
 * Assumes `ocIssue(draft, ids) === null`.
 */
export function serializeOcDraft(
  draft: OcDraft,
  ids: readonly string[],
): OpencodeConfig | undefined {
  const models = ids.flatMap((id) => {
    const d = draft.details[id];
    if (d === undefined) return [];
    const options = Object.fromEntries(
      d.options.map((e) => [
        e.key,
        EXTRA_BODY_BOOLEAN_KEYS.has(e.key) ? e.bool : JSON.parse(e.text),
      ]),
    );
    const any =
      d.name.trim() !== '' ||
      d.contextWindow.trim() !== '' ||
      d.maxOutputTokens.trim() !== '' ||
      d.reasoning ||
      d.temperatureEnabled ||
      d.vision ||
      d.options.length > 0;
    if (!any) return [];
    return [
      {
        id,
        ...(d.name.trim() !== '' ? { name: d.name.trim() } : {}),
        ...(d.contextWindow.trim() !== '' ? { contextWindow: Number(d.contextWindow) } : {}),
        ...(d.maxOutputTokens.trim() !== '' ? { maxOutputTokens: Number(d.maxOutputTokens) } : {}),
        ...(d.reasoning ? { reasoning: true } : {}),
        ...(d.temperatureEnabled ? { temperatureEnabled: true } : {}),
        ...(d.vision ? { vision: true } : {}),
        ...(d.options.length > 0 ? { options } : {}),
      },
    ];
  });
  const smallModel = ids.includes(draft.smallModel) ? draft.smallModel : '';
  const cfg: OpencodeConfig = {
    ...(models.length > 0 ? { models } : {}),
    ...(smallModel !== '' ? { smallModel } : {}),
    ...(draft.autoupdateDisabled ? { autoupdateDisabled: true } : {}),
  };
  const empty =
    cfg.models === undefined &&
    cfg.smallModel === undefined &&
    cfg.autoupdateDisabled === undefined;
  return empty ? undefined : cfg;
}

export function OpencodePanel({
  draft,
  onChange,
  defaultModel,
  onDefaultModelChange,
  extraModels,
  onExtraModelsChange,
  chatModels,
}: {
  draft: OcDraft;
  onChange: (next: OcDraft) => void;
  defaultModel: string;
  onDefaultModelChange: (next: string) => void;
  extraModels: string[];
  onExtraModelsChange: (next: string[]) => void;
  chatModels: readonly ChatModelOption[];
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const issue = ocIssue(draft, switchableIds(defaultModel, extraModels));
  const useModelSelect = chatModels.length > 0;
  const ids = switchableIds(defaultModel, extraModels);

  const setDetail = (id: string, patch: Partial<OcModelDraft>): void => {
    onChange({
      ...draft,
      details: {
        ...draft.details,
        [id]: { ...(draft.details[id] ?? emptyOcModelDraft()), ...patch },
      },
    });
  };

  return (
    <section className="flex flex-col gap-5 rounded-lg border p-4">
      <div>
        <p className="text-sm font-medium">{t('machineDetail.ocTitle')}</p>
        <p className="text-muted-foreground text-xs">{t('machineDetail.ocDesc')}</p>
      </div>

      {/* ---- models ---- */}
      <div className="flex flex-col gap-3">
        <LabelText as="p">{t('machineDetail.ocSectionModels')}</LabelText>
        <div className="flex max-w-2xl items-end gap-4">
          <div className="grid min-w-52 flex-1 gap-2">
            <Label htmlFor="oc-model">{t('machineDetail.modelDefaultLabel')}</Label>
            {useModelSelect ? (
              <Select value={defaultModel} onValueChange={onDefaultModelChange}>
                <SelectTrigger id="oc-model" className="w-full font-mono text-xs">
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
                id="oc-model"
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
          <p className="text-muted-foreground text-xs">{t('machineDetail.extraModelsHint')}</p>
        </div>
      </div>

      {/* ---- per-model details ---- */}
      <div className="flex flex-col gap-2 border-t pt-4">
        <LabelText as="p">{t('machineDetail.ocSectionDetails')}</LabelText>
        <p className="text-muted-foreground text-xs">{t('machineDetail.ocDetailsHint')}</p>
        {ids.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t('machineDetail.ocDetailsEmpty')}</p>
        ) : (
          ids.map((id) => {
            const d = draft.details[id] ?? emptyOcModelDraft();
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
                      <Label htmlFor={`oc-name-${cssEscape(id)}`}>
                        {t('machineDetail.ocNameLabel')}
                      </Label>
                      <Input
                        id={`oc-name-${cssEscape(id)}`}
                        value={d.name}
                        onChange={(e) => setDetail(id, { name: e.target.value })}
                        placeholder={t('machineDetail.ocNamePh')}
                        className="text-xs"
                        autoComplete="off"
                      />
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="grid gap-1">
                        <Label htmlFor={`oc-ctx-${cssEscape(id)}`}>
                          {t('machineDetail.ocContextLabel')}
                        </Label>
                        <Input
                          id={`oc-ctx-${cssEscape(id)}`}
                          type="number"
                          value={d.contextWindow}
                          onChange={(e) => setDetail(id, { contextWindow: e.target.value })}
                          min={1}
                          step={1}
                          className="font-mono text-xs"
                          autoComplete="off"
                        />
                        <p className="text-muted-foreground text-xs">
                          {t('machineDetail.ocContextHint')}
                        </p>
                      </div>
                      <div className="grid gap-1">
                        <Label htmlFor={`oc-out-${cssEscape(id)}`}>
                          {t('machineDetail.ocOutputLabel')}
                        </Label>
                        <Input
                          id={`oc-out-${cssEscape(id)}`}
                          type="number"
                          value={d.maxOutputTokens}
                          onChange={(e) => setDetail(id, { maxOutputTokens: e.target.value })}
                          min={1}
                          max={128000}
                          step={1}
                          className="font-mono text-xs"
                          autoComplete="off"
                        />
                        <p className="text-muted-foreground text-xs">
                          {t('machineDetail.ocOutputHint')}
                        </p>
                      </div>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-3">
                      {(
                        [
                          ['reasoning', 'ocReasoning'],
                          ['temperatureEnabled', 'ocTemperatureGate'],
                          ['vision', 'ocVision'],
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
                      {t('machineDetail.ocTemperatureHint')}
                    </p>
                    <div className="grid gap-1.5">
                      <Label htmlFor={`oc-opts-${cssEscape(id)}`}>
                        {t('machineDetail.ocOptionsLabel')}
                      </Label>
                      <TagCombobox
                        id={`oc-opts-${cssEscape(id)}`}
                        value={d.options.map((e) => e.key)}
                        options={[]}
                        onChange={(keys) =>
                          setDetail(id, {
                            options: keys.map((key) => {
                              const hit = d.options.find((e) => e.key === key);
                              return hit ?? { key, text: '', bool: false };
                            }),
                          })
                        }
                        placeholder={t('machineDetail.ocOptionsKeyPh')}
                        addLabel={(value) => t('llmProviders.tagComboboxAdd', { value })}
                        removeLabel={(value) => t('llmProviders.tagComboboxRemove', { value })}
                        ariaLabel={`${id} ${t('machineDetail.ocOptionsLabel')}`}
                        className="min-h-(--control-h) text-xs"
                      />
                      {d.options.map((e) => (
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
                                    options: d.options.map((x) =>
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
                                  options: d.options.map((x) =>
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
                        {t('machineDetail.ocOptionsHint')}
                      </p>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      {/* ---- behavior ---- */}
      <div className="flex flex-col gap-3 border-t pt-4">
        <LabelText as="p">{t('machineDetail.ocSectionBehavior')}</LabelText>
        <div className="grid max-w-2xl gap-2">
          <Label htmlFor="oc-small-model">{t('machineDetail.ocSmallModelLabel')}</Label>
          <Select
            value={draft.smallModel === '' ? '__none__' : draft.smallModel}
            onValueChange={(v) => onChange({ ...draft, smallModel: v === '__none__' ? '' : v })}
          >
            <SelectTrigger id="oc-small-model" className="w-full font-mono text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">{t('machineDetail.ocSmallModelNone')}</SelectItem>
              {ids.map((id) => (
                <SelectItem key={id} value={id} className="font-mono text-xs">
                  {id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs">{t('machineDetail.ocSmallModelHint')}</p>
        </div>
        <label className="flex items-center gap-2 py-1 text-sm [@media(pointer:coarse)]:py-2.5">
          <Checkbox
            checked={draft.autoupdateDisabled}
            onCheckedChange={(v) => onChange({ ...draft, autoupdateDisabled: v === true })}
          />
          {t('machineDetail.ocAutoupdate')}
        </label>
        <p className="text-muted-foreground text-xs">{t('machineDetail.ocAutoupdateHint')}</p>
      </div>
    </section>
  );
}

/** One model's options fault, or null — rendered inside its own group. */
function optionsFault(d: OcModelDraft): TranslationKey | null {
  for (const e of d.options) {
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
