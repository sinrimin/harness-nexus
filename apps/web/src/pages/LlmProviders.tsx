// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  ChevronDownIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlugZapIcon,
  PlusIcon,
  RefreshCwIcon,
  Settings2Icon,
  TrashIcon,
  XIcon,
} from 'lucide-react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import {
  ConfirmDialog,
  DataTable,
  DataText,
  Field,
  FilterBar,
  FilterSelect,
  Note,
  PageIntro,
  ScopeBadge,
  SortSelect,
  TableSearch,
  TagCombobox,
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
import { Switch } from '@/components/ui/switch';
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
  isChatApiKind,
  providerEndpointUrl,
  providerModelConfigWarnings,
  EXTRA_BODY_BOOLEAN_KEYS,
  EXTRA_BODY_PRESETS,
  PROVIDER_DEFAULT_PATHS,
  SERVER_TOOL_PRESETS,
  type CredentialView,
  type LlmModelInfo,
  type LlmProviderView,
  type ProviderApiEndpoint,
  type ProviderApiEndpointInput,
  type ProviderApiKind,
  type ProviderModelConfig,
  type ProviderModelConfigInput,
  type UserDefaultModels,
} from '@harness-nexus/sdk';

type Scope = 'global' | 'personal';

const API_KINDS: ProviderApiKind[] = [
  'openai-chat',
  'openai-responses',
  'anthropic',
  'systemone',
  'openai-embedding',
];

/** A path starting with `http(s)://` overrides the shared base URL. */
const FULL_URL_RE = /^https?:\/\//i;

/** The list's vocabulary (07-p3-list-pages.md §5). */
const PROVIDER_SPEC: ListQuerySpec = {
  filters: { api: API_KINDS, scope: ['personal', 'global'] },
  sort: ['name', '-updated'],
};

/**
 * #95 — the listing arm a provider row offers (mirrors the server's
 * `modelsListKind`): the openai-ish kinds all serve `/models`, anthropic its
 * own; systemone has no listing endpoint.
 */
function listingApiKind(kinds: readonly ProviderApiKind[]): ProviderApiKind | null {
  if (kinds.includes('openai-chat')) return 'openai-chat';
  if (kinds.includes('openai-responses')) return 'openai-responses';
  if (kinds.includes('openai-embedding')) return 'openai-embedding';
  if (kinds.includes('anthropic')) return 'anthropic';
  return null;
}

/**
 * #56 — one extraBody entry's editor state: the key (a TagCombobox value)
 * plus its value editor. Boolean keys (EXTRA_BODY_BOOLEAN_KEYS) keep `bool`;
 * every other key keeps a raw JSON `text` parsed at the save boundary.
 */
interface ExtraBodyEntry {
  key: string;
  text: string;
  bool: boolean;
}

/**
 * #51 — one editable registry row. Numeric and JSON fields stay STRINGS while
 * typing (clearing "0.7" mid-edit must not collapse to a number); they are
 * parsed into the wire shape only at the save boundary (`cleanRow`).
 */
interface ModelRow {
  id: string;
  displayName: string;
  /** #95 — the wire this model speaks; must be one of the provider's enabled kinds. */
  apiKind: ProviderApiKind;
  contextWindow: string;
  maxOutputTokens: string;
  vision: boolean;
  temperature: string;
  topP: string;
  serverTools: string[];
  extraBody: ExtraBodyEntry[];
}

/** The wire shape after parsing — `apiKind` always explicit, unset keys omitted. */
type CleanModel = ProviderModelConfigInput;

/**
 * #58-1 — the model-id field with the fetched candidates as a dropdown. Free
 * typing stays primary (the registry is hand-curatable — an endpoint's list is
 * a SUGGESTION, never mass-imported); focusing or typing offers the filtered
 * candidate list, ↑/↓ + Enter or a click fills the id verbatim. No
 * candidates fetched (null) = the plain input.
 */
function ModelIdInput({
  id,
  value,
  candidates,
  invalid,
  placeholder,
  onChange,
}: {
  id: string;
  value: string;
  candidates: LlmModelInfo[] | null;
  invalid?: boolean;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocPointerDown(e: PointerEvent): void {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [open]);

  const q = value.trim().toLowerCase();
  const matches =
    candidates === null
      ? []
      : q === ''
        ? candidates
        : candidates.filter(
            (c) => c.id.toLowerCase().includes(q) || (c.name ?? '').toLowerCase().includes(q),
          );
  useEffect(() => {
    if (activeIdx >= matches.length) setActiveIdx(0);
  }, [matches.length, activeIdx]);

  return (
    <div ref={rootRef} className="relative">
      <Input
        id={id}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (!open || matches.length === 0) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActiveIdx((i) => (i + 1) % matches.length);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIdx((i) => (i - 1 + matches.length) % matches.length);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            onChange(matches[activeIdx]!.id);
            setOpen(false);
          } else if (e.key === 'Escape') {
            // Only dismiss the listbox — a bare Escape must not bubble into
            // the enclosing Radix dialog (preventDefault shields DismissableLayer).
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        }}
        placeholder={placeholder}
        className="font-mono text-xs"
        autoComplete="off"
        spellCheck={false}
        aria-invalid={invalid || undefined}
        role="combobox"
        aria-expanded={open && matches.length > 0}
        aria-autocomplete="list"
        aria-controls={open && matches.length > 0 ? `${id}-list` : undefined}
      />
      {open && matches.length > 0 ? (
        <ul
          id={`${id}-list`}
          role="listbox"
          data-swallow-escape="true"
          className="bg-card text-card-foreground absolute z-50 mt-1 max-h-48 w-full overflow-auto rounded-md border shadow-(--shadow-panel)"
        >
          {matches.map((c, i) => (
            <li key={c.id} role="option" aria-selected={i === activeIdx}>
              <button
                type="button"
                data-option={c.id}
                className={cn(
                  'hover:bg-tray flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left',
                  i === activeIdx && 'bg-tray',
                )}
                onClick={() => {
                  onChange(c.id);
                  setOpen(false);
                }}
              >
                <span className="role-data-sm truncate font-mono">{c.id}</span>
                {c.name !== undefined && c.name !== '' ? (
                  <span className="text-muted-foreground truncate text-xs">{c.name}</span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** #95 — a fresh registry row starts on one of the row's enabled wires. */
function emptyModelRow(apiKind: ProviderApiKind): ModelRow {
  return {
    id: '',
    displayName: '',
    apiKind,
    contextWindow: '',
    maxOutputTokens: '',
    vision: false,
    temperature: '',
    topP: '',
    serverTools: [],
    extraBody: [],
  };
}

function rowFromModel(m: ProviderModelConfig): ModelRow {
  return {
    id: m.id,
    displayName: m.displayName ?? '',
    apiKind: m.apiKind,
    contextWindow: m.contextWindow !== undefined ? String(m.contextWindow) : '',
    maxOutputTokens: m.maxOutputTokens !== undefined ? String(m.maxOutputTokens) : '',
    vision: m.vision === true,
    temperature: m.temperature !== undefined ? String(m.temperature) : '',
    topP: m.topP !== undefined ? String(m.topP) : '',
    serverTools: m.serverTools ?? [],
    extraBody: Object.entries(m.extraBody ?? {}).map(([key, v]) => ({
      key,
      bool: EXTRA_BODY_BOOLEAN_KEYS.has(key) && v === true,
      text: EXTRA_BODY_BOOLEAN_KEYS.has(key) || v === undefined ? '' : (JSON.stringify(v) ?? ''),
    })),
  };
}

/** Trimmed string → number, or undefined when empty / non-numeric. */
function optionalNumber(v: string): number | undefined {
  const t = v.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * #56 — parse the extraBody entries into the wire record at the save
 * boundary. Boolean keys contribute their toggle; every other key parses its
 * JSON text. An invalid/empty JSON value drops THAT key — flagged inline via
 * `invalid`, never saved — while the rest still goes through. Empty keys
 * (a tag mid-edit) and duplicate keys are skipped silently.
 */
function cleanExtraBody(entries: ExtraBodyEntry[]): {
  value: Record<string, unknown> | undefined;
  invalid: boolean;
} {
  const out: Record<string, unknown> = {};
  const seen = new Set<string>();
  let invalid = false;
  for (const e of entries) {
    const key = e.key.trim();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    if (EXTRA_BODY_BOOLEAN_KEYS.has(key)) {
      out[key] = e.bool;
    } else {
      const t = e.text.trim();
      if (t === '') {
        invalid = true;
        continue;
      }
      try {
        out[key] = JSON.parse(t) as unknown;
      } catch {
        invalid = true;
      }
    }
  }
  return { value: Object.keys(out).length > 0 ? out : undefined, invalid };
}

/** #56 — reconcile entry editor state with the keys the combobox now holds. */
function syncExtraBodyEntries(existing: ExtraBodyEntry[], keys: string[]): ExtraBodyEntry[] {
  const byKey = new Map(existing.map((e) => [e.key, e]));
  return keys.map((k) => byKey.get(k) ?? { key: k, text: '', bool: false });
}

/**
 * `null` = the row is dropped (empty id). An INVALID extraBody is left out —
 * flagged inline, never saved — while the rest of the row still goes through.
 */
function cleanRow(r: ModelRow, extraBody: Record<string, unknown> | undefined): CleanModel | null {
  const id = r.id.trim();
  if (id === '') return null;
  // #95 — only the chat wires carry the chat metadata / advanced knobs; a
  // systemone or embedding row is id + display name (the dialog hides the
  // rest), so they never ride the wire even if stale editor state holds them.
  const chat = isChatApiKind(r.apiKind);
  const num = {
    contextWindow: chat ? optionalNumber(r.contextWindow) : undefined,
    maxOutputTokens: chat ? optionalNumber(r.maxOutputTokens) : undefined,
    temperature: chat ? optionalNumber(r.temperature) : undefined,
    topP: chat ? optionalNumber(r.topP) : undefined,
  };
  const tools = chat
    ? [...new Set(r.serverTools.map((s) => s.trim()).filter((s) => s !== ''))]
    : [];
  return {
    id,
    apiKind: r.apiKind,
    ...(r.displayName.trim() !== '' ? { displayName: r.displayName.trim() } : {}),
    ...(num.contextWindow !== undefined ? { contextWindow: num.contextWindow } : {}),
    ...(num.maxOutputTokens !== undefined ? { maxOutputTokens: num.maxOutputTokens } : {}),
    ...(chat && r.vision ? { vision: true } : {}),
    ...(num.temperature !== undefined ? { temperature: num.temperature } : {}),
    ...(num.topP !== undefined ? { topP: num.topP } : {}),
    ...(tools.length > 0 ? { serverTools: tools } : {}),
    ...(chat && extraBody !== undefined ? { extraBody } : {}),
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
  const [defaultsOpen, setDefaultsOpen] = useState(false);
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
        matchesQuery(query.q, [p.name, p.baseUrl, p.credentialName, p.apis.map((a) => a.kind)]) &&
        (query.filters['api'] === null || p.apis.some((a) => a.kind === query.filters['api'])) &&
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
        <PageAction
          label={t('llmProviders.defaultsAction')}
          icon={Settings2Icon}
          variant="outline"
          disabled={items === null}
          onClick={() => setDefaultsOpen(true)}
        />
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
                <span className="flex flex-wrap items-center gap-1">
                  {p.apis.map((a) => (
                    <Badge key={a.kind} variant="secondary" className="role-data-sm">
                      {a.kind}
                    </Badge>
                  ))}
                </span>
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
                <ScopeBadge scope={p.scope} />
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
            ...pending.apis.map((a) => {
              const path =
                a.path === null || a.path === '' ? t('llmProviders.defaultPath') : a.path;
              const url = providerEndpointUrl(a.kind, {
                baseUrl: pending.baseUrl,
                path: a.path,
              });
              return {
                label: a.kind,
                value: `${path} · ${url ?? t('llmProviders.unresolvedEndpoint')}`,
              };
            }),
            { label: 'credential', value: pending.credentialName },
          ]}
          actionLabel={t('llmProviders.deleteAction')}
          busy={busy}
          onConfirm={() => void confirmRemove()}
        />
      ) : null}

      {defaultsOpen ? (
        <DefaultModelsDialog providers={items ?? []} onClose={() => setDefaultsOpen(false)} />
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
 * identity (model id + display name) then figures (protocol / context / max
 * output / vision), plus an "advanced" disclosure. #95 — each model declares
 * the wire it speaks, picked from the provider row's ENABLED kinds only; the
 * non-chat kinds (systemone, openai-embedding) keep just id + display name.
 * #56: serverTools and the extraBody KEYS are TagComboboxes with per-MODEL
 * presets (SERVER_TOOL_PRESETS / EXTRA_BODY_PRESETS, Bailian-baselined) —
 * typed custom values are the gateway-compat escape hatch. #58-2 hide-and-clear:
 * serverTools renders on the kinds that HAVE a tools[] surface
 * (openai-responses, anthropic) and extraBody on the OpenAI-compatible kinds;
 * the save boundary drops the fields a non-chat kind hides. The shared
 * warnings stay as the backstop for REST-written rows.
 */
function ModelRowCard({
  index,
  row,
  enabledKinds,
  candidates,
  duplicate,
  invalidExtraBody,
  onChange,
  onRemove,
}: {
  /** Row position — used only to build unique control ids. */
  index: number;
  row: ModelRow;
  /** #95 — only the provider's enabled wires are offerable. */
  enabledKinds: readonly ProviderApiKind[];
  /** #58-1 — the fetched model list, offered by the id field's dropdown. */
  candidates: LlmModelInfo[] | null;
  duplicate: boolean;
  invalidExtraBody: boolean;
  onChange: (patch: Partial<ModelRow>) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const chat = isChatApiKind(row.apiKind);
  const showServerTools = chat && row.apiKind !== 'openai-chat';
  const showExtraBody = chat && row.apiKind !== 'anthropic';
  return (
    <div className="relative flex flex-col gap-3 rounded-md border p-3">
      <div className="grid gap-x-3 gap-y-2 pr-9 sm:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="grid gap-2">
          <Label htmlFor={`llmp-mid-${index}`}>{t('llmProviders.modelIdLabel')}</Label>
          <ModelIdInput
            id={`llmp-mid-${index}`}
            value={row.id}
            candidates={candidates}
            invalid={duplicate}
            placeholder={t('llmProviders.modelIdPlaceholder')}
            onChange={(id) => onChange({ id })}
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
          <Label htmlFor={`llmp-mapi-${index}`}>{t('llmProviders.apiKindLabel')}</Label>
          <Select
            value={row.apiKind}
            onValueChange={(v) => onChange({ apiKind: v as ProviderApiKind })}
          >
            <SelectTrigger id={`llmp-mapi-${index}`} className="font-mono text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {enabledKinds.map((k) => (
                <SelectItem key={k} value={k} className="font-mono text-xs">
                  {k}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {chat ? (
          <>
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
          </>
        ) : null}
      </div>
      {chat ? (
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
                  <Label htmlFor={`llmp-mtools-${index}`}>
                    {t('llmProviders.serverToolsLabel')}
                  </Label>
                  <TagCombobox
                    id={`llmp-mtools-${index}`}
                    value={row.serverTools}
                    options={SERVER_TOOL_PRESETS[row.apiKind]}
                    onChange={(serverTools) => onChange({ serverTools })}
                    placeholder={t('llmProviders.tagComboboxPlaceholder')}
                    addLabel={(v) => t('llmProviders.tagComboboxAdd', { value: v })}
                    removeLabel={(v) => t('llmProviders.tagComboboxRemove', { value: v })}
                  />
                </div>
              ) : null}
              {showExtraBody ? (
                <div className="grid gap-2 sm:col-span-2">
                  <Label htmlFor={`llmp-mextra-${index}`}>{t('llmProviders.extraBodyLabel')}</Label>
                  <TagCombobox
                    id={`llmp-mextra-${index}`}
                    value={row.extraBody.map((e) => e.key)}
                    options={EXTRA_BODY_PRESETS[row.apiKind]}
                    onChange={(keys) =>
                      onChange({ extraBody: syncExtraBodyEntries(row.extraBody, keys) })
                    }
                    placeholder={t('llmProviders.tagComboboxPlaceholder')}
                    addLabel={(v) => t('llmProviders.tagComboboxAdd', { value: v })}
                    removeLabel={(v) => t('llmProviders.tagComboboxRemove', { value: v })}
                  />
                  {row.extraBody.length > 0 ? (
                    <div className="grid gap-1.5">
                      {row.extraBody.map((e, j) => (
                        <div
                          key={e.key}
                          className="grid gap-1.5 sm:grid-cols-[minmax(0,220px)_minmax(0,1fr)] sm:items-center"
                        >
                          <span
                            className="role-data-sm truncate font-mono text-xs"
                            title={e.key}
                            data-extra-key={e.key}
                          >
                            {e.key}
                          </span>
                          {EXTRA_BODY_BOOLEAN_KEYS.has(e.key) ? (
                            <div className="flex h-(--control-h) items-center">
                              <Switch
                                checked={e.bool}
                                onCheckedChange={(v) =>
                                  onChange({
                                    extraBody: row.extraBody.map((x, k) =>
                                      k === j ? { ...x, bool: v } : x,
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
                                onChange({
                                  extraBody: row.extraBody.map((x, k) =>
                                    k === j ? { ...x, text: ev.target.value } : x,
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
                    </div>
                  ) : null}
                  {invalidExtraBody ? (
                    <p className="text-danger text-xs">{t('llmProviders.extraBodyInvalid')}</p>
                  ) : null}
                </div>
              ) : null}
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
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

/** #95 — one editable wire row in the provider dialog. */
interface ApiRow {
  kind: ProviderApiKind;
  /** Empty = the kind's default path. */
  path: string;
}

function apiRowFrom(a: ProviderApiEndpoint): ApiRow {
  return { kind: a.kind, path: a.path ?? '' };
}

/**
 * One enabled wire: the kind (only kinds another row does not already own are
 * offerable), the optional path override, the resolved endpoint preview, and
 * the remove control. The preview runs the same pure helper the server's
 * outbound surfaces use, so the dialog never promises a URL the wire won't call.
 */
function ApiEndpointRow({
  index,
  row,
  usedKinds,
  baseUrl,
  canRemove,
  onKindChange,
  onPathChange,
  onRemove,
}: {
  index: number;
  row: ApiRow;
  usedKinds: readonly ProviderApiKind[];
  baseUrl: string;
  canRemove: boolean;
  onKindChange: (kind: ProviderApiKind) => void;
  onPathChange: (path: string) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const path = row.path.trim();
  const resolved = providerEndpointUrl(row.kind, {
    baseUrl: baseUrl.trim(),
    path: path === '' ? null : path,
  });
  const options = API_KINDS.filter((k) => k === row.kind || !usedKinds.includes(k));
  return (
    <div className="grid gap-3 rounded-md border p-3 sm:grid-cols-[minmax(0,180px)_minmax(0,1fr)_auto] sm:items-start">
      <div className="grid gap-2">
        <Label htmlFor={`llmp-api-kind-${index}`}>{t('llmProviders.apiKindLabel')}</Label>
        <Select value={row.kind} onValueChange={(v) => onKindChange(v as ProviderApiKind)}>
          <SelectTrigger id={`llmp-api-kind-${index}`} className="font-mono text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((k) => (
              <SelectItem key={k} value={k} className="font-mono text-xs">
                {k}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid min-w-0 gap-2">
        <Label htmlFor={`llmp-api-path-${index}`}>{t('llmProviders.apiPathLabel')}</Label>
        <Input
          id={`llmp-api-path-${index}`}
          value={row.path}
          onChange={(e) => onPathChange(e.target.value)}
          placeholder={t('llmProviders.defaultPathPlaceholder', {
            path: PROVIDER_DEFAULT_PATHS[row.kind],
          })}
          className="font-mono text-xs"
          autoComplete="off"
          spellCheck={false}
          inputMode="url"
        />
        <DataText
          size="sm"
          tone="dim"
          className="block truncate"
          title={resolved ?? t('llmProviders.unresolvedEndpoint')}
        >
          {resolved ?? t('llmProviders.unresolvedEndpoint')}
        </DataText>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="text-muted-foreground hover:text-danger shrink-0 sm:mt-7"
        onClick={onRemove}
        disabled={!canRemove}
        title={canRemove ? undefined : t('llmProviders.keepOneWire')}
        aria-label={t('llmProviders.removeWire', { kind: row.kind })}
      >
        <XIcon className="size-3.5" />
      </Button>
    </div>
  );
}

/** #95 — the dialog's "API endpoints" band: one row per enabled wire. */
function ProviderApisEditor({
  rows,
  baseUrl,
  onKindChange,
  onPathChange,
  onAdd,
  onRemove,
}: {
  rows: readonly ApiRow[];
  baseUrl: string;
  onKindChange: (index: number, kind: ProviderApiKind) => void;
  onPathChange: (index: number, path: string) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
}) {
  const { t } = useI18n();
  const usedKinds = rows.map((r) => r.kind);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{t('llmProviders.apiEndpointsTitle')}</p>
          <p className="text-muted-foreground max-w-[68ch] text-xs">
            {t('llmProviders.apiEndpointsDesc')}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onAdd}
          disabled={usedKinds.length >= API_KINDS.length}
        >
          <PlusIcon className="size-3.5" />
          {t('llmProviders.addWire')}
        </Button>
      </div>
      <div className="flex flex-col gap-2">
        {rows.map((row, i) => (
          <ApiEndpointRow
            key={i}
            index={i}
            row={row}
            usedKinds={usedKinds}
            baseUrl={baseUrl}
            canRemove={rows.length > 1}
            onKindChange={(kind) => onKindChange(i, kind)}
            onPathChange={(path) => onPathChange(i, path)}
            onRemove={() => onRemove(i)}
          />
        ))}
      </div>
    </div>
  );
}

/** Radix Select forbids an empty item value; this sentinel means "未设置". */
const NO_DEFAULT = '__none__';

/** A reserved default-model slot: visible, disabled, and honest about why. */
function ReservedModelSlot({ id, label }: { id: string; label: string }) {
  const { t } = useI18n();
  return (
    <Field label={label} htmlFor={id} hint={t('llmProviders.reservedHint')}>
      <Select value={NO_DEFAULT} disabled>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_DEFAULT}>{t('llmProviders.reserved')}</SelectItem>
        </SelectContent>
      </Select>
    </Field>
  );
}

/**
 * #95 — user-level default models. Embedding / rerank are reserved slots (no
 * consumer yet, shown disabled); the decision slot feeds delegated approvals
 * when a machine's own config omits its provider/model. The save is a FULL
 * replace, so the untouched slots ride through from the loaded state verbatim.
 */
function DefaultModelsDialog({
  providers,
  onClose,
}: {
  providers: readonly LlmProviderView[];
  onClose: () => void;
}) {
  const { logout } = useAuth();
  const { t } = useI18n();
  const [loaded, setLoaded] = useState<UserDefaultModels | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [decisionProviderId, setDecisionProviderId] = useState('');
  const [decisionModelId, setDecisionModelId] = useState('');

  const decisionProviders = useMemo(
    () => providers.filter((p) => p.models.some((m) => m.apiKind === 'systemone')),
    [providers],
  );
  const decisionProvider = decisionProviders.find((p) => p.id === decisionProviderId) ?? null;
  const decisionModels = decisionProvider?.models.filter((m) => m.apiKind === 'systemone') ?? [];

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const defaults = await withAuthGuard(() => api.getUserDefaultModels(), logout);
        if (cancelled) return;
        setLoaded(defaults);
        // Only preselect a decision ref that still resolves to a listed
        // provider/model; a deleted provider reads as "未设置" rather than
        // leaving a hidden stale value the save would echo back.
        const provider = decisionProviders.find((p) => p.id === defaults.decision?.providerId);
        if (
          provider !== undefined &&
          provider.models.some(
            (m) => m.id === defaults.decision?.modelId && m.apiKind === 'systemone',
          )
        ) {
          setDecisionProviderId(provider.id);
          setDecisionModelId(defaults.decision?.modelId ?? '');
        }
      } catch {
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Load once on open — the action is disabled until the page's list exists.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logout]);

  async function save(): Promise<void> {
    if (loaded === null || saving) return;
    setSaving(true);
    try {
      const next: UserDefaultModels = { ...loaded };
      if (decisionProviderId !== '' && decisionModelId !== '') {
        next.decision = { providerId: decisionProviderId, modelId: decisionModelId };
      } else {
        delete next.decision;
      }
      await withAuthGuard(() => api.setUserDefaultModels(next), logout);
      toast.success(t('llmProviders.defaultsSavedToast'));
      onClose();
    } catch (e) {
      const code = e instanceof HarnessNexusError ? e.code : '';
      toast.error(
        code === 'DEFAULT_MODEL_PROVIDER_NOT_FOUND'
          ? t('llmProviders.defaultProviderNotFound')
          : code === 'DEFAULT_MODEL_KIND_MISMATCH'
            ? t('llmProviders.defaultKindMismatch')
            : e instanceof HarnessNexusError
              ? e.message
              : t('llmProviders.defaultSaveFailed'),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('llmProviders.defaultsTitle')}
      description={t('llmProviders.defaultsDesc')}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button type="button" onClick={() => void save()} disabled={saving || loaded === null}>
            {saving ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      {loadFailed ? (
        <Note tone="fail">{t('llmProviders.defaultsLoadFailed')}</Note>
      ) : loaded === null ? (
        <p className="text-muted-foreground text-xs">{t('common.loading')}</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <ReservedModelSlot id="llmp-default-embedding" label={t('llmProviders.embeddingSlot')} />
          <ReservedModelSlot id="llmp-default-rerank" label={t('llmProviders.rerankSlot')} />
          <Field
            className="sm:col-span-2"
            label={t('llmProviders.decisionSlot')}
            htmlFor="llmp-default-provider"
            hint={t('llmProviders.decisionHint')}
          >
            <div className="grid gap-2 sm:grid-cols-2">
              <Select
                value={decisionProviderId === '' ? NO_DEFAULT : decisionProviderId}
                onValueChange={(v) => {
                  const providerId = v === NO_DEFAULT ? '' : v;
                  setDecisionProviderId(providerId);
                  setDecisionModelId(
                    decisionProviders
                      .find((p) => p.id === providerId)
                      ?.models.find((m) => m.apiKind === 'systemone')?.id ?? '',
                  );
                }}
                disabled={decisionProviders.length === 0}
              >
                <SelectTrigger id="llmp-default-provider">
                  <SelectValue placeholder={t('llmProviders.defaultsPickProvider')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_DEFAULT}>{t('llmProviders.unset')}</SelectItem>
                  {decisionProviders.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                value={decisionModelId === '' ? NO_DEFAULT : decisionModelId}
                onValueChange={(v) => setDecisionModelId(v === NO_DEFAULT ? '' : v)}
                disabled={decisionProviderId === '' || decisionModels.length === 0}
              >
                <SelectTrigger id="llmp-default-model">
                  <SelectValue placeholder={t('llmProviders.defaultsPickModel')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_DEFAULT}>{t('llmProviders.unset')}</SelectItem>
                  {decisionModels.map((m) => (
                    <SelectItem key={m.id} value={m.id} className="font-mono text-xs">
                      {m.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {decisionProviders.length === 0 ? (
              <p className="text-muted-foreground text-xs">
                {t('llmProviders.noDecisionProviders')}
              </p>
            ) : null}
          </Field>
        </div>
      )}
    </FormDialog>
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
  const [apiRows, setApiRows] = useState<ApiRow[]>(() =>
    existing !== undefined ? existing.apis.map(apiRowFrom) : [{ kind: 'anthropic', path: '' }],
  );
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? '');
  const [credentialName, setCredentialName] = useState(existing?.credentialName ?? '');
  const [scope, setScope] = useState<Scope>(existing?.scope ?? 'personal');
  const [rows, setRows] = useState<ModelRow[]>(() => (existing?.models ?? []).map(rowFromModel));
  /** #58-1 — the fetched candidate list; rows are only created by picking/typing. */
  const [candidates, setCandidates] = useState<LlmModelInfo[] | null>(null);
  const [fetching, setFetching] = useState(false);
  const [busy, setBusy] = useState(false);

  const enabledKinds = apiRows.map((r) => r.kind);
  /** The listing arm (null = the row offers no models-list endpoint). */
  const listingKind = listingApiKind(enabledKinds);
  const hasSystemone = enabledKinds.includes('systemone');

  /** Models that still declare a wire — the guard for disabling it. */
  function modelsUsing(kind: ProviderApiKind): string[] {
    return rows.filter((r) => r.apiKind === kind && r.id.trim() !== '').map((r) => r.id.trim());
  }

  function changeApiKind(index: number, kind: ProviderApiKind): void {
    const current = apiRows[index];
    if (current === undefined || current.kind === kind) return;
    const ids = modelsUsing(current.kind);
    if (ids.length > 0) {
      toast.error(t('llmProviders.apiKindInUse', { kind: current.kind, ids: ids.join(', ') }));
      return;
    }
    setApiRows((prev) => prev.map((r, i) => (i === index ? { ...r, kind } : r)));
    // A different wire space means the fetched candidates are stale.
    setCandidates(null);
  }

  function removeApiRow(index: number): void {
    if (apiRows.length === 1) {
      toast.error(t('llmProviders.keepOneWire'));
      return;
    }
    const current = apiRows[index];
    if (current !== undefined) {
      const ids = modelsUsing(current.kind);
      if (ids.length > 0) {
        toast.error(t('llmProviders.apiKindInUse', { kind: current.kind, ids: ids.join(', ') }));
        return;
      }
    }
    setApiRows((prev) => prev.filter((_, i) => i !== index));
    setCandidates(null);
  }

  function addApiRow(): void {
    const used = new Set(apiRows.map((r) => r.kind));
    const kind = API_KINDS.find((k) => !used.has(k));
    if (kind === undefined) return;
    setApiRows((prev) => [...prev, { kind, path: '' }]);
    setCandidates(null);
  }

  /** Validate the editor rows; null = blocked (a toast already said why). */
  function readApis(): ProviderApiEndpointInput[] | null {
    const paths = apiRows.map((r) => ({ kind: r.kind, path: r.path.trim() }));
    if (paths.some((p) => p.path !== '' && !p.path.startsWith('/') && !FULL_URL_RE.test(p.path))) {
      toast.error(t('llmProviders.pathInvalid'));
      return null;
    }
    const systemone = paths.find((p) => p.kind === 'systemone');
    if (systemone !== undefined && baseUrl.trim() === '' && !FULL_URL_RE.test(systemone.path)) {
      toast.error(t('llmProviders.systemoneBaseUrlRequired'));
      return null;
    }
    return paths.map((p) => ({ kind: p.kind, path: p.path === '' ? null : p.path }));
  }

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
    const parsed = rows.map((r) => cleanExtraBody(r.extraBody));
    const cleaned = rows
      .map((r, i) => cleanRow(r, parsed[i]?.value))
      .filter((c): c is CleanModel => c !== null);
    return {
      cleaned,
      warnings: providerModelConfigWarnings(cleaned),
      extraInvalid: parsed.map((p) => p.invalid),
    };
  }, [rows]);

  /**
   * 获取候选 — fetch the endpoint's live model list as SUGGESTIONS for the
   * model-id dropdown (#58-1). Nothing is added to the registry by the fetch
   * itself; rows are created by explicit picking (or typing, as before).
   */
  async function fetchCandidates(): Promise<void> {
    if (listingKind === null) return;
    setFetching(true);
    try {
      const list = await withAuthGuard(() => {
        // Edit mode queries the SAVED row; in create mode the row doesn't
        // exist yet, so the explicit arm spells it out (credential required).
        if (existing !== undefined) {
          return api.queryProviderModels({ providerId: existing.id });
        }
        return api.queryProviderModels({
          api: listingKind,
          ...(baseUrl.trim() !== '' ? { baseUrl: baseUrl.trim() } : {}),
          credentialName,
        });
      }, logout);
      setCandidates(list);
      toast.info(
        list.length > 0
          ? t('llmProviders.candidatesLoadedToast', { count: list.length })
          : t('llmProviders.candidatesNoneToast'),
      );
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
    const apis = readApis();
    if (apis === null) return;
    setBusy(true);
    try {
      if (existing !== undefined) {
        await withAuthGuard(
          () =>
            api.updateLlmProvider(existing.id, {
              name,
              apis,
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
              apis,
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
          <p className="text-muted-foreground max-w-[68ch] text-xs">{t('llmProviders.apiHint')}</p>
          {hasSystemone ? (
            <p className="text-muted-foreground max-w-[68ch] text-xs">
              {t('llmProviders.systemoneBaseUrlHint')}
            </p>
          ) : null}
          {creds !== null && creds.length === 0 ? (
            <p className="text-muted-foreground text-xs">{t('llmProviders.noCredentials')}</p>
          ) : null}

          {/* #95 — the enabled wires (>=1): a kind, an optional path override
              and the resolved endpoint preview. */}
          <div className="flex flex-col gap-3 border-t pt-4">
            <ProviderApisEditor
              rows={apiRows}
              baseUrl={baseUrl}
              onKindChange={changeApiKind}
              onPathChange={(index, path) =>
                setApiRows((prev) => prev.map((r, i) => (i === index ? { ...r, path } : r)))
              }
              onAdd={addApiRow}
              onRemove={removeApiRow}
            />
          </div>

          {/* #51 — the model REGISTRY. Curated here (full replace on save);
              machine pages pick from it instead of re-discovering. */}
          <div className="flex flex-col gap-3 border-t pt-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="text-sm font-medium">{t('llmProviders.modelsTitle')}</p>
                <p className="text-muted-foreground text-xs">{t('llmProviders.modelsDesc')}</p>
              </div>
              <div className="flex shrink-0 gap-2">
                {/* #95 — the listing arm is derived from the enabled wires;
                    systemone-only rows have no models-list endpoint. */}
                {listingKind === null ? null : (
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
                )}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setRows((prev) => [...prev, emptyModelRow(apiRows[0]?.kind ?? 'anthropic')])
                  }
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
                    row={row}
                    enabledKinds={enabledKinds}
                    candidates={candidates}
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
