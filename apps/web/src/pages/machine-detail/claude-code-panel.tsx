// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useId, type ReactNode } from 'react';
import { PlusIcon, Wand2Icon, XIcon } from 'lucide-react';
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
import { Textarea } from '@/components/ui/textarea';
import { LabelText, TagCombobox } from '@/components/kit';
import {
  CLAUDE_CODE_TIERS,
  hasClaudeOneMarker,
  setClaudeOneMarker,
  stripClaudeOneMarker,
  type ClaudeCodeConfig,
  type ClaudeCodeTier,
  type RuntimeConfigSpec,
} from '@harness-nexus/sdk';

/**
 * #60 — the claude-code dedicated panel. From the provider-config flow only
 * the CONNECTION (provider/credential) carries in; everything model-shaped or
 * behavior-shaped is claude-code's own vocabulary, collected here so there is
 * exactly one configuration surface per knob (no duplicate model fields
 * beside the provider row):
 *
 *  - models: default model (+ the `[1m]` marker checkbox), the switchable
 *    allowlist rows, the subagent model, alias-tier pins
 *    (`ANTHROPIC_DEFAULT_{TIER}_MODEL` + `_NAME`/`_SUPPORTED_CAPABILITIES`)
 *  - behavior: six managed switches (attribution/teammates/tool-search/
 *    max-effort/auto-update/artifact) + the #49 default permission mode slot
 *  - request: auth slot, token caps, extra body
 *
 * Stored on `spec.claudeCode` (plus the `[1m]` marker on `spec.model`) and
 * written by the daemon into settings.json with revert semantics — an unset
 * knob REMOVES the managed key, everything else in the file stays untouched
 * (deliberately NOT cc-switch's common-config overlay).
 *
 * The `[1m]` marker lives inside the model strings end to end (cc-switch's
 * representation): row checkboxes are derived state over strip/set helpers,
 * never a parallel boolean.
 */

export interface CcTierDraft {
  model: string;
  displayName: string;
  capabilities: string[];
}

export interface CcSwitchDraft {
  attributionHidden: boolean;
  teammates: boolean;
  toolSearch: boolean;
  maxEffort: boolean;
  autoUpgradeDisabled: boolean;
  artifactsDisabled: boolean;
}

export interface CcDraft {
  /** Rides `spec.model` (not `claudeCode`) — the marker is a model-id concept. */
  oneM: boolean;
  authField: 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY';
  tiers: Record<ClaudeCodeTier, CcTierDraft>;
  switches: CcSwitchDraft;
  subagent: string;
  maxOutputTokens: string;
  maxContextTokens: string;
  extraBody: string;
}

/** The docs only give `effort,thinking` as an example — suggestions, not a closed set. */
const CAPABILITY_SUGGESTIONS = ['effort', 'thinking'] as const;

/** Registry chat-model shape the pickers consume (structural — #51 rows). */
interface ChatModelOption {
  id: string;
  displayName?: string;
}

/** Behavior switches in display order — full translation keys, resolved at render. */
const BEHAVIOR_SWITCHES: ReadonlyArray<{ key: keyof CcSwitchDraft; label: TranslationKey }> = [
  { key: 'attributionHidden', label: 'machineDetail.ccSwAttribution' },
  { key: 'teammates', label: 'machineDetail.ccSwTeammates' },
  { key: 'toolSearch', label: 'machineDetail.ccSwToolSearch' },
  { key: 'maxEffort', label: 'machineDetail.ccSwMaxEffort' },
  { key: 'autoUpgradeDisabled', label: 'machineDetail.ccSwAutoUpgrade' },
  { key: 'artifactsDisabled', label: 'machineDetail.ccSwArtifacts' },
];

/** CLAUDE_CODE_TIERS is exactly the record's key set — the one assertion point. */
const tierRow = (draft: CcDraft, tier: ClaudeCodeTier): CcTierDraft => draft.tiers[tier]!;

export function emptyCcDraft(): CcDraft {
  return {
    oneM: false,
    authField: 'ANTHROPIC_AUTH_TOKEN',
    tiers: {
      sonnet: { model: '', displayName: '', capabilities: [] },
      opus: { model: '', displayName: '', capabilities: [] },
      fable: { model: '', displayName: '', capabilities: [] },
      haiku: { model: '', displayName: '', capabilities: [] },
    },
    switches: {
      attributionHidden: false,
      teammates: false,
      toolSearch: false,
      maxEffort: false,
      autoUpgradeDisabled: false,
      artifactsDisabled: false,
    },
    subagent: '',
    maxOutputTokens: '',
    maxContextTokens: '',
    extraBody: '',
  };
}

export function ccDraftFromSpec(spec: RuntimeConfigSpec | null): CcDraft {
  const draft = emptyCcDraft();
  if (spec === null) return draft;
  const cc = spec.claudeCode;
  draft.oneM = hasClaudeOneMarker(spec.model);
  if (cc === undefined) return draft;
  draft.authField = cc.authField ?? 'ANTHROPIC_AUTH_TOKEN';
  for (const row of cc.tiers ?? []) {
    draft.tiers[row.tier] = {
      model: row.model,
      displayName: row.displayName ?? '',
      capabilities: [...(row.capabilities ?? [])],
    };
  }
  draft.switches = {
    attributionHidden: cc.switches?.attributionHidden === true,
    teammates: cc.switches?.teammates === true,
    toolSearch: cc.switches?.toolSearch === true,
    maxEffort: cc.switches?.maxEffort === true,
    autoUpgradeDisabled: cc.switches?.autoUpgradeDisabled === true,
    artifactsDisabled: cc.switches?.artifactsDisabled === true,
  };
  draft.subagent = cc.subagentModel ?? '';
  draft.maxOutputTokens = cc.maxOutputTokens?.toString() ?? '';
  draft.maxContextTokens = cc.maxContextTokens?.toString() ?? '';
  draft.extraBody = cc.extraBody !== undefined ? JSON.stringify(cc.extraBody) : '';
  return draft;
}

/** First blocking problem, or null — the apply button stays disabled while set. */
export function ccIssue(draft: CcDraft): TranslationKey | null {
  const out = draft.maxOutputTokens.trim();
  if (out !== '') {
    const n = Number(out);
    if (!Number.isInteger(n) || n < 1 || n > 128000) return 'machineDetail.ccNumBadOutput';
  }
  const ctx = draft.maxContextTokens.trim();
  if (ctx !== '') {
    const n = Number(ctx);
    if (!Number.isInteger(n) || n < 1) return 'machineDetail.ccNumBadContext';
  }
  const extra = draft.extraBody.trim();
  if (extra !== '') {
    try {
      const parsed: unknown = JSON.parse(extra);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return 'machineDetail.ccExtraBodyBad';
      }
    } catch {
      return 'machineDetail.ccExtraBodyBad';
    }
  }
  return null;
}

/**
 * Wire shape. An all-default draft serializes to `undefined` — the spec then
 * keeps its pre-#60 form (and a knob-less re-apply reverts the daemon's env
 * keys). Assumes `ccIssue(draft) === null`.
 */
export function serializeCcDraft(draft: CcDraft): ClaudeCodeConfig | undefined {
  const tiers = CLAUDE_CODE_TIERS.filter((tier) => tierRow(draft, tier).model.trim() !== '').map(
    (tier) => {
      const row = tierRow(draft, tier);
      return {
        tier,
        model: row.model.trim(),
        ...(row.displayName.trim() !== '' ? { displayName: row.displayName.trim() } : {}),
        ...(row.capabilities.length > 0 ? { capabilities: [...row.capabilities] } : {}),
      };
    },
  );
  const sw = draft.switches;
  const switches =
    sw.attributionHidden ||
    sw.teammates ||
    sw.toolSearch ||
    sw.maxEffort ||
    sw.autoUpgradeDisabled ||
    sw.artifactsDisabled
      ? {
          ...(sw.attributionHidden ? { attributionHidden: true } : {}),
          ...(sw.teammates ? { teammates: true } : {}),
          ...(sw.toolSearch ? { toolSearch: true } : {}),
          ...(sw.maxEffort ? { maxEffort: true } : {}),
          ...(sw.autoUpgradeDisabled ? { autoUpgradeDisabled: true } : {}),
          ...(sw.artifactsDisabled ? { artifactsDisabled: true } : {}),
        }
      : undefined;
  const num = (text: string): number | undefined => {
    if (text.trim() === '') return undefined;
    const n = Number(text);
    return Number.isFinite(n) ? Math.round(n) : undefined;
  };
  let extraBody: Record<string, unknown> | undefined;
  if (draft.extraBody.trim() !== '') {
    try {
      extraBody = JSON.parse(draft.extraBody) as Record<string, unknown>;
    } catch {
      extraBody = undefined; // unreachable behind ccIssue; degrade, never throw
    }
  }
  const maxOutputTokens = num(draft.maxOutputTokens);
  const maxContextTokens = num(draft.maxContextTokens);
  const cfg: ClaudeCodeConfig = {
    ...(draft.authField !== 'ANTHROPIC_AUTH_TOKEN' ? { authField: draft.authField } : {}),
    ...(switches !== undefined ? { switches } : {}),
    ...(tiers.length > 0 ? { tiers } : {}),
    ...(draft.subagent.trim() !== '' ? { subagentModel: draft.subagent.trim() } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
    ...(extraBody !== undefined ? { extraBody } : {}),
  };
  const empty =
    cfg.authField === undefined &&
    cfg.switches === undefined &&
    cfg.tiers === undefined &&
    cfg.subagentModel === undefined &&
    cfg.maxOutputTokens === undefined &&
    cfg.maxContextTokens === undefined &&
    cfg.extraBody === undefined;
  return empty ? undefined : cfg;
}

export function ClaudeCodePanel({
  draft,
  onChange,
  defaultModel,
  onDefaultModelChange,
  extraModels,
  onExtraModelsChange,
  chatModels,
  behaviorSlot,
}: {
  draft: CcDraft;
  onChange: (next: CcDraft) => void;
  /** The form's clean default-model id (marker handled by the oneM checkbox). */
  defaultModel: string;
  onDefaultModelChange: (next: string) => void;
  /** Switchable allowlist rows — same draft the generic form used, owned here now. */
  extraModels: string[];
  onExtraModelsChange: (next: string[]) => void;
  /** Registry chat models of the picked provider; empty = free-text inputs. */
  chatModels: readonly ChatModelOption[];
  /** The #49 default permission mode row (machine-scoped save, rendered in place). */
  behaviorSlot?: ReactNode;
}) {
  const { t } = useI18n();
  const datalistId = useId();
  const issue = ccIssue(draft);
  const anyMarker =
    draft.oneM ||
    hasClaudeOneMarker(draft.subagent) ||
    CLAUDE_CODE_TIERS.some((tier) => hasClaudeOneMarker(tierRow(draft, tier).model));
  const contextConflict = draft.maxContextTokens.trim() !== '' && anyMarker;
  const useModelSelect = chatModels.length > 0;

  const setTier = (tier: ClaudeCodeTier, patch: Partial<CcTierDraft>): void => {
    onChange({
      ...draft,
      tiers: { ...draft.tiers, [tier]: { ...tierRow(draft, tier), ...patch } },
    });
  };
  const setSwitch = (key: keyof CcSwitchDraft, value: boolean): void => {
    onChange({ ...draft, switches: { ...draft.switches, [key]: value } });
  };

  return (
    <section className="flex flex-col gap-5 rounded-lg border p-4">
      <div>
        <p className="text-sm font-medium">{t('machineDetail.ccTitle')}</p>
        <p className="text-muted-foreground text-xs">{t('machineDetail.ccDesc')}</p>
      </div>

      <datalist id={datalistId}>
        {chatModels.map((m) => (
          <option key={m.id} value={m.id} />
        ))}
      </datalist>

      {/* ---- models ---- */}
      <div className="flex flex-col gap-3">
        <LabelText as="p">{t('machineDetail.ccSectionModels')}</LabelText>
        <div className="flex max-w-2xl items-end gap-4">
          <div className="grid min-w-52 flex-1 gap-2">
            <Label htmlFor="cc-model">{t('machineDetail.modelDefaultLabel')}</Label>
            {useModelSelect ? (
              <Select value={defaultModel} onValueChange={onDefaultModelChange}>
                <SelectTrigger id="cc-model" className="w-full font-mono text-xs">
                  <SelectValue placeholder={t('machineDetail.pickModel')} />
                </SelectTrigger>
                <SelectContent>
                  {/* A stored id that predates the registry stays visible and
                      submittable — same honesty rule as the generic form. */}
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
                id="cc-model"
                value={defaultModel}
                onChange={(e) => onDefaultModelChange(e.target.value)}
                className="font-mono text-xs"
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </div>
          <label className="flex h-(--control-h) items-center gap-2 pb-0.5 text-sm">
            <Checkbox
              checked={draft.oneM}
              disabled={stripClaudeOneMarker(defaultModel).trim() === ''}
              onCheckedChange={(v) => onChange({ ...draft, oneM: v === true })}
            />
            {t('machineDetail.ccOneM')}
          </label>
        </div>
        <p className="text-muted-foreground max-w-2xl text-xs">
          {t('machineDetail.ccMainOneMHint')}
        </p>

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
                .map((x) => stripClaudeOneMarker(x.trim()))
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
                    className="font-mono text-xs"
                    autoComplete="off"
                    spellCheck={false}
                  />
                )}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground h-(--control-h) shrink-0 px-2 text-xs hover:text-foreground"
                  disabled={
                    m.trim() === '' || m.trim() === stripClaudeOneMarker(defaultModel).trim()
                  }
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

        <div className="flex max-w-2xl items-center gap-2">
          <div className="grid flex-1 gap-2">
            <Label htmlFor="cc-subagent">{t('machineDetail.ccSubagentLabel')}</Label>
            <Input
              id="cc-subagent"
              value={stripClaudeOneMarker(draft.subagent)}
              list={datalistId}
              onChange={(e) =>
                onChange({
                  ...draft,
                  subagent: setClaudeOneMarker(e.target.value, hasClaudeOneMarker(draft.subagent)),
                })
              }
              placeholder={t('machineDetail.ccTierModelPh')}
              className="font-mono text-xs"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <label className="flex h-(--control-h) items-center gap-2 pt-6 text-sm">
            <Checkbox
              checked={hasClaudeOneMarker(draft.subagent)}
              disabled={stripClaudeOneMarker(draft.subagent).trim() === ''}
              onCheckedChange={(v) =>
                onChange({ ...draft, subagent: setClaudeOneMarker(draft.subagent, v === true) })
              }
            />
            {t('machineDetail.ccOneM')}
          </label>
        </div>
      </div>

      {/* ---- alias tiers ---- */}
      <div className="flex flex-col gap-2 border-t pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <LabelText as="p">{t('machineDetail.ccTiersTitle')}</LabelText>
            <p className="text-muted-foreground text-xs">{t('machineDetail.ccTiersHint')}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1 px-2 text-xs [@media(pointer:coarse)]:h-9"
            disabled={stripClaudeOneMarker(defaultModel).trim() === ''}
            onClick={() => {
              const base = stripClaudeOneMarker(defaultModel).trim();
              onChange({
                ...draft,
                tiers: Object.fromEntries(
                  CLAUDE_CODE_TIERS.map((tier) => [
                    tier,
                    {
                      ...tierRow(draft, tier),
                      model: setClaudeOneMarker(
                        base,
                        hasClaudeOneMarker(tierRow(draft, tier).model),
                      ),
                    },
                  ]),
                ) as CcDraft['tiers'],
              });
            }}
          >
            <Wand2Icon className="size-3.5" />
            {t('machineDetail.ccApplyAll')}
          </Button>
        </div>

        <div className="text-muted-foreground hidden gap-2 text-xs font-medium md:grid md:grid-cols-[72px_minmax(0,1fr)_minmax(0,9rem)_minmax(0,13rem)_44px]">
          <span>{t('machineDetail.ccTierHeader')}</span>
          <span>{t('machineDetail.ccTierModelLabel')}</span>
          <span>{t('machineDetail.ccTierNameLabel')}</span>
          <span>{t('machineDetail.ccTierCapsLabel')}</span>
          <span>{t('machineDetail.ccOneM')}</span>
        </div>

        {CLAUDE_CODE_TIERS.map((tier) => {
          const row = tierRow(draft, tier);
          const oneM = hasClaudeOneMarker(row.model);
          const oneMDisabled = stripClaudeOneMarker(row.model).trim() === '';
          const toggleOneM = (v: boolean): void =>
            setTier(tier, { model: setClaudeOneMarker(row.model, v) });
          return (
            <div
              key={tier}
              className="flex flex-col gap-2 rounded-md border bg-muted/20 p-3 md:grid md:grid-cols-[72px_minmax(0,1fr)_minmax(0,9rem)_minmax(0,13rem)_44px] md:items-start md:gap-2 md:rounded-none md:border-0 md:bg-transparent md:p-0"
            >
              {/* tier id — the mobile group header carries the 1M toggle;
                  desktop keeps the bare chip cell */}
              <div className="flex items-center justify-between gap-2 md:block">
                <div className="text-muted-foreground flex h-(--control-h) items-center rounded-md border bg-muted/40 px-3 font-mono text-xs">
                  {tier}
                </div>
                <label className="flex items-center gap-2 text-sm md:hidden">
                  <Checkbox
                    checked={oneM}
                    disabled={oneMDisabled}
                    onCheckedChange={(v) => toggleOneM(v === true)}
                  />
                  {t('machineDetail.ccOneM')}
                </label>
              </div>
              <div className="grid gap-1 md:contents">
                <span className="text-muted-foreground text-xs md:hidden">
                  {t('machineDetail.ccTierModelLabel')}
                </span>
                <Input
                  aria-label={`${tier} ${t('machineDetail.ccTierModelLabel')}`}
                  value={stripClaudeOneMarker(row.model)}
                  list={datalistId}
                  onChange={(e) =>
                    setTier(tier, { model: setClaudeOneMarker(e.target.value, oneM) })
                  }
                  placeholder={t('machineDetail.ccTierModelPh')}
                  className="font-mono text-xs"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="grid gap-1 md:contents">
                <span className="text-muted-foreground text-xs md:hidden">
                  {t('machineDetail.ccTierNameLabel')}
                </span>
                <Input
                  aria-label={`${tier} ${t('machineDetail.ccTierNameLabel')}`}
                  value={row.displayName}
                  onChange={(e) => setTier(tier, { displayName: e.target.value })}
                  placeholder={t('machineDetail.ccTierNamePh')}
                  className="text-xs"
                  autoComplete="off"
                />
              </div>
              <div className="grid gap-1 md:contents">
                <span className="text-muted-foreground text-xs md:hidden">
                  {t('machineDetail.ccTierCapsLabel')}
                </span>
                <TagCombobox
                  value={row.capabilities}
                  options={CAPABILITY_SUGGESTIONS}
                  onChange={(capabilities) => setTier(tier, { capabilities })}
                  placeholder={t('machineDetail.ccTierCapsPh')}
                  addLabel={(value) => t('llmProviders.tagComboboxAdd', { value })}
                  removeLabel={(value) => t('llmProviders.tagComboboxRemove', { value })}
                  ariaLabel={`${tier} ${t('machineDetail.ccTierCapsLabel')}`}
                  className="min-h-(--control-h) text-xs"
                />
              </div>
              <label className="hidden h-(--control-h) items-center justify-center md:flex">
                <Checkbox
                  checked={oneM}
                  disabled={oneMDisabled}
                  onCheckedChange={(v) => toggleOneM(v === true)}
                  aria-label={`1M ${tier}`}
                />
              </label>
            </div>
          );
        })}
      </div>

      {/* ---- behavior ---- */}
      <div className="flex flex-col gap-3 border-t pt-4">
        <LabelText as="p">{t('machineDetail.ccSectionBehavior')}</LabelText>
        <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
          {BEHAVIOR_SWITCHES.map(({ key, label }) => (
            <label
              key={key}
              className="flex items-center gap-2 py-1 text-sm [@media(pointer:coarse)]:py-2.5"
            >
              <Checkbox
                checked={draft.switches[key]}
                onCheckedChange={(v) => setSwitch(key, v === true)}
              />
              {t(label)}
            </label>
          ))}
        </div>
        {behaviorSlot}
      </div>

      {/* ---- request ---- */}
      <div className="flex flex-col gap-3 border-t pt-4">
        <LabelText as="p">{t('machineDetail.ccSectionRequest')}</LabelText>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="grid content-start gap-2">
            <Label htmlFor="cc-auth">{t('machineDetail.ccAuthFieldLabel')}</Label>
            <Select
              value={draft.authField}
              onValueChange={(v) => onChange({ ...draft, authField: v as CcDraft['authField'] })}
            >
              <SelectTrigger id="cc-auth" className="w-full font-mono text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ANTHROPIC_AUTH_TOKEN">
                  {t('machineDetail.ccAuthBearer')}
                </SelectItem>
                <SelectItem value="ANTHROPIC_API_KEY">
                  {t('machineDetail.ccAuthXApiKey')}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid content-start gap-2">
            <Label htmlFor="cc-max-out">{t('machineDetail.ccMaxOutputLabel')}</Label>
            <Input
              id="cc-max-out"
              type="number"
              value={draft.maxOutputTokens}
              onChange={(e) => onChange({ ...draft, maxOutputTokens: e.target.value })}
              min={1}
              max={128000}
              step={1}
              className="font-mono text-xs"
              autoComplete="off"
            />
          </div>
          <div className="grid content-start gap-2">
            <Label htmlFor="cc-max-ctx">{t('machineDetail.ccMaxContextLabel')}</Label>
            <Input
              id="cc-max-ctx"
              type="number"
              value={draft.maxContextTokens}
              onChange={(e) => onChange({ ...draft, maxContextTokens: e.target.value })}
              min={1}
              step={1}
              className="font-mono text-xs"
              autoComplete="off"
            />
            {contextConflict ? (
              <p className="text-warn text-xs">{t('machineDetail.ccMaxContextConflict')}</p>
            ) : (
              <p className="text-muted-foreground text-xs">{t('machineDetail.ccMaxContextHint')}</p>
            )}
          </div>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="cc-extra-body">{t('machineDetail.ccExtraBodyLabel')}</Label>
          <Textarea
            id="cc-extra-body"
            value={draft.extraBody}
            onChange={(e) => onChange({ ...draft, extraBody: e.target.value })}
            placeholder={t('machineDetail.ccExtraBodyPh')}
            rows={3}
            className="min-h-20 font-mono text-xs"
            autoComplete="off"
            spellCheck={false}
          />
          {issue !== null ? <p className="text-danger text-xs">{t(issue)}</p> : null}
        </div>
      </div>
    </section>
  );
}
