import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  GlobeIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlugZapIcon,
  PlusIcon,
  RefreshCwIcon,
  TrashIcon,
  UserIcon,
} from 'lucide-react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n } from '@/i18n';
import {
  ConfirmDialog,
  DataTable,
  FilterBar,
  FilterSelect,
  PageIntro,
  SortSelect,
  TableSearch,
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
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
  type CredentialView,
  type LlmModelInfo,
  type LlmProviderView,
  type ProviderApiKind,
} from '@harness-nexus/sdk';

type Scope = 'global' | 'personal';

const API_KINDS: ProviderApiKind[] = ['openai-chat', 'openai-responses', 'anthropic'];

/** The list's vocabulary (07-p3-list-pages.md §5). */
const PROVIDER_SPEC: ListQuerySpec = {
  filters: { api: API_KINDS, scope: ['personal', 'global'] },
  sort: ['name', '-updated'],
};

/**
 * LLM provider management (Phase 9 W10) — cc-switch-style reusable routes.
 * The provider is the ROUTE; the API key lives in the referenced credential.
 */
export function LlmProvidersPage() {
  const { logout, user } = useAuth();
  const { t } = useI18n();
  const [items, setItems] = useState<LlmProviderView[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<LlmProviderView | null>(null);
  const [modelsOf, setModelsOf] = useState<LlmProviderView | null>(null);
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
        <Button onClick={() => setCreating(true)}>
          <PlusIcon className="size-4" />
          {t('common.create')}
        </Button>
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
              <TableCell className="font-medium">{p.name}</TableCell>
              <TableCell>
                <Badge variant="outline" className="font-mono text-[10px]">
                  {p.api}
                </Badge>
              </TableCell>
              <TableCell className="max-w-64 truncate font-mono text-xs">
                {p.baseUrl ?? t('llmProviders.baseUrlPlaceholder')}
              </TableCell>
              <TableCell className="font-mono text-xs">{p.credentialName}</TableCell>
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
                    <Button variant="ghost" size="icon" className="size-8">
                      <MoreHorizontalIcon className="size-4" />
                      <span className="sr-only">{t('common.openMenu')}</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setModelsOf(p)}>
                      <RefreshCwIcon /> {t('llmProviders.fetchModels')}
                    </DropdownMenuItem>
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
      {modelsOf !== null ? (
        <ModelsDialog provider={modelsOf} onClose={() => setModelsOf(null)} />
      ) : null}
    </>
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
                placeholder="e.g. team-gateway"
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
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={busy || credentialName === ''}>
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

/** 获取模型 — the discovered model list of one provider (server-side fetch). */
function ModelsDialog({ provider, onClose }: { provider: LlmProviderView; onClose: () => void }) {
  const { logout } = useAuth();
  const { t } = useI18n();
  const [models, setModels] = useState<LlmModelInfo[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setModels(null);
    setFailed(false);
    void (async () => {
      try {
        const list = await withAuthGuard(
          () => api.queryProviderModels({ providerId: provider.id }),
          logout,
        );
        if (!cancelled) setModels(list);
      } catch (e) {
        if (!cancelled) {
          setFailed(true);
          toast.error(
            e instanceof HarnessNexusError ? e.message : t('llmProviders.fetchModelsFailed'),
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [provider.id]);

  return (
    <>
      <FormDialog
        open
        onClose={onClose}
        title={t('llmProviders.fetchModelsTitle', { name: provider.name })}
        description={t('llmProviders.fetchModelsDesc')}
      >
        {models === null ? (
          <p className="text-muted-foreground py-6 text-center text-sm">
            {failed ? t('llmProviders.fetchModelsFailed') : t('llmProviders.fetchingModels')}
          </p>
        ) : models.length === 0 ? (
          <p className="text-muted-foreground py-6 text-center text-sm">
            {t('llmProviders.fetchModelsEmpty')}
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-muted-foreground text-xs">
              {t('llmProviders.fetchedCount', { count: models.length })}
            </p>
            <ul className="border-border max-h-72 divide-y overflow-y-auto rounded-md border">
              {models.map((m) => (
                <li key={m.id} className="flex items-baseline justify-between gap-3 px-3 py-1.5">
                  <span className="font-mono text-xs">{m.id}</span>
                  {m.name !== undefined ? (
                    <span className="text-muted-foreground truncate text-xs">{m.name}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        )}
      </FormDialog>
    </>
  );
}
