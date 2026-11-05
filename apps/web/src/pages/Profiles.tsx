// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { LayersIcon, PlusIcon, TrashIcon, TerminalIcon, PencilIcon } from 'lucide-react';
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  CommandLine,
  ConfirmDialog,
  DataTable,
  FilterBar,
  FilterSelect,
  PageIntro,
  Panel,
  PanelBody,
  ScopeBadge,
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
import { cn } from '@/lib/utils';
import { ChevronRightIcon, ListChecksIcon, MoreHorizontalIcon } from 'lucide-react';
import {
  BUILTIN_MCP_SERVICE_ID,
  HarnessNexusError,
  type Profile,
  type ProfileEntryInput,
  type McpServer,
  type McpToolInfo,
  type Resource,
  type ResourceKind,
  type AgentTarget,
} from '@harness-nexus/sdk';

type Scope = 'global' | 'personal';

/** A stored profile entry row (the domain shape) — used when carrying
 * pinnedVersion/installOptions over from the profile being edited. */
type ProfileEntryRow = Profile['entries'][number];

/**
 * Per-server tool selection (#113): `'all'` = whole server (the entry follows
 * the upstream's toolset), a non-empty Set = pinned allow-set of the
 * upstream's OWN tool names. An empty Set is a transient editing state only —
 * it is stored as `'all'` (the schema rejects empty arrays).
 */
type ServerTools = 'all' | ReadonlySet<string>;

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
 * saving self-heals dead references instead of 409-ing forever. A server
 * whose picker holds a non-empty pinned set carries it as `tools` (#113); an
 * empty transient set or 'all' stores nothing (whole-server semantics).
 */
function buildEntries(
  originals: ProfileEntryRow[],
  servers: McpServer[],
  resources: Resource[],
  selectedServers: Set<string>,
  selectedResources: Set<string>,
  serverTools: Map<string, ServerTools>,
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
  const toolsFor = (id: string) => {
    const picked = serverTools.get(id);
    return picked instanceof Set && picked.size > 0 ? { tools: [...picked] } : {};
  };
  return [
    ...[...selectedServers]
      // #107 — the built-in service has no row but is always a live pick.
      .filter((id) => id === BUILTIN_MCP_SERVICE_ID || liveServers.has(id))
      .map((mcpServerId) => ({ mcpServerId, ...extrasFor(mcpServerId), ...toolsFor(mcpServerId) })),
    ...[...selectedResources]
      .filter((id) => liveResources.has(id))
      .map((resourceId) => ({
        resourceId,
        kind: resources.find((r) => r.id === resourceId)!.kind as NonMcpKind,
        ...extrasFor(resourceId),
      })),
  ];
}

/**
 * One server's per-tool picker (#113) — an INLINE expansion under the checked
 * row (a Collapsible in the dialog's own flow, deliberately NOT a Popover:
 * a portal layer re-anchors on every click — the trigger label's width
 * changes as the count updates — and taps land on the content underneath).
 * Expanded, it shows the two modes (whole-server / pinned subset) and a
 * fixed-height scrolling checklist. The tool list is fetched lazily on first
 * expand (visibility-gated since #114, so any viewer of the row can read it);
 * a disconnected or unreachable upstream shows a hint and the entry stays
 * editable as whole-server.
 */
function ServerToolPicker({
  serverId,
  selection,
  onChange,
}: {
  serverId: string;
  selection: ServerTools;
  onChange: (id: string, sel: ServerTools) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [tools, setTools] = useState<McpToolInfo[] | null>(null);
  const pinned = selection instanceof Set ? selection : null;

  // Lazy fetch on first expand, cached for the dialog's lifetime.
  useEffect(() => {
    if (!open || tools !== null) return;
    let cancelled = false;
    const load =
      serverId === BUILTIN_MCP_SERVICE_ID
        ? api
            .getBuiltinMcpService()
            .then((b) => b.tools)
            .catch(() => [])
        : api.listMcpServerTools(serverId).catch(() => []);
    void load.then((list) => {
      if (!cancelled) setTools(list);
    });
    return () => {
      cancelled = true;
    };
  }, [open, tools, serverId]);

  function toggleTool(name: string) {
    const next = new Set(pinned);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    // Un-picking everything falls back to whole-server (empty arrays are
    // rejected by the schema; "nothing" means removing the entry).
    onChange(serverId, next.size > 0 ? next : 'all');
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1.5 text-xs"
        >
          <ChevronRightIcon className={cn('size-3 transition-transform', open && 'rotate-90')} />
          <ListChecksIcon className="size-3.5" />
          {pinned === null
            ? t('profiles.toolsAll')
            : t('profiles.toolsPicked', { count: pinned.size })}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-border mt-1.5 flex flex-col gap-2.5 rounded-md border bg-muted/30 p-2.5">
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`tools-${serverId}`}
                checked={pinned === null}
                onChange={() => onChange(serverId, 'all')}
                className="size-4"
              />
              {t('profiles.toolsFollow')}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`tools-${serverId}`}
                checked={pinned !== null}
                onChange={() => onChange(serverId, new Set())}
                className="size-4"
              />
              {t('profiles.toolsPin')}
            </label>
          </div>
          {pinned !== null ? (
            tools === null ? (
              <p className="text-muted-foreground text-xs">{t('common.loading')}</p>
            ) : tools.length === 0 ? (
              <p className="text-muted-foreground text-xs">{t('profiles.toolsUnavailable')}</p>
            ) : (
              <div className="border-border max-h-52 overflow-y-auto rounded-md border bg-background">
                {tools.map((tool) => (
                  <label
                    key={tool.name}
                    className="hover:bg-muted/40 flex cursor-pointer items-start gap-2 border-border border-b px-2 py-1.5 text-xs last:border-b-0"
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 size-3.5"
                      checked={pinned.has(tool.name)}
                      onChange={() => toggleTool(tool.name)}
                    />
                    <span className="min-w-0 flex-1">
                      <code className="text-foreground break-all">{tool.name}</code>
                      {tool.description ? (
                        // line-clamp-1 carries its own -webkit-box display —
                        // adding `block` would override it (`.block` sorts
                        // AFTER `.line-clamp-*` in the built sheet) and
                        // silently unclamp the paragraph.
                        <span className="text-muted-foreground mt-0.5 line-clamp-1">
                          {tool.description}
                        </span>
                      ) : null}
                    </span>
                  </label>
                ))}
              </div>
            )
          ) : null}
          <p className="text-muted-foreground text-xs">{t('profiles.toolsHint')}</p>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Shared entry checkboxes: MCP servers (each with a #113 tool picker when
 * checked) + one fieldset per resource kind. */
function EntryPickers({
  servers,
  resources,
  selectedServers,
  selectedResources,
  serverTools,
  onToggleServer,
  onToggleResource,
  onServerTools,
}: {
  servers: McpServer[] | null;
  resources: Resource[] | null;
  selectedServers: Set<string>;
  selectedResources: Set<string>;
  serverTools: Map<string, ServerTools>;
  onToggleServer: (id: string) => void;
  onToggleResource: (id: string) => void;
  onServerTools: (id: string, sel: ServerTools) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <fieldset className="grid gap-2">
        <legend className="text-sm font-medium">{t('profiles.serversLegend')}</legend>
        {servers === null ? (
          <p className="text-muted-foreground text-sm">{t('profiles.loadingServers')}</p>
        ) : (
          <div className="grid items-start gap-2 sm:grid-cols-2">
            {/* #107 — the built-in service: pinned first, always available
             * (no row, never soft-deleted); opting in is what exposes the
             * platform's native tools to this profile's agents. #113 — its
             * notes toolset is selectable like any upstream's. */}
            <div className="border-border grid gap-1 rounded-md border px-3 py-2 text-sm">
              <label className="flex items-center gap-2.5">
                <input
                  type="checkbox"
                  checked={selectedServers.has(BUILTIN_MCP_SERVICE_ID)}
                  onChange={() => onToggleServer(BUILTIN_MCP_SERVICE_ID)}
                  className="size-4"
                />
                <span className="min-w-0 flex-1 truncate">{t('mcp.builtinName')}</span>
                <span className="text-muted-foreground font-mono text-[10px]">built-in</span>
              </label>
              {selectedServers.has(BUILTIN_MCP_SERVICE_ID) ? (
                <ServerToolPicker
                  serverId={BUILTIN_MCP_SERVICE_ID}
                  selection={serverTools.get(BUILTIN_MCP_SERVICE_ID) ?? 'all'}
                  onChange={onServerTools}
                />
              ) : null}
            </div>
            {servers.map((s) => {
              const checked = s.deletedAt === undefined && selectedServers.has(s.id);
              return (
                <div
                  key={s.id}
                  className={`border-border grid gap-1 rounded-md border px-3 py-2 text-sm${
                    s.deletedAt !== undefined ? ' text-muted-foreground opacity-60' : ''
                  }`}
                >
                  <label className="flex items-center gap-2.5">
                    <input
                      type="checkbox"
                      checked={checked}
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
                  {checked ? (
                    <ServerToolPicker
                      serverId={s.id}
                      selection={serverTools.get(s.id) ?? 'all'}
                      onChange={onServerTools}
                    />
                  ) : null}
                </div>
              );
            })}
            {servers.length === 0 ? (
              <p className="text-muted-foreground text-sm sm:col-span-2">
                {t('profiles.noServers')}
              </p>
            ) : null}
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
                  {p.name} <span className="text-muted-foreground role-data-sm">v{p.version}</span>
                </div>
                {p.description && (
                  <div className="text-muted-foreground mt-0.5 text-xs">{p.description}</div>
                )}
              </TableCell>
              <TableCell>
                {/* Neutral Badge: target encodes intent, not connection state
                    (Signal system reserves --signal for liveness). */}
                <Badge variant="secondary" className="role-data-sm">
                  {p.target}
                </Badge>
              </TableCell>
              <TableCell className="text-muted-foreground tabular-nums">
                {p.entries.length}
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
  // everything else references Resource.ids (3.5's two arms). Pinned tool
  // sets (#113) come along the same way.
  const [selectedServers, setSelectedServers] = useState<Set<string>>(
    () => new Set(profile.entries.filter((e) => e.kind === 'mcp').map((e) => e.resourceId)),
  );
  const [selectedResources, setSelectedResources] = useState<Set<string>>(
    () => new Set(profile.entries.filter((e) => e.kind !== 'mcp').map((e) => e.resourceId)),
  );
  const [serverTools, setServerTools] = useState<Map<string, ServerTools>>(
    () =>
      new Map(
        profile.entries
          .filter((e) => e.kind === 'mcp' && e.tools !== undefined)
          .map((e) => [e.resourceId, new Set(e.tools) as ServerTools]),
      ),
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
              serverTools,
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
        {/* select-none: picking an entry/picker option changes the dialog's
         * height mid-click — between mousedown and mouseup the text under the
         * cursor shifts, and a browser reads that as a text-selection drag.
         * Form INPUTS stay selectable regardless (user-select only gates
         * static text); everything worth copying here has a copy affordance. */}
        <form onSubmit={onSubmit} className="flex flex-col gap-4 select-none">
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
            serverTools={serverTools}
            onToggleServer={(id) => toggleIn(setSelectedServers, id)}
            onToggleResource={(id) => toggleIn(setSelectedResources, id)}
            onServerTools={(id, sel) =>
              setServerTools((prev) => {
                const next = new Map(prev);
                next.set(id, sel);
                return next;
              })
            }
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
  const [serverTools, setServerTools] = useState<Map<string, ServerTools>>(new Map());
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
        serverTools,
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
        {/* select-none for the same mid-click height-shift reason as the edit
         * dialog above (no drag-selection when the layout moves under the
         * cursor). */}
        <form onSubmit={onSubmit} className="flex flex-col gap-4 select-none">
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
            serverTools={serverTools}
            onToggleServer={(id) => toggleIn(setSelectedServers, id)}
            onToggleResource={(id) => toggleIn(setSelectedResources, id)}
            onServerTools={(id, sel) =>
              setServerTools((prev) => {
                const next = new Map(prev);
                next.set(id, sel);
                return next;
              })
            }
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
