import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  LayersIcon,
  PlusIcon,
  TrashIcon,
  GlobeIcon,
  UserIcon,
  TerminalIcon,
  PencilIcon,
} from 'lucide-react';
import { api } from '@/api';
import { PageSlot } from '@/components/shell/page-slots';
import { PageAction } from '@/components/shell/page-action';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n, type TranslationKey } from '@/i18n';
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
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { FormDialog } from '@/components/ui/form-dialog';
import {
  CommandLine,
  ConfirmDialog,
  DataTable,
  FilterBar,
  FilterSelect,
  PageIntro,
  Panel,
  PanelBody,
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
import { MoreHorizontalIcon } from 'lucide-react';
import {
  HarnessNexusError,
  type Profile,
  type ProfileEntryInput,
  type McpServer,
  type Resource,
  type ResourceKind,
  type AgentTarget,
} from '@harness-nexus/sdk';

type Scope = 'global' | 'personal';

/** A stored profile entry row (the domain shape) — used when carrying
 * pinnedVersion/installOptions over from the profile being edited. */
type ProfileEntryRow = Profile['entries'][number];

/**
 * Fetch the MCP servers + resources the caller can see — the entry-checkbox
 * universe for both the create and the edit dialogs (independent → Promise.all).
 * Soft-deleted rows are included so the EDIT dialog can grey them out; the
 * create dialog simply shows them disabled (they cannot be re-added).
 */
function useEntryLists(): {
  servers: McpServer[] | null;
  resources: Resource[] | null;
} {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [resources, setResources] = useState<Resource[] | null>(null);
  useEffect(() => {
    Promise.all([
      api.listMcpServers({ includeDeleted: true }),
      api.listResources({ includeDeleted: true }),
    ])
      .then(([s, r]) => {
        setServers(s);
        setResources(r);
      })
      .catch(() => {
        setServers([]);
        setResources([]);
      });
  }, []);
  return { servers, resources };
}

/** Toggle one id in a Set — functional setState (Vercel React rules). */
function toggleIn(setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string): void {
  setter((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
}

/**
 * Build the PATCH entries from the checkbox state. Still-selected ids that
 * already had a row keep their pinnedVersion/installOptions. Soft-deleted
 * targets (two-stage delete) and ids absent from the fetched lists drop out —
 * saving self-heals dead references instead of 409-ing forever.
 */
function buildEntries(
  originals: ProfileEntryRow[],
  servers: McpServer[],
  resources: Resource[],
  selectedServers: Set<string>,
  selectedResources: Set<string>,
): ProfileEntryInput[] {
  const liveIds = (rows: Array<{ id: string; deletedAt?: string }>): Set<string> =>
    new Set(rows.filter((x) => x.deletedAt === undefined).map((x) => x.id));
  const liveServers = liveIds(servers);
  const liveResources = liveIds(resources);
  const extrasFor = (id: string) => {
    const o = originals.find((e) => e.resourceId === id);
    return {
      ...(o?.pinnedVersion ? { pinnedVersion: o.pinnedVersion } : {}),
      ...(o?.installOptions && o.kind !== 'mcp'
        ? { installOptions: o.installOptions as Record<string, unknown> }
        : {}),
    };
  };
  return [
    ...[...selectedServers]
      .filter((id) => liveServers.has(id))
      .map((mcpServerId) => ({ mcpServerId, ...extrasFor(mcpServerId) })),
    ...[...selectedResources]
      .filter((id) => liveResources.has(id))
      .map((resourceId) => ({
        resourceId,
        kind: resources.find((r) => r.id === resourceId)!.kind as NonMcpKind,
        ...extrasFor(resourceId),
      })),
  ];
}

/** Shared entry checkboxes: MCP servers + one fieldset per resource kind. */
function EntryPickers({
  servers,
  resources,
  selectedServers,
  selectedResources,
  onToggleServer,
  onToggleResource,
}: {
  servers: McpServer[] | null;
  resources: Resource[] | null;
  selectedServers: Set<string>;
  selectedResources: Set<string>;
  onToggleServer: (id: string) => void;
  onToggleResource: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">{t('profiles.serversLegend')}</legend>
        {servers === null ? (
          <p className="text-muted-foreground text-sm">{t('profiles.loadingServers')}</p>
        ) : servers.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('profiles.noServers')}</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {servers.map((s) => (
              <label
                key={s.id}
                className={`border-border flex items-center gap-2.5 rounded-md border px-3 py-2 text-sm${
                  s.deletedAt !== undefined ? ' text-muted-foreground opacity-60' : ''
                }`}
              >
                <input
                  type="checkbox"
                  checked={s.deletedAt === undefined && selectedServers.has(s.id)}
                  onChange={() => onToggleServer(s.id)}
                  disabled={s.deletedAt !== undefined}
                  className="size-4"
                />
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
                {s.deletedAt !== undefined ? (
                  <span className="font-mono text-[10px]">{t('profiles.deletedEntry')}</span>
                ) : (
                  <span className="text-muted-foreground font-mono text-[10px]">
                    {s.transport.type}
                  </span>
                )}
              </label>
            ))}
          </div>
        )}
      </fieldset>

      {RESOURCE_KINDS.map((kind) => {
        const of = (resources ?? []).filter((r) => r.kind === kind);
        return (
          <fieldset key={kind} className="grid gap-2">
            <legend className="text-sm font-medium">
              {t(KIND_LEGEND[kind])}
              <span className="text-muted-foreground ml-1.5 text-xs font-normal">
                {t('profiles.visibleCount', { count: of.length })}
              </span>
            </legend>
            {resources === null ? (
              <p className="text-muted-foreground text-sm">{t('common.loading')}</p>
            ) : of.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('profiles.noneInResources')}</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {of.map((r) => (
                  <label
                    key={r.id}
                    className={`border-border flex items-center gap-2.5 rounded-md border px-3 py-2 text-sm${
                      r.deletedAt !== undefined ? ' text-muted-foreground opacity-60' : ''
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={r.deletedAt === undefined && selectedResources.has(r.id)}
                      onChange={() => onToggleResource(r.id)}
                      disabled={r.deletedAt !== undefined}
                      className="size-4"
                    />
                    <span className="min-w-0 flex-1 truncate">{r.name}</span>
                    <span className="text-muted-foreground font-mono text-[10px]">
                      {r.deletedAt !== undefined ? t('profiles.deletedEntry') : r.key}
                    </span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>
        );
      })}
    </>
  );
}

/** The Agent targets a profile can be shaped for (Phase 3.2 + codex + 8 T1). */
const TARGETS: AgentTarget[] = [
  'claude-code',
  'hermes',
  'codex',
  'deepseek',
  'pi',
  'zcode',
  'generic',
];

/** Non-mcp resource kinds a profile entry can reference (Phase 3.5). */
const RESOURCE_KINDS: NonMcpKind[] = ['skill', 'rule', 'command', 'sub_agent', 'hook'];

/** The list's vocabulary (07-p3-list-pages.md §5). */
const PROFILE_SPEC: ListQuerySpec = {
  filters: { target: TARGETS, scope: ['personal', 'global'] },
  sort: ['-updated', 'name'],
};
/**
 * The kind domain a `{resourceId, kind}` entry accepts — 'mcp' is excluded
 * (MCP servers enter via the mcpServerId arm). Safe to assert: kind:'mcp'
 * resources cannot exist (`AVAILABLE_KINDS` gate on the server).
 */
type NonMcpKind = Exclude<ResourceKind, 'mcp'>;

/** Fieldset legend per entry kind (values rendered verbatim — never derived). */
const KIND_LEGEND: Record<NonMcpKind, TranslationKey> = {
  skill: 'profiles.kindSkills',
  rule: 'profiles.kindRules',
  command: 'profiles.kindCommands',
  sub_agent: 'profiles.kindSubAgents',
  hook: 'profiles.kindHooks',
};

export function ProfilesPage() {
  const { logout, user } = useAuth();
  const { t } = useI18n();
  const [items, setItems] = useState<Profile[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Profile | null>(null);
  const [pending, setPending] = useState<Profile | null>(null);
  const [busy, setBusy] = useState(false);
  const isAdmin = user?.role === 'admin';

  async function refresh() {
    try {
      setItems(await withAuthGuard(() => api.listProfiles(), logout));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const query = useListQuery(PROFILE_SPEC);
  const visible = useMemo(() => {
    if (items === null) return null;
    const rows = items.filter(
      (p) =>
        matchesQuery(query.q, [p.name, p.description, p.target]) &&
        (query.filters['target'] === null || p.target === query.filters['target']) &&
        (query.filters['scope'] === null || p.scope === query.filters['scope']),
    );
    return sortRows(rows, effectiveSort(PROFILE_SPEC, query), (p, key) =>
      key === 'name' ? p.name : p.updatedAt,
    );
  }, [items, query.q, query.filters, query.sort]);

  const targetLabels = useMemo(
    () => Object.fromEntries(TARGETS.map((target) => [target, target])),
    [],
  );
  const scopeLabels = useMemo(
    () => ({ personal: t('common.scopePersonal'), global: t('common.scopeGlobal') }),
    [t],
  );
  const sortLabels = useMemo(
    () => ({ '-updated': t('common.sortUpdated'), name: t('common.sortName') }),
    [t],
  );

  async function confirmRemove() {
    const p = pending;
    if (p === null) return;
    setBusy(true);
    try {
      await withAuthGuard(() => api.deleteProfile(p.id), logout);
      toast.success(t('profiles.deleted'));
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

      <PageIntro sub={<>{t('profiles.subtitle')}</>} />

      {user && (
        <Panel
          className="mb-6 border-dashed"
          label={t('profiles.installTitle')}
          icon={<TerminalIcon />}
        >
          <PanelBody className="flex flex-col gap-3">
            <p className="text-muted-foreground max-w-[68ch] text-xs">
              {t('profiles.installDescBefore')}{' '}
              <Well variant="chip" copy="claude-code">
                claude-code
              </Well>{' '}
              {t('profiles.installDescAfter')}
            </p>
            <CommandLine
              command={`claude plugin marketplace add <server>/api/marketplace/<marketplace-token>/marketplace.json
claude plugin install <profile-name>@harness-nexus-${user.username.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
              note={
                <span>
                  {t('profiles.installNoteBefore')}
                  <a className="text-signal underline-offset-4 hover:underline" href="/tokens">
                    {t('profiles.manageTokens')}
                  </a>
                  {t('profiles.installNoteAfter')}
                </span>
              }
            />
          </PanelBody>
        </Panel>
      )}

      <DataTable
        columns={5}
        label={t('profiles.title')}
        icon={<LayersIcon />}
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
            <TableSearch query={query} placeholder={t('profiles.searchPlaceholder')} />
            <FilterSelect
              query={query}
              spec={PROFILE_SPEC}
              name="target"
              allLabel={t('profiles.allTargets')}
              labels={targetLabels}
            />
            <FilterSelect
              query={query}
              spec={PROFILE_SPEC}
              name="scope"
              allLabel={t('common.allScopes')}
              labels={scopeLabels}
            />
            <SortSelect
              query={query}
              spec={PROFILE_SPEC}
              label={t('common.sortLabel')}
              labels={sortLabels}
            />
          </FilterBar>
        }
        empty={{
          title: t('profiles.noProfiles'),
          hint: t('profiles.emptyHint'),
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
            <TableHead>{t('profiles.target')}</TableHead>
            <TableHead>{t('profiles.entries')}</TableHead>
            <TableHead>{t('common.scope')}</TableHead>
            <TableHead className="text-right">{t('common.actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible?.map((p) => (
            <TableRow key={p.id}>
              <TableCell>
                <div className="font-medium">
                  {p.name}{' '}
                  <span className="text-muted-foreground font-mono text-[10px]">v{p.version}</span>
                </div>
                {p.description && (
                  <div className="text-muted-foreground mt-0.5 text-xs">{p.description}</div>
                )}
              </TableCell>
              <TableCell>
                {/* Neutral Badge: target encodes intent, not connection state
                    (Signal system reserves --signal for liveness). */}
                <Badge variant="secondary" className="font-mono text-[11px]">
                  {p.target}
                </Badge>
              </TableCell>
              <TableCell className="text-muted-foreground tabular-nums">
                {p.entries.length}
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
                    <Button variant="ghost" size="icon" className="size-8">
                      <MoreHorizontalIcon className="size-4" />
                      <span className="sr-only">{t('common.openMenu')}</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      disabled={p.scope === 'global' && !isAdmin}
                      onClick={() => setEditing(p)}
                    >
                      <PencilIcon /> {t('common.edit')}
                    </DropdownMenuItem>
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
          title={t('profiles.deleteAction')}
          consequence={t('profiles.deleteConsequence')}
          impact={[
            { label: 'profile', value: pending.name },
            { label: 'target', value: pending.target },
            { label: 'entries', value: pending.entries.length },
          ]}
          actionLabel={t('profiles.deleteAction')}
          busy={busy}
          onConfirm={() => void confirmRemove()}
        />
      ) : null}

      {creating ? (
        <CreateProfile
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void refresh();
          }}
        />
      ) : null}

      {editing ? (
        <EditProfile
          profile={editing}
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
 * Edit dialog: name / description + the entry checkboxes — `target` is
 * immutable post-create, and the version is server-assigned (#18): it bumps
 * automatically (decimal, carry at 16) when — and only when — the entries
 * change, because for marketplace installs the bump IS the publish switch
 * Claude Code's `plugin update` reacts to.
 */
function EditProfile({
  profile,
  onClose,
  onSaved,
}: {
  profile: Profile;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { logout } = useAuth();
  const { t } = useI18n();
  const [name, setName] = useState(profile.name);
  const [description, setDescription] = useState(profile.description ?? '');
  const [busy, setBusy] = useState(false);
  const { servers, resources } = useEntryLists();
  // Preselect from the stored entries: mcp rows reference McpServer.ids,
  // everything else references Resource.ids (3.5's two arms).
  const [selectedServers, setSelectedServers] = useState<Set<string>>(
    () => new Set(profile.entries.filter((e) => e.kind === 'mcp').map((e) => e.resourceId)),
  );
  const [selectedResources, setSelectedResources] = useState<Set<string>>(
    () => new Set(profile.entries.filter((e) => e.kind !== 'mcp').map((e) => e.resourceId)),
  );

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await withAuthGuard(
        () =>
          api.updateProfile(profile.id, {
            name,
            ...(description ? { description } : {}),
            entries: buildEntries(
              profile.entries,
              servers ?? [],
              resources ?? [],
              selectedServers,
              selectedResources,
            ),
          }),
        logout,
      );
      toast.success(t('profiles.updated'));
      onSaved();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.saveFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <FormDialog
        open
        onClose={onClose}
        title={t('profiles.editTitle')}
        description={t('profiles.editDesc')}
        size="xl"
      >
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-3">
            {/* content-start: the version cell carries a hint <p>, and without
              it the default align-content:stretch distributes that extra
              height into the OTHER cells' rows — pushing their inputs down
              out of the row (the #6 alignment bug). */}
            <div className="grid content-start gap-2">
              <Label htmlFor="prof-edit-name">{t('common.name')}</Label>
              <Input
                id="prof-edit-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                required
              />
            </div>
            <div className="grid content-start gap-2">
              <Label htmlFor="prof-edit-desc">{t('common.description')}</Label>
              <Input
                id="prof-edit-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('profiles.optional')}
                autoComplete="off"
              />
            </div>
            <div className="grid content-start gap-2">
              <Label>{t('profiles.versionLabel')}</Label>
              {/* The version is read-only protocol data inside a form of
                  editable controls — the same well material as the inputs beside
                  it, at the same density height (a hand-rolled
                  `bg-muted h-9 rounded-md` box was unreachable for skins). */}
              <Well
                variant="text"
                copy={profile.version}
                className="flex h-(--control-h) w-full items-center px-2.5 text-sm"
              >
                {profile.version}
              </Well>
              <p className="text-muted-foreground text-xs">{t('profiles.versionHint')}</p>
            </div>
          </div>

          <EntryPickers
            servers={servers}
            resources={resources}
            selectedServers={selectedServers}
            selectedResources={selectedResources}
            onToggleServer={(id) => toggleIn(setSelectedServers, id)}
            onToggleResource={(id) => toggleIn(setSelectedResources, id)}
          />

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? t('common.saving') : t('common.save')}
            </Button>
          </div>
        </form>
      </FormDialog>
    </>
  );
}

function CreateProfile({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { logout, user } = useAuth();
  const { t } = useI18n();
  const isAdmin = user?.role === 'admin';
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState<Scope>('personal');
  const [target, setTarget] = useState<AgentTarget>('generic');
  const [selectedServers, setSelectedServers] = useState<Set<string>>(new Set());
  const [selectedResources, setSelectedResources] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const { servers, resources } = useEntryLists();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      // Mixed entry arms (Phase 3.5): mcpServerId for MCP, {resourceId, kind}
      // for everything else — exactly the two REST shapes.
      const entries = buildEntries(
        [],
        servers ?? [],
        resources ?? [],
        selectedServers,
        selectedResources,
      );
      await withAuthGuard(
        () =>
          api.createProfile({
            name,
            target,
            ...(description ? { description } : {}),
            scope,
            entries,
          }),
        logout,
      );
      toast.success(t('profiles.created'));
      onCreated();
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
        title={t('profiles.addTitle')}
        description={t('profiles.addDesc')}
        size="xl"
      >
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-4">
            <div className="grid gap-2">
              <Label htmlFor="prof-name">{t('common.name')}</Label>
              <Input
                id="prof-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('profiles.namePlaceholder')}
                autoComplete="off"
                spellCheck={false}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="prof-target">{t('profiles.target')}</Label>
              <Select value={target} onValueChange={(v) => setTarget(v as AgentTarget)}>
                <SelectTrigger id="prof-target">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TARGETS.map((target) => (
                    <SelectItem key={target} value={target}>
                      {target}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="prof-desc">{t('common.description')}</Label>
              <Input
                id="prof-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('profiles.optional')}
                autoComplete="off"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="prof-scope">{t('common.scope')}</Label>
              <Select value={scope} onValueChange={(v) => setScope(v as Scope)} disabled={!isAdmin}>
                <SelectTrigger id="prof-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="personal">{t('common.scopePersonal')}</SelectItem>
                  <SelectItem value="global" disabled={!isAdmin}>
                    {t('common.scopeGlobal')}
                    {!isAdmin && t('profiles.adminSuffix')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <EntryPickers
            servers={servers}
            resources={resources}
            selectedServers={selectedServers}
            selectedResources={selectedResources}
            onToggleServer={(id) => toggleIn(setSelectedServers, id)}
            onToggleResource={(id) => toggleIn(setSelectedResources, id)}
          />

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={busy || (selectedServers.size === 0 && selectedResources.size === 0)}
            >
              {busy ? t('profiles.creating') : t('profiles.createProfile')}
            </Button>
          </div>
        </form>
      </FormDialog>
    </>
  );
}
