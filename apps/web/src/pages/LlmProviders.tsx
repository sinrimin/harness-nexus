import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  ChevronDownIcon,
  GlobeIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlugZapIcon,
  PlusIcon,
  RefreshCwIcon,
  TrashIcon,
  UserIcon,
  XIcon,
} from 'lucide-react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n } from '@/i18n';
import {
  ConfirmDialog,
  DataTable,
  DataText,
  FilterBar,
  FilterSelect,
  Note,
  PageIntro,
  SortSelect,
  TableSearch,
  Well,
  tableState,
} from '@/components/kit';
import {
  effectiveSort,
  matchesQuery,
  sortRows,
  useListQuery,
  type ListQuerySpec,
} from '@/lib/list-query';
import { PageSlot } from '@/components/shell/page-slots';
import { PageAction } from '@/components/shell/page-action';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { FormDialog } from '@/components/ui/form-dialog';
import {
  HarnessNexusError,
  providerModelConfigWarnings,
  type CredentialView,
  type LlmProviderView,
  type ProviderApiKind,
  type ProviderModelConfig,
  type ProviderModelConfigInput,
} from '@harness-nexus/sdk';

type Scope = 'global' | 'personal';

const API_KINDS: ProviderApiKind[] = ['openai-chat', 'openai-responses', 'anthropic'];

/** The list's vocabulary (07-p3-list-pages.md §5). */
const PROVIDER_SPEC: ListQuerySpec = {
  filters: { api: API_KINDS, scope: ['personal', 'global'] },
  sort: ['name', '-updated'],
};

/**
 * #51 — one editable registry row. Numeric and JSON fields stay STRINGS while
 * typing (clearing "0.7" mid-edit must not collapse to a number); they are
 * parsed into the wire shape only at the save boundary (`cleanRow`).
 */
interface ModelRow {
  id: string;
  displayName: string;
  type: 'chat' | 'embedding';
  contextWindow: string;
  maxOutputTokens: string;
  vision: boolean;
  temperature: string;
  topP: string;
  serverTools: string;
  extraBody: string;
}

/** The wire shape after parsing — `type` always explicit, unset keys omitted. */
type CleanModel = ProviderModelConfigInput & { type: 'chat' | 'embedding' };

const EMPTY_MODEL_ROW: ModelRow = {
  id: '',
  displayName: '',
  type: 'chat',
  contextWindow: '',
  maxOutputTokens: '',
  vision: false,
  temperature: '',
  topP: '',
  serverTools: '',
  extraBody: '',
};

function rowFromModel(m: ProviderModelConfig): ModelRow {
  return {
    id: m.id,
    displayName: m.displayName ?? '',
    type: m.type,
    contextWindow: m.contextWindow !== undefined ? String(m.contextWindow) : '',
    maxOutputTokens: m.maxOutputTokens !== undefined ? String(m.maxOutputTokens) : '',
    vision: m.vision === true,
    temperature: m.temperature !== undefined ? String(m.temperature) : '',
    topP: m.topP !== undefined ? String(m.topP) : '',
    serverTools: (m.serverTools ?? []).join(', '),
    extraBody: m.extraBody !== undefined ? JSON.stringify(m.extraBody, null, 2) : '',
  };
}

/** Trimmed string → number, or undefined when empty / non-numeric. */
function optionalNumber(v: string): number | undefined {
  const t = v.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/** Object-shaped JSON only — a bare string/number/array is not a request body. */
function parseExtraBody(text: string): {
  value: Record<string, unknown> | undefined;
  invalid: boolean;
} {
  const t = text.trim();
  if (t === '') return { value: undefined, invalid: false };
  try {
    const parsed: unknown = JSON.parse(t);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { value: undefined, invalid: true };
    }
    return { value: parsed as Record<string, unknown>, invalid: false };
  } catch {
    return { value: undefined, invalid: true };
  }
}

/**
 * `null` = the row is dropped (empty id). An INVALID extraBody is left out —
 * flagged inline, never saved — while the rest of the row still goes through.
 */
function cleanRow(r: ModelRow, extraBody: Record<string, unknown> | undefined): CleanModel | null {
  const id = r.id.trim();
  if (id === '') return null;
  const num = {
    contextWindow: optionalNumber(r.contextWindow),
    maxOutputTokens: optionalNumber(r.maxOutputTokens),
    temperature: optionalNumber(r.temperature),
    topP: optionalNumber(r.topP),
  };
  const tools = [
    ...new Set(
      r.serverTools
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== ''),
    ),
  ];
  return {
    id,
    type: r.type,
    ...(r.displayName.trim() !== '' ? { displayName: r.displayName.trim() } : {}),
    ...(num.contextWindow !== undefined ? { contextWindow: num.contextWindow } : {}),
    ...(num.maxOutputTokens !== undefined ? { maxOutputTokens: num.maxOutputTokens } : {}),
    ...(r.vision ? { vision: true } : {}),
    ...(num.temperature !== undefined ? { temperature: num.temperature } : {}),
    ...(num.topP !== undefined ? { topP: num.topP } : {}),
    ...(tools.length > 0 ? { serverTools: tools } : {}),
    ...(extraBody !== undefined ? { extraBody } : {}),
  };
}

/**
 * LLM provider management (Phase 9 W10) — cc-switch-style reusable routes.
 * The provider is the ROUTE; the API key lives in the referenced credential.
 * #51 adds the model REGISTRY to the row: the curated model list machine
 * pages pick from.
 */
export function LlmProvidersPage() {
  const { logout, user } = useAuth();
  const { t } = useI18n();
  const [items, setItems] = useState<LlmProviderView[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<LlmProviderView | null>(null);
  const [pending, setPending] = useState<LlmProviderView | null>(null);
  const [busy, setBusy] = useState(false);
  const isAdmin = user?.role === 'admin';

  async function refresh() {
    try {
      setItems(await withAuthGuard(() => api.listLlmProviders(), logout));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const query = useListQuery(PROVIDER_SPEC);
  const visible = useMemo(() => {
    if (items === null) return null;
    const rows = items.filter(
      (p) =>
        matchesQuery(query.q, [p.name, p.baseUrl, p.credentialName, p.api]) &&
        (query.filters['api'] === null || p.api === query.filters['api']) &&
        (query.filters['scope'] === null || p.scope === query.filters['scope']),
    );
    return sortRows(rows, effectiveSort(PROVIDER_SPEC, query), (p, key) =>
      key === 'name' ? p.name : (p.updatedAt ?? p.createdAt ?? null),
    );
  }, [items, query.q, query.filters, query.sort]);

  const apiLabels = useMemo(() => Object.fromEntries(API_KINDS.map((api) => [api, api])), []);
  const scopeLabels = useMemo(
    () => ({ personal: t('common.scopePersonal'), global: t('common.scopeGlobal') }),
    [t],
  );
  const sortLabels = useMemo(
    () => ({ name: t('common.sortName'), '-updated': t('common.sortUpdated') }),
    [t],
  );

  async function confirmRemove() {
    const p = pending;
    if (p === null) return;
    setBusy(true);
    try {
      await withAuthGuard(() => api.deleteLlmProvider(p.id), logout);
      toast.success(t('llmProviders.deletedToast'));
      setPending(null);
      await refresh();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.deleteFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageSlot slot="actions">
        <PageAction label={t('common.create')} onClick={() => setCreating(true)} />
      </PageSlot>

      <PageIntro
        sub={
          <>
            {t('llmProviders.subtitle1')} {t('llmProviders.subtitle2')}
          </>
        }
      />

      <DataTable
        columns={6}
        label={t('llmProviders.storedTitle')}
        icon={<PlugZapIcon />}
        state={tableState({
          error,
          loading: items === null,
          count: visible?.length ?? 0,
          filtered: query.active,
        })}
        error={error}
        onRetry={() => void refresh()}
        onClearFilters={query.clear}
        toolbar={
          <FilterBar query={query} shown={visible?.length} total={items?.length}>
            <TableSearch query={query} placeholder={t('llmProviders.searchPlaceholder')} />
            <FilterSelect
              query={query}
              spec={PROVIDER_SPEC}
              name="api"
              allLabel={t('llmProviders.allApis')}
              labels={apiLabels}
            />
            <FilterSelect
              query={query}
              spec={PROVIDER_SPEC}
              name="scope"
              allLabel={t('common.allScopes')}
              labels={scopeLabels}
            />
            <SortSelect
              query={query}
              spec={PROVIDER_SPEC}
              label={t('common.sortLabel')}
              labels={sortLabels}
            />
          </FilterBar>
        }
        empty={{
          title: t('llmProviders.empty'),
          hint: t('llmProviders.emptyHint'),
          action: (
            <Button onClick={() => setCreating(true)}>
              <PlusIcon className="size-4" />
              {t('common.create')}
            </Button>
          ),
        }}
      >
        <TableHeader>
          <TableRow>
            <TableHead>{t('common.name')}</TableHead>
            <TableHead>{t('llmProviders.apiLabel')}</TableHead>
            <TableHead>{t('llmProviders.baseUrlHeader')}</TableHead>
            <TableHead>{t('llmProviders.credentialHeader')}</TableHead>
            <TableHead>{t('common.scope')}</TableHead>
            <TableHead className="text-right">{t('common.actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible?.map((p) => (
            <TableRow key={p.id}>
              {/* The registry count rides the name cell (a muted figure, not a
                  7th column) — numerator of "how many models this route has". */}
              <TableCell className="font-medium">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate">{p.name}</span>
                  {p.models.length > 0 ? (
                    <span
                      className="text-muted-foreground text-xs tabular-nums"
                      title={t('llmProviders.modelsCountTitle', { count: p.models.length })}
                    >
                      {p.models.length}
                    </span>
                  ) : null}
                </span>
              </TableCell>
              <TableCell>
                <Badge variant="outline" className="font-mono text-[10px]">
                  {p.api}
                </Badge>
              </TableCell>
              {/* Both are protocol material — a URL and a credential NAME —
                  so they render as devices, not as hand-rolled mono text
                  (02-content.md §4; the same cell-scale chip as the machines
                  list's host). The URL is copyable; the credential is not
                  (its name goes nowhere useful pasted alone). */}
              <TableCell className="max-w-64">
                {p.baseUrl === null ? (
                  <DataText size="sm" tone="dim">
                    {t('llmProviders.baseUrlPlaceholder')}
                  </DataText>
                ) : (
                  <Well variant="chip" copy={p.baseUrl}>
                    {p.baseUrl}
                  </Well>
                )}
              </TableCell>
              <TableCell>
                <Well variant="chip">{p.credentialName}</Well>
              </TableCell>
              <TableCell>
                <Badge variant={p.scope === 'global' ? 'default' : 'secondary'} className="gap-1">
                  {p.scope === 'global' ? (
                    <GlobeIcon className="size-3" />
                  ) : (
                    <UserIcon className="size-3" />
                  )}
                  {p.scope === 'global' ? t('common.scopeGlobal') : t('common.scopePersonal')}
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="size-(--row-ctl-h)">
                      <MoreHorizontalIcon className="size-4" />
                      <span className="sr-only">{t('common.openMenu')}</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setEditing(p)}>
                      <PencilIcon /> {t('llmProviders.editButton')}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={p.scope === 'global' && !isAdmin}
                      onClick={() => setPending(p)}
                    >
                      <TrashIcon /> {t('common.delete')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </DataTable>

      {pending !== null ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) setPending(null);
          }}
          title={t('llmProviders.deleteAction')}
          consequence={t('llmProviders.deleteConsequence')}
          impact={[
            { label: 'provider', value: pending.name },
            { label: 'api', value: pending.api },
            { label: 'credential', value: pending.credentialName },
          ]}
          actionLabel={t('llmProviders.deleteAction')}
          busy={busy}
          onConfirm={() => void confirmRemove()}
        />
      ) : null}

      {creating ? (
        <ProviderForm
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void refresh();
          }}
        />
      ) : null}
      {editing !== null ? (
        <ProviderForm
          existing={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refresh();
          }}
        />
      ) : null}
    </>
  );
}

/**
 * One registry row, reflowed as TWO input lines (one line never fits the seven
 * controls at dialog width — the id field measured 65px before the rework):
 * identity (model id + display name) then figures (type / context / max
 * output / vision), plus an "advanced" disclosure whose api-gated fields only
 * render where the server actually applies them — serverTools is honored by
 * the Responses stream only, extraBody by both OpenAI-compatible adapters
 * (never Anthropic's; see assistant/provider.ts samplingParams). Module
 * scope, never defined inline.
 */
function ModelRowCard({
  index,
  api,
  row,
  duplicate,
  invalidExtraBody,
  onChange,
  onRemove,
}: {
  /** Row position — used only to build unique control ids. */
  index: number;
  /** The provider's api kind — gates the advanced fields (see above). */
  api: ProviderApiKind;
  row: ModelRow;
  duplicate: boolean;
  invalidExtraBody: boolean;
  onChange: (patch: Partial<ModelRow>) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const showServerTools = api === 'openai-responses';
  const showExtraBody = api !== 'anthropic';
  return (
    <div className="relative flex flex-col gap-3 rounded-md border p-3">
      <div className="grid gap-x-3 gap-y-2 pr-9 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="grid gap-2">
          <Label htmlFor={`llmp-mid-${index}`}>{t('llmProviders.modelIdLabel')}</Label>
          <Input
            id={`llmp-mid-${index}`}
            value={row.id}
            onChange={(e) => onChange({ id: e.target.value })}
            placeholder={t('llmProviders.modelIdPlaceholder')}
            className="font-mono text-xs"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={duplicate || undefined}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`llmp-mdn-${index}`}>{t('llmProviders.modelDisplayNameLabel')}</Label>
          <Input
            id={`llmp-mdn-${index}`}
            value={row.displayName}
            onChange={(e) => onChange({ displayName: e.target.value })}
            autoComplete="off"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-4">
        <div className="grid gap-2">
          <Label htmlFor={`llmp-mtype-${index}`}>{t('llmProviders.modelTypeLabel')}</Label>
          <Select value={row.type} onValueChange={(v) => onChange({ type: v as ModelRow['type'] })}>
            <SelectTrigger id={`llmp-mtype-${index}`} className="font-mono text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['chat', 'embedding'] as const).map((k) => (
                <SelectItem key={k} value={k} className="font-mono text-xs">
                  {k}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`llmp-mcw-${index}`}>{t('llmProviders.modelContextLabel')}</Label>
          <Input
            id={`llmp-mcw-${index}`}
            type="number"
            min={1}
            step={1}
            value={row.contextWindow}
            onChange={(e) => onChange({ contextWindow: e.target.value })}
            className="font-mono text-xs tabular-nums"
            autoComplete="off"
            inputMode="numeric"
            spellCheck={false}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`llmp-mmo-${index}`}>{t('llmProviders.modelMaxOutputLabel')}</Label>
          <Input
            id={`llmp-mmo-${index}`}
            type="number"
            min={1}
            step={1}
            value={row.maxOutputTokens}
            onChange={(e) => onChange({ maxOutputTokens: e.target.value })}
            className="font-mono text-xs tabular-nums"
            autoComplete="off"
            inputMode="numeric"
            spellCheck={false}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`llmp-mvis-${index}`}>{t('llmProviders.modelVisionLabel')}</Label>
          <div className="flex h-(--control-h) items-center">
            <Checkbox
              id={`llmp-mvis-${index}`}
              checked={row.vision}
              onCheckedChange={(v) => onChange({ vision: v === true })}
            />
          </div>
        </div>
      </div>
      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="group text-muted-foreground h-7 self-start gap-1 px-2 text-xs hover:text-foreground"
          >
            <ChevronDownIcon className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
            {t('llmProviders.advancedLabel')}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="grid gap-3 pt-1 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor={`llmp-mtemp-${index}`}>
                {t('llmProviders.modelTemperatureLabel')}
              </Label>
              <Input
                id={`llmp-mtemp-${index}`}
                type="number"
                min={0}
                max={2}
                step="any"
                value={row.temperature}
                onChange={(e) => onChange({ temperature: e.target.value })}
                className="font-mono text-xs tabular-nums"
                autoComplete="off"
                inputMode="decimal"
                spellCheck={false}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={`llmp-mtopp-${index}`}>{t('llmProviders.modelTopPLabel')}</Label>
              <Input
                id={`llmp-mtopp-${index}`}
                type="number"
                min={0}
                max={1}
                step="any"
                value={row.topP}
                onChange={(e) => onChange({ topP: e.target.value })}
                className="font-mono text-xs tabular-nums"
                autoComplete="off"
                inputMode="decimal"
                spellCheck={false}
              />
            </div>
            {showServerTools ? (
              <div className="grid gap-2">
                <Label htmlFor={`llmp-mtools-${index}`}>{t('llmProviders.serverToolsLabel')}</Label>
                <Input
                  id={`llmp-mtools-${index}`}
                  value={row.serverTools}
                  onChange={(e) => onChange({ serverTools: e.target.value })}
                  placeholder={t('llmProviders.serverToolsPlaceholder')}
                  className="font-mono text-xs"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            ) : null}
            {showExtraBody ? (
              <div className="grid gap-2 sm:col-span-2">
                <Label htmlFor={`llmp-mextra-${index}`}>{t('llmProviders.extraBodyLabel')}</Label>
                <Textarea
                  id={`llmp-mextra-${index}`}
                  value={row.extraBody}
                  onChange={(e) => onChange({ extraBody: e.target.value })}
                  placeholder={t('llmProviders.extraBodyPlaceholder')}
                  className="min-h-16 font-mono text-xs"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={invalidExtraBody || undefined}
                />
                {invalidExtraBody ? (
                  <p className="text-danger text-xs">{t('llmProviders.extraBodyInvalid')}</p>
                ) : null}
              </div>
            ) : null}
          </div>
        </CollapsibleContent>
      </Collapsible>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="text-muted-foreground absolute right-2 top-2 size-8 shrink-0 hover:text-danger"
        onClick={onRemove}
        aria-label={t('llmProviders.removeModel', { id: row.id === '' ? '…' : row.id })}
      >
        <XIcon className="size-3.5" />
      </Button>
    </div>
  );
}

function ProviderForm({
  existing,
  onClose,
  onSaved,
}: {
  existing?: LlmProviderView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { logout, user } = useAuth();
  const { t } = useI18n();
  const isAdmin = user?.role === 'admin';
  const [creds, setCreds] = useState<CredentialView[] | null>(null);
  const [name, setName] = useState(existing?.name ?? '');
  const [apiKind, setApiKind] = useState<ProviderApiKind>(existing?.api ?? 'anthropic');
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? '');
  const [credentialName, setCredentialName] = useState(existing?.credentialName ?? '');
  const [scope, setScope] = useState<Scope>(existing?.scope ?? 'personal');
  const [rows, setRows] = useState<ModelRow[]>(() => (existing?.models ?? []).map(rowFromModel));
  const [fetching, setFetching] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      // Every real consumer of a provider is an apply-config, which requires
      // a distributable credential — offer only those.
      let distributable: CredentialView[] = [];
      try {
        distributable = (await withAuthGuard(() => api.listCredentials(), logout)).filter(
          (c) => c.distributable,
        );
      } catch {
        distributable = [];
      }
      if (!cancelled) setCreds(distributable);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const duplicateIds = useMemo(() => {
    const seen = new Set<string>();
    const dups = new Set<string>();
    for (const r of rows) {
      const id = r.id.trim();
      if (id === '') continue;
      if (seen.has(id)) dups.add(id);
      seen.add(id);
    }
    return dups;
  }, [rows]);

  /** The exact save payload (and warnings input): parsed, empty-id rows dropped. */
  const { cleaned, warnings, extraInvalid } = useMemo(() => {
    const parsed = rows.map((r) => parseExtraBody(r.extraBody));
    const cleaned = rows
      .map((r, i) => cleanRow(r, parsed[i]?.value))
      .filter((c): c is CleanModel => c !== null);
    return {
      cleaned,
      warnings: providerModelConfigWarnings(apiKind, cleaned),
      extraInvalid: parsed.map((p) => p.invalid),
    };
  }, [rows, apiKind]);

  /** 获取候选 — seed the registry from the endpoint's live list. MERGE, never
   *  overwrite: curated rows stay untouched; unknown ids land as bare rows. */
  async function fetchCandidates(): Promise<void> {
    setFetching(true);
    try {
      const list = await withAuthGuard(() => {
        // Edit mode queries the SAVED row; in create mode the row doesn't
        // exist yet, so the explicit arm spells it out (credential required).
        if (existing !== undefined) {
          return api.queryProviderModels({ providerId: existing.id });
        }
        return api.queryProviderModels({
          api: apiKind,
          ...(baseUrl.trim() !== '' ? { baseUrl: baseUrl.trim() } : {}),
          credentialName,
        });
      }, logout);
      const known = new Set(rows.map((r) => r.id.trim()).filter((id) => id !== ''));
      const fresh = list
        .filter((m) => !known.has(m.id))
        .map((m): ModelRow => ({ ...EMPTY_MODEL_ROW, id: m.id }));
      if (fresh.length > 0) {
        setRows((prev) => [...prev, ...fresh]);
        toast.success(t('llmProviders.candidatesAddedToast', { count: fresh.length }));
      } else {
        toast.info(t('llmProviders.candidatesNoneToast'));
      }
    } catch (e) {
      toast.error(
        e instanceof HarnessNexusError ? e.message : t('llmProviders.fetchCandidatesFailed'),
      );
    } finally {
      setFetching(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (existing !== undefined) {
        await withAuthGuard(
          () =>
            api.updateLlmProvider(existing.id, {
              name,
              api: apiKind,
              // Empty input = clear the override back to the official endpoint.
              baseUrl: baseUrl.trim() === '' ? null : baseUrl.trim(),
              credentialName,
              // #51 — full replace of the model registry.
              models: cleaned,
            }),
          logout,
        );
        toast.success(t('llmProviders.updatedToast'));
      } else {
        await withAuthGuard(
          () =>
            api.createLlmProvider({
              name,
              api: apiKind,
              ...(baseUrl.trim() !== '' ? { baseUrl: baseUrl.trim() } : {}),
              credentialName,
              scope,
              models: cleaned,
            }),
          logout,
        );
        toast.success(t('llmProviders.createdToast'));
      }
      onSaved();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.createFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <FormDialog
        open
        onClose={onClose}
        size="lg"
        title={existing !== undefined ? t('llmProviders.editTitle') : t('llmProviders.addTitle')}
        description={t('llmProviders.addDesc')}
      >
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          {/* Two-column grid — row heights stay even (no in-cell hints); the
            credential select spans the full last row in create mode so long
            mono names never truncate. */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="llmp-name">{t('common.name')}</Label>
              <Input
                id="llmp-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('llmProviders.namePlaceholder')}
                autoComplete="off"
                spellCheck={false}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="llmp-api">{t('llmProviders.apiLabel')}</Label>
              <Select value={apiKind} onValueChange={(v) => setApiKind(v as ProviderApiKind)}>
                <SelectTrigger id="llmp-api" className="font-mono text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {API_KINDS.map((k) => (
                    <SelectItem key={k} value={k} className="font-mono text-xs">
                      {k}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="llmp-url">{t('llmProviders.baseUrlLabel')}</Label>
              <Input
                id="llmp-url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={t('llmProviders.baseUrlPlaceholder')}
                className="font-mono text-xs"
                autoComplete="off"
                spellCheck={false}
                inputMode="url"
              />
            </div>
            {existing === undefined ? (
              <div className="grid gap-2">
                <Label htmlFor="llmp-scope">{t('common.scope')}</Label>
                <Select
                  value={scope}
                  onValueChange={(v) => setScope(v as Scope)}
                  disabled={!isAdmin}
                >
                  <SelectTrigger id="llmp-scope">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="personal">{t('common.scopePersonal')}</SelectItem>
                    <SelectItem value="global" disabled={!isAdmin}>
                      {t('common.scopeGlobal')}
                      {!isAdmin ? t('credentials.adminSuffix') : ''}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <div className="grid gap-2 sm:col-span-2">
              <Label htmlFor="llmp-cred">{t('llmProviders.credentialLabel')}</Label>
              <Select value={credentialName} onValueChange={setCredentialName}>
                <SelectTrigger id="llmp-cred" className="font-mono text-xs">
                  <SelectValue placeholder={t('llmProviders.pickCredential')} />
                </SelectTrigger>
                <SelectContent>
                  {(creds ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.name} className="font-mono text-xs">
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="text-muted-foreground text-xs">{t('llmProviders.apiHint')}</p>
          {creds !== null && creds.length === 0 ? (
            <p className="text-muted-foreground text-xs">{t('llmProviders.noCredentials')}</p>
          ) : null}

          {/* #51 — the model REGISTRY. Curated here (full replace on save);
              machine pages pick from it instead of re-discovering. */}
          <div className="flex flex-col gap-3 border-t pt-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-sm font-medium">{t('llmProviders.modelsTitle')}</p>
                <p className="text-muted-foreground text-xs">{t('llmProviders.modelsDesc')}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={fetching || (existing === undefined && credentialName === '')}
                  onClick={() => void fetchCandidates()}
                >
                  <RefreshCwIcon className={fetching ? 'animate-spin' : ''} />
                  {t('llmProviders.fetchCandidates')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setRows((prev) => [...prev, { ...EMPTY_MODEL_ROW }])}
                >
                  <PlusIcon className="size-3.5" />
                  {t('llmProviders.addModel')}
                </Button>
              </div>
            </div>
            {rows.length === 0 ? (
              <p className="text-muted-foreground text-xs">{t('llmProviders.noModelsYet')}</p>
            ) : (
              <div className="flex flex-col gap-3">
                {rows.map((row, i) => (
                  <ModelRowCard
                    key={i}
                    index={i}
                    api={apiKind}
                    row={row}
                    duplicate={duplicateIds.has(row.id.trim())}
                    invalidExtraBody={extraInvalid[i] ?? false}
                    onChange={(patch) =>
                      setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)))
                    }
                    onRemove={() => setRows((prev) => prev.filter((_, j) => j !== i))}
                  />
                ))}
              </div>
            )}
            {warnings.length > 0 ? (
              <Note tone="warn" title={t('llmProviders.modelsWarningsTitle')}>
                <ul className="flex flex-col gap-0.5">
                  {warnings.map((w) => (
                    <li key={`${w.code}:${w.modelId}`}>
                      {w.code === 'serverToolsIrrelevant'
                        ? t('llmProviders.warnServerTools', { id: w.modelId })
                        : t('llmProviders.warnExtraBody', { id: w.modelId })}
                    </li>
                  ))}
                </ul>
              </Note>
            ) : null}
            {duplicateIds.size > 0 ? (
              <p className="text-danger text-xs">
                {t('llmProviders.duplicateModelsError', { ids: [...duplicateIds].join(', ') })}
              </p>
            ) : null}
          </div>

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={busy || credentialName === '' || duplicateIds.size > 0}>
              {busy
                ? existing !== undefined
                  ? t('llmProviders.saving')
                  : t('llmProviders.creating')
                : existing !== undefined
                  ? t('llmProviders.saveButton')
                  : t('llmProviders.createButton')}
            </Button>
          </div>
        </form>
      </FormDialog>
    </>
  );
}
