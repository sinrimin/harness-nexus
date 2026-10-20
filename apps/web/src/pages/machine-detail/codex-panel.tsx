// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { Checkbox } from '@/components/ui/checkbox';
import { PlusIcon, XIcon } from 'lucide-react';
import { useI18n, type TranslationKey } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { LabelText } from '@/components/kit';
import {
  CODEX_REASONING_EFFORTS,
  CODEX_REASONING_SUMMARIES,
  CODEX_VERBOSITIES,
  type CodexConfig,
  type RuntimeConfigSpec,
} from '@harness-nexus/sdk';

/**
 * #63 — the codex dedicated panel. From the provider-config flow only the
 * CONNECTION (provider/credential/base URL) carries in; the panel owns
 * everything model-shaped plus codex's own knobs (all TOP-LEVEL config.toml
 * keys — single global value per install):
 *
 *  - models: default model + the switchable rows (the terminal /model picker
 *    stays codex's own; the rows drive the platform chat sessions' picker)
 *  - reasoning: `model_reasoning_effort` / `model_reasoning_summary` /
 *    `model_verbosity` — selects with an unset (codex-default) option
 *  - context: `model_context_window` (panel value > #51 registry seed in the
 *    writer; codex assumes 272k for unknown ids) and
 *    `model_auto_compact_token_limit`, plus the 1M quick-set that pairs
 *    1,000,000 with 900,000 (the cc-switch interaction)
 *  - behavior: `check_for_update_on_startup = false` while switched on
 *
 * Stored on `spec.codex`; the writer's revert semantic is unset-REMOVES-ours
 * (the claude-code contract). Wire-value selects stay English/mono (i18n
 * rules — they are codex's own enum spellings).
 */

export interface CxDraft {
  reasoningEffort: '' | (typeof CODEX_REASONING_EFFORTS)[number];
  reasoningSummary: '' | (typeof CODEX_REASONING_SUMMARIES)[number];
  verbosity: '' | (typeof CODEX_VERBOSITIES)[number];
  /** Numbers stay STRINGS while typing; parsed at the apply boundary. */
  contextWindow: string;
  autoCompactTokenLimit: string;
  updateCheckDisabled: boolean;
}

/** Registry chat-model shape the pickers consume (structural — #51 rows). */
interface ChatModelOption {
  id: string;
  displayName?: string;
}

export function emptyCxDraft(): CxDraft {
  return {
    reasoningEffort: '',
    reasoningSummary: '',
    verbosity: '',
    contextWindow: '',
    autoCompactTokenLimit: '',
    updateCheckDisabled: false,
  };
}

export function cxDraftFromSpec(spec: RuntimeConfigSpec | null): CxDraft {
  const cx = spec?.codex;
  if (cx === undefined) return emptyCxDraft();
  return {
    reasoningEffort: cx.reasoningEffort ?? '',
    reasoningSummary: cx.reasoningSummary ?? '',
    verbosity: cx.verbosity ?? '',
    contextWindow: cx.contextWindow?.toString() ?? '',
    autoCompactTokenLimit: cx.autoCompactTokenLimit?.toString() ?? '',
    updateCheckDisabled: cx.switches?.updateCheckDisabled === true,
  };
}

/** First blocking problem, or null — the apply button stays disabled while set. */
export function cxIssue(draft: CxDraft): TranslationKey | null {
  const ctx = draft.contextWindow.trim();
  if (ctx !== '') {
    const n = Number(ctx);
    if (!Number.isInteger(n) || n < 1 || n > 10_000_000) return 'machineDetail.cxNumBadContext';
  }
  const compact = draft.autoCompactTokenLimit.trim();
  if (compact !== '') {
    const n = Number(compact);
    if (!Number.isInteger(n) || n < 1 || n > 10_000_000) return 'machineDetail.cxNumBadCompact';
  }
  return null;
}

/**
 * Wire shape — an all-default draft serializes to `undefined` (untouched rows
 * keep their pre-#63 shape). Assumes `cxIssue(draft) === null`.
 */
export function serializeCxDraft(draft: CxDraft): CodexConfig | undefined {
  const ctx = draft.contextWindow.trim();
  const compact = draft.autoCompactTokenLimit.trim();
  const cfg: CodexConfig = {
    ...(draft.reasoningEffort !== '' ? { reasoningEffort: draft.reasoningEffort } : {}),
    ...(draft.reasoningSummary !== '' ? { reasoningSummary: draft.reasoningSummary } : {}),
    ...(draft.verbosity !== '' ? { verbosity: draft.verbosity } : {}),
    ...(ctx !== '' ? { contextWindow: Number(ctx) } : {}),
    ...(compact !== '' ? { autoCompactTokenLimit: Number(compact) } : {}),
    ...(draft.updateCheckDisabled ? { switches: { updateCheckDisabled: true as const } } : {}),
  };
  const empty =
    cfg.reasoningEffort === undefined &&
    cfg.reasoningSummary === undefined &&
    cfg.verbosity === undefined &&
    cfg.contextWindow === undefined &&
    cfg.autoCompactTokenLimit === undefined &&
    cfg.switches === undefined;
  return empty ? undefined : cfg;
}

export function CodexPanel({
  draft,
  onChange,
  defaultModel,
  onDefaultModelChange,
  extraModels,
  onExtraModelsChange,
  chatModels,
}: {
  draft: CxDraft;
  onChange: (next: CxDraft) => void;
  defaultModel: string;
  onDefaultModelChange: (next: string) => void;
  extraModels: string[];
  onExtraModelsChange: (next: string[]) => void;
  chatModels: readonly ChatModelOption[];
}) {
  const { t } = useI18n();
  const useModelSelect = chatModels.length > 0;
  const oneM = draft.contextWindow.trim() === '1000000';
  const issue = cxIssue(draft);

  return (
    <section className="flex flex-col gap-5 rounded-lg border p-4">
      <div>
        <p className="text-sm font-medium">{t('machineDetail.cxTitle')}</p>
        <p className="text-muted-foreground text-xs">{t('machineDetail.cxDesc')}</p>
      </div>

      {/* ---- models ---- */}
      <div className="flex flex-col gap-3">
        <LabelText as="p">{t('machineDetail.cxSectionModels')}</LabelText>
        <div className="flex max-w-2xl items-end gap-4">
          <div className="grid min-w-52 flex-1 gap-2">
            <Label htmlFor="cx-model">{t('machineDetail.modelDefaultLabel')}</Label>
            {useModelSelect ? (
              <Select value={defaultModel} onValueChange={onDefaultModelChange}>
                <SelectTrigger id="cx-model" className="w-full font-mono text-xs">
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
                id="cx-model"
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
          <p className="text-muted-foreground text-xs">{t('machineDetail.cxExtrasHint')}</p>
        </div>
      </div>

      {/* ---- reasoning dials ---- */}
      <div className="flex flex-col gap-3 border-t pt-4">
        <LabelText as="p">{t('machineDetail.cxSectionReasoning')}</LabelText>
        <p className="text-muted-foreground text-xs">{t('machineDetail.cxReasoningHint')}</p>
        <div className="grid max-w-2xl gap-3 sm:grid-cols-3">
          <div className="grid gap-2">
            <Label htmlFor="cx-effort">{t('machineDetail.cxEffortLabel')}</Label>
            <Select
              value={draft.reasoningEffort === '' ? '__default__' : draft.reasoningEffort}
              onValueChange={(v) => onChange({ ...draft, reasoningEffort: dial(v) })}
            >
              <SelectTrigger id="cx-effort" className="w-full font-mono text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">{t('machineDetail.cxDialDefault')}</SelectItem>
                {CODEX_REASONING_EFFORTS.map((v) => (
                  <SelectItem key={v} value={v} className="font-mono text-xs">
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">{t('machineDetail.cxEffortHint')}</p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="cx-summary">{t('machineDetail.cxSummaryLabel')}</Label>
            <Select
              value={draft.reasoningSummary === '' ? '__default__' : draft.reasoningSummary}
              onValueChange={(v) => onChange({ ...draft, reasoningSummary: summaryDial(v) })}
            >
              <SelectTrigger id="cx-summary" className="w-full font-mono text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">{t('machineDetail.cxDialDefault')}</SelectItem>
                {CODEX_REASONING_SUMMARIES.map((v) => (
                  <SelectItem key={v} value={v} className="font-mono text-xs">
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">{t('machineDetail.cxSummaryHint')}</p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="cx-verbosity">{t('machineDetail.cxVerbosityLabel')}</Label>
            <Select
              value={draft.verbosity === '' ? '__default__' : draft.verbosity}
              onValueChange={(v) => onChange({ ...draft, verbosity: verbosityDial(v) })}
            >
              <SelectTrigger id="cx-verbosity" className="w-full font-mono text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__default__">{t('machineDetail.cxDialDefault')}</SelectItem>
                {CODEX_VERBOSITIES.map((v) => (
                  <SelectItem key={v} value={v} className="font-mono text-xs">
                    {v}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">{t('machineDetail.cxVerbosityHint')}</p>
          </div>
        </div>
      </div>

      {/* ---- context ---- */}
      <div className="flex flex-col gap-3 border-t pt-4">
        <LabelText as="p">{t('machineDetail.cxSectionContext')}</LabelText>
        <label className="flex items-center gap-2 py-1 text-sm [@media(pointer:coarse)]:py-2.5">
          <Checkbox
            checked={oneM}
            onCheckedChange={(v) =>
              onChange(
                v === true
                  ? {
                      ...draft,
                      contextWindow: '1000000',
                      autoCompactTokenLimit:
                        draft.autoCompactTokenLimit.trim() === ''
                          ? '900000'
                          : draft.autoCompactTokenLimit,
                    }
                  : { ...draft, contextWindow: '', autoCompactTokenLimit: '' },
              )
            }
          />
          {t('machineDetail.cxOneM')}
        </label>
        <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
          <div className="grid gap-1">
            <Label htmlFor="cx-ctx">{t('machineDetail.cxContextLabel')}</Label>
            <Input
              id="cx-ctx"
              type="number"
              value={draft.contextWindow}
              onChange={(e) => onChange({ ...draft, contextWindow: e.target.value })}
              min={1}
              step={1}
              className="font-mono text-xs"
              autoComplete="off"
            />
            <p className="text-muted-foreground text-xs">{t('machineDetail.cxContextHint')}</p>
          </div>
          <div className="grid gap-1">
            <Label htmlFor="cx-compact">{t('machineDetail.cxCompactLabel')}</Label>
            <Input
              id="cx-compact"
              type="number"
              value={draft.autoCompactTokenLimit}
              onChange={(e) => onChange({ ...draft, autoCompactTokenLimit: e.target.value })}
              min={1}
              step={1}
              className="font-mono text-xs"
              autoComplete="off"
            />
            <p className="text-muted-foreground text-xs">{t('machineDetail.cxCompactHint')}</p>
          </div>
        </div>
        {/* The validation gate renders inline (the cc-panel pattern): a bad
          number explains itself instead of only disabling Apply. */}
        {issue !== null ? <p className="text-danger text-xs">{t(issue)}</p> : null}
      </div>

      {/* ---- behavior ---- */}
      <div className="flex flex-col gap-3 border-t pt-4">
        <LabelText as="p">{t('machineDetail.cxSectionBehavior')}</LabelText>
        <label className="flex items-center gap-2 py-1 text-sm [@media(pointer:coarse)]:py-2.5">
          <Checkbox
            checked={draft.updateCheckDisabled}
            onCheckedChange={(v) => onChange({ ...draft, updateCheckDisabled: v === true })}
          />
          {t('machineDetail.cxUpdateCheck')}
        </label>
        <p className="text-muted-foreground text-xs">{t('machineDetail.cxUpdateCheckHint')}</p>
      </div>
    </section>
  );
}

/** Radix forbids empty SelectItem values — the sentinel maps back to unset. */
function dial(v: string): '' | (typeof CODEX_REASONING_EFFORTS)[number] {
  return v === '__default__' ? '' : (v as (typeof CODEX_REASONING_EFFORTS)[number]);
}

function summaryDial(v: string): '' | (typeof CODEX_REASONING_SUMMARIES)[number] {
  return v === '__default__' ? '' : (v as (typeof CODEX_REASONING_SUMMARIES)[number]);
}

function verbosityDial(v: string): '' | (typeof CODEX_VERBOSITIES)[number] {
  return v === '__default__' ? '' : (v as (typeof CODEX_VERBOSITIES)[number]);
}
