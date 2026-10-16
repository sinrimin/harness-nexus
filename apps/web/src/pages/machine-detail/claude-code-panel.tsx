import { useId } from 'react';
import { Wand2Icon } from 'lucide-react';
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
import { TagCombobox } from '@/components/kit';
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
 * the connection (provider/credential) and the model list carry in; the knobs
 * here are claude-code's own vocabulary (tier pins, `[1m]` markers, token
 * caps, extra body, auth slot), stored on `spec.claudeCode` and written by
 * the daemon into the settings.json env block with revert semantics — an
 * unset knob REMOVES the managed key, everything else in the file stays
 * untouched (deliberately NOT cc-switch's common-config overlay).
 *
 * The `[1m]` marker lives inside the model strings end to end (cc-switch's
 * representation): the row checkboxes are derived state over
 * strip/set helpers, never a parallel boolean.
 */

export interface CcTierDraft {
  model: string;
  displayName: string;
  capabilities: string[];
}

export interface CcDraft {
  /** Rides `spec.model` (not `claudeCode`) — the marker is a model-id concept. */
  oneM: boolean;
  authField: 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY';
  tiers: Record<ClaudeCodeTier, CcTierDraft>;
  subagent: string;
  maxOutputTokens: string;
  maxContextTokens: string;
  extraBody: string;
}

/** The docs only give `effort,thinking` as an example — suggestions, not a closed set. */
const CAPABILITY_SUGGESTIONS = ['effort', 'thinking'] as const;

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
    ...(tiers.length > 0 ? { tiers } : {}),
    ...(draft.subagent.trim() !== '' ? { subagentModel: draft.subagent.trim() } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(maxContextTokens !== undefined ? { maxContextTokens } : {}),
    ...(extraBody !== undefined ? { extraBody } : {}),
  };
  const empty =
    cfg.authField === undefined &&
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
  suggestions,
}: {
  draft: CcDraft;
  onChange: (next: CcDraft) => void;
  /** The form's clean default-model id (marker handled by the oneM checkbox). */
  defaultModel: string;
  /** Registry chat-model ids — free-text rows get them as datalist suggestions. */
  suggestions: readonly string[];
}) {
  const { t } = useI18n();
  const datalistId = useId();
  const issue = ccIssue(draft);
  const anyMarker =
    draft.oneM ||
    hasClaudeOneMarker(draft.subagent) ||
    CLAUDE_CODE_TIERS.some((tier) => hasClaudeOneMarker(tierRow(draft, tier).model));
  const contextConflict = draft.maxContextTokens.trim() !== '' && anyMarker;

  const setTier = (tier: ClaudeCodeTier, patch: Partial<CcTierDraft>): void => {
    onChange({
      ...draft,
      tiers: { ...draft.tiers, [tier]: { ...tierRow(draft, tier), ...patch } },
    });
  };

  return (
    <section className="flex flex-col gap-4 rounded-lg border p-4">
      <div>
        <p className="text-sm font-medium">{t('machineDetail.ccTitle')}</p>
        <p className="text-muted-foreground text-xs">{t('machineDetail.ccDesc')}</p>
      </div>

      <datalist id={datalistId}>
        {suggestions.map((id) => (
          <option key={id} value={id} />
        ))}
      </datalist>

      <div className="flex max-w-3xl items-center gap-6">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draft.oneM}
            onCheckedChange={(v) => onChange({ ...draft, oneM: v === true })}
          />
          {t('machineDetail.ccMainOneM')}
        </label>
        <p className="text-muted-foreground text-xs">{t('machineDetail.ccMainOneMHint')}</p>
      </div>

      <div className="grid max-w-72 gap-2">
        <Label htmlFor="cc-auth">{t('machineDetail.ccAuthFieldLabel')}</Label>
        <Select
          value={draft.authField}
          onValueChange={(v) => onChange({ ...draft, authField: v as CcDraft['authField'] })}
        >
          <SelectTrigger id="cc-auth" className="font-mono text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ANTHROPIC_AUTH_TOKEN">{t('machineDetail.ccAuthBearer')}</SelectItem>
            <SelectItem value="ANTHROPIC_API_KEY">{t('machineDetail.ccAuthXApiKey')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium">{t('machineDetail.ccTiersTitle')}</p>
            <p className="text-muted-foreground text-xs">{t('machineDetail.ccTiersHint')}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
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

        <div className="hidden gap-2 px-1 text-xs font-medium text-muted-foreground md:grid md:grid-cols-[72px_minmax(0,1fr)_minmax(0,9rem)_minmax(0,13rem)_44px]">
          <span>{t('machineDetail.ccTierHeader')}</span>
          <span>{t('machineDetail.ccTierModelLabel')}</span>
          <span>{t('machineDetail.ccTierNameLabel')}</span>
          <span>{t('machineDetail.ccTierCapsLabel')}</span>
          <span>1M</span>
        </div>

        {CLAUDE_CODE_TIERS.map((tier) => {
          const row = tierRow(draft, tier);
          const oneM = hasClaudeOneMarker(row.model);
          return (
            <div
              key={tier}
              className="grid gap-2 md:grid-cols-[72px_minmax(0,1fr)_minmax(0,9rem)_minmax(0,13rem)_44px]"
            >
              <div className="flex h-9 items-center rounded-md border bg-muted/40 px-3 font-mono text-xs text-muted-foreground">
                {tier}
              </div>
              <Input
                aria-label={`${tier} ${t('machineDetail.ccTierModelLabel')}`}
                value={stripClaudeOneMarker(row.model)}
                list={datalistId}
                onChange={(e) => setTier(tier, { model: setClaudeOneMarker(e.target.value, oneM) })}
                placeholder={t('machineDetail.ccTierModelPh')}
                className="h-9 font-mono text-xs"
                autoComplete="off"
                spellCheck={false}
              />
              <Input
                aria-label={`${tier} ${t('machineDetail.ccTierNameLabel')}`}
                value={row.displayName}
                onChange={(e) => setTier(tier, { displayName: e.target.value })}
                placeholder={t('machineDetail.ccTierNamePh')}
                className="h-9 text-xs"
                autoComplete="off"
              />
              <TagCombobox
                value={row.capabilities}
                options={CAPABILITY_SUGGESTIONS}
                onChange={(capabilities) => setTier(tier, { capabilities })}
                placeholder={t('machineDetail.ccTierCapsPh')}
                addLabel={(value) => t('llmProviders.tagComboboxAdd', { value })}
                removeLabel={(value) => t('llmProviders.tagComboboxRemove', { value })}
                className="h-9 text-xs"
              />
              <label className="flex h-9 items-center justify-center">
                <Checkbox
                  checked={oneM}
                  onCheckedChange={(v) =>
                    setTier(tier, { model: setClaudeOneMarker(row.model, v === true) })
                  }
                  aria-label={`1M ${tier}`}
                />
              </label>
            </div>
          );
        })}
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
            className="h-9 font-mono text-xs"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <label className="flex h-9 items-center gap-2 pt-6 text-sm">
          <Checkbox
            checked={hasClaudeOneMarker(draft.subagent)}
            onCheckedChange={(v) =>
              onChange({ ...draft, subagent: setClaudeOneMarker(draft.subagent, v === true) })
            }
          />
          1M
        </label>
      </div>

      <div className="flex flex-wrap gap-4">
        <div className="grid w-44 gap-2">
          <Label htmlFor="cc-max-out">{t('machineDetail.ccMaxOutputLabel')}</Label>
          <Input
            id="cc-max-out"
            type="number"
            value={draft.maxOutputTokens}
            onChange={(e) => onChange({ ...draft, maxOutputTokens: e.target.value })}
            min={1}
            max={128000}
            step={1}
            className="h-9 font-mono text-xs"
            autoComplete="off"
          />
        </div>
        <div className="grid flex-1 gap-2 md:max-w-72">
          <Label htmlFor="cc-max-ctx">{t('machineDetail.ccMaxContextLabel')}</Label>
          <Input
            id="cc-max-ctx"
            type="number"
            value={draft.maxContextTokens}
            onChange={(e) => onChange({ ...draft, maxContextTokens: e.target.value })}
            min={1}
            step={1}
            className="h-9 font-mono text-xs"
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
        <textarea
          id="cc-extra-body"
          value={draft.extraBody}
          onChange={(e) => onChange({ ...draft, extraBody: e.target.value })}
          placeholder={t('machineDetail.ccExtraBodyPh')}
          rows={3}
          className="border-input bg-transparent font-mono text-xs shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 w-full rounded-md border px-3 py-2 field-sizing-content"
          autoComplete="off"
          spellCheck={false}
        />
        {issue !== null ? <p className="text-danger text-xs">{t(issue)}</p> : null}
      </div>
    </section>
  );
}
