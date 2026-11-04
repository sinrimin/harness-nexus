// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import {
  ServerIcon,
  PlusIcon,
  TrashIcon,
  MoreHorizontalIcon,
  FileJsonIcon,
  ChevronRightIcon,
  RefreshCwIcon,
  PlugIcon,
  PlugZapIcon,
  LoaderIcon,
  PencilIcon,
} from 'lucide-react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n } from '@/i18n';
import {
  ConfirmDialog,
  DataTable,
  FilterBar,
  FilterSelect,
  Lamp,
  PageIntro,
  ScopeBadge,
  TableSearch,
  Well,
  tableState,
} from '@/components/kit';
import { cn } from '@/lib/utils';
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
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { FormDialog } from '@/components/ui/form-dialog';
import {
  HarnessNexusError,
  resolveDialSite,
  transportPlaceholderNames,
  type McpServer,
  type DialSite,
  type McpServerStatus,
  type McpToolInfo,
  type BuiltinMcpService,
  type CredentialView,
} from '@harness-nexus/sdk';

type Scope = 'global' | 'personal';
type TransportType = 'sse' | 'streamable-http' | 'stdio';

/**
 * The list's vocabulary (07-p3-list-pages.md §5). `dial` is derived the same way
 * the row derives it (`resolveDialSite` — `auto` resolved from the credential's
 * distributability), so the filter and the badge never disagree.
 */
const MCP_SPEC: ListQuerySpec = {
  filters: {
    transport: ['sse', 'streamable-http', 'stdio'],
    scope: ['personal', 'global'],
    dial: ['server', 'client'],
  },
  sort: ['name'],
};

/** Status poll interval for the live connection state (Phase 2.4). */
const STATUS_POLL_MS = 5000;

/** The three `transport.type` values, for the toolbar's vocabulary. */
const TRANSPORT_TYPES: TransportType[] = ['stdio', 'sse', 'streamable-http'];

/**
 * Status → color token map. Color encodes connection STATE ONLY (Signal design
 * system rule): `--ok` green = live, `--danger` red = failed (the management
 * page is an operator diagnostics surface, so error gets the stronger danger
 * token rather than warn — distinguishes a hard failure from the transient
 * `connecting` amber), `--warn` amber = connecting, muted = idle. `--signal`
 * (cyan) is deliberately NOT used here — it is reserved for liveness/links.
 * Hoisted to module scope (static config, per the React perf rule in AGENTS.md).
 */
/** Location/launch info shown for a row, per transport shape. */
function endpointOf(s: McpServer): string {
  if (s.transport.type === 'stdio') return s.transport.command;
  return s.transport.url;
}

export function McpManagementPage() {
  const { logout, user } = useAuth();
  const { t } = useI18n();
  const [items, setItems] = useState<McpServer[] | null>(null);
  // The platform's own toolset (#106) — a pinned fixture row, not a McpServer
  // row; null until fetched (or if the fetch fails — the row simply hides).
  const [builtin, setBuiltin] = useState<BuiltinMcpService | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [statuses, setStatuses] = useState<Map<string, McpServerStatus>>(new Map());
  // name → distributable, for deriving `auto` dial sites client-side (display
  // only; the server derives authoritatively).
  const [distributable, setDistributable] = useState<Map<string, boolean>>(new Map());
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<McpServer | null>(null);
  // One dialog for both destructive actions: the row asks, the page confirms
  // (03-interaction.md §2 — the action's own name, never a bare "are you sure").
  const [pending, setPending] = useState<{
    action: 'delete' | 'disconnect';
    server: McpServer;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const isAdmin = user?.role === 'admin';

  const refresh = useCallback(async () => {
    try {
      const [servers, creds, builtinService] = await Promise.all([
        withAuthGuard(() => api.listMcpServers(), logout),
        api.listCredentials().catch(() => [] as CredentialView[]),
        api.getBuiltinMcpService().catch(() => null),
      ]);
      setItems(servers);
      setBuiltin(builtinService);
      setError(null);
      const map = new Map<string, boolean>();
      for (const c of creds) if (!map.has(c.name)) map.set(c.name, c.distributable);
      setDistributable(map);
    } catch (e) {
      setError(e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t is stable per language; dep array kept as-is
  }, [logout]);

  const refreshStatuses = useCallback(async () => {
    try {
      const res = await withAuthGuard(() => api.listMcpServerStatuses(), logout);
      setStatuses(new Map(res.map((s) => [s.id, s])));
    } catch {
      // Swallow poll errors — the next interval retries; a transient failure
      // shouldn't toast on the management page.
    }
  }, [logout]);

  // Load servers + statuses together on mount, then poll statuses on an interval.
  // The interval is cleared on unmount (no leak). Functional setState / no stale
  // captures: the poll callback only overwrites `statuses`.
  useEffect(() => {
    void (async () => {
      await Promise.all([refresh(), refreshStatuses()]);
    })();
    const timer = setInterval(() => {
      void refreshStatuses();
    }, STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [refresh, refreshStatuses]);

  async function remove(s: McpServer) {
    try {
      const res = await withAuthGuard(() => api.deleteMcpServer(s.id), logout);
      toast.success(res.mode === 'soft' ? t('mcp.deletedSoftToast') : t('mcp.deletedHardToast'));
      await refresh();
      await refreshStatuses();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.deleteFailed'));
    }
  }

  async function disconnect(s: McpServer) {
    try {
      await withAuthGuard(() => api.disconnectMcpServer(s.id), logout);
      await refreshStatuses();
      toast.success(t('mcp.disconnectedToast', { name: s.name }));
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('mcp.disconnectFailed'));
    }
  }

  async function confirmPending() {
    const subject = pending;
    if (subject === null) return;
    setBusy(true);
    try {
      if (subject.action === 'delete') await remove(subject.server);
      else await disconnect(subject.server);
      setPending(null);
    } finally {
      setBusy(false);
    }
  }

  const siteOf = (s: McpServer): 'server' | 'client' =>
    resolveDialSite(s, (name) => distributable.get(name) === true);

  const query = useListQuery(MCP_SPEC);
  const visible = useMemo(() => {
    if (items === null) return null;
    const rows = items.filter(
      (s) =>
        matchesQuery(query.q, [s.name, endpointOf(s), s.transport.type, s.dialSite]) &&
        (query.filters['transport'] === null || s.transport.type === query.filters['transport']) &&
        (query.filters['scope'] === null || s.scope === query.filters['scope']) &&
        (query.filters['dial'] === null || siteOf(s) === query.filters['dial']),
    );
    return sortRows(rows, effectiveSort(MCP_SPEC, query), (s) => s.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- siteOf reads `distributable`, which is refreshed with `items`
  }, [items, distributable, query.q, query.filters, query.sort]);

  const scopeLabels = useMemo(
    () => ({ personal: t('common.scopePersonal'), global: t('common.scopeGlobal') }),
    [t],
  );
  const dialLabels = useMemo(
    () => ({ server: t('mcp.dialServer'), client: t('mcp.dialClient') }),
    [t],
  );
  const transportLabels = useMemo(
    () => Object.fromEntries(TRANSPORT_TYPES.map((type) => [type, type])),
    [],
  );

  // The built-in service is a pinned fixture, not a managed asset: it ignores
  // the transport/dial/scope filters (vocabulary mismatch — it has no
  // upstream, no dial decision, no owner) and only the search query can hide
  // it. It is deliberately not counted in the filter bar's shown/total.
  const builtinVisible =
    builtin !== null &&
    matchesQuery(query.q, [t('mcp.builtinName'), ...builtin.tools.map((tool) => tool.name)]);

  return (
    <>
      <PageSlot slot="actions">
        <PageAction label={t('mcp.addServer')} onClick={() => setCreating(true)} />
      </PageSlot>

      <PageIntro
        sub={
          <>
            {t('mcp.subtitleLead')}{' '}
            <strong className="font-medium">{t('mcp.subtitleServerWord')}</strong>
            {t('mcp.subtitleServerText')}
            <Well variant="chip" copy="/mcp">
              /mcp
            </Well>
            {t('mcp.subtitleServerAfter')}{' '}
            <strong className="font-medium">{t('mcp.subtitleClientWord')}</strong>
            {t('mcp.subtitleClientText')}
            <Well variant="chip" copy="hnx mcp serve">
              hnx mcp serve
            </Well>
            {t('mcp.subtitleClientAfter')}
          </>
        }
      />

      <DataTable
        columns={6}
        label={t('mcp.serversTitle')}
        icon={<ServerIcon />}
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
            <TableSearch query={query} placeholder={t('mcp.searchPlaceholder')} />
            <FilterSelect
              query={query}
              spec={MCP_SPEC}
              name="transport"
              allLabel={t('mcp.allTransports')}
              labels={transportLabels}
            />
            <FilterSelect
              query={query}
              spec={MCP_SPEC}
              name="dial"
              allLabel={t('mcp.allDialSites')}
              labels={dialLabels}
            />
            <FilterSelect
              query={query}
              spec={MCP_SPEC}
              name="scope"
              allLabel={t('common.allScopes')}
              labels={scopeLabels}
            />
          </FilterBar>
        }
        empty={{
          title: t('mcp.empty'),
          hint: t('mcp.emptyHint'),
          action: (
            <Button onClick={() => setCreating(true)}>
              <PlusIcon className="size-4" />
              {t('mcp.addServer')}
            </Button>
          ),
        }}
      >
        <TableHeader>
          <TableRow>
            <TableHead className="w-[34%]">{t('common.name')}</TableHead>
            <TableHead>{t('mcp.dialSite')}</TableHead>
            <TableHead>{t('common.status')}</TableHead>
            <TableHead>{t('mcp.transport')}</TableHead>
            <TableHead>{t('common.scope')}</TableHead>
            <TableHead className="text-right">{t('common.actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {builtinVisible && builtin !== null ? <BuiltinServiceRow service={builtin} /> : null}
          {visible?.map((s) => (
            <ServerRow
              key={s.id}
              server={s}
              site={siteOf(s)}
              status={statuses.get(s.id)}
              isAdmin={isAdmin}
              onAsk={(action, subject) => setPending({ action, server: subject })}
              onEdited={setEditing}
              onStatusChange={refreshStatuses}
              logout={logout}
            />
          ))}
        </TableBody>
      </DataTable>

      {pending !== null ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) setPending(null);
          }}
          title={pending.action === 'delete' ? t('mcp.deleteAction') : t('mcp.disconnectAction')}
          consequence={
            pending.action === 'delete'
              ? t('mcp.deleteConsequence')
              : t('mcp.disconnectConsequence')
          }
          impact={[
            { label: 'server', value: pending.server.name },
            { label: 'transport', value: pending.server.transport.type },
            ...(endpointOf(pending.server) !== ''
              ? [{ label: 'endpoint', value: endpointOf(pending.server) }]
              : []),
          ]}
          // Both actions are tier 1: a disconnect keeps the configuration, and
          // the first delete only hides the row (its second delete removes the
          // record). Only the machine-remove / token-revoke class, which destroys
          // a credential on the spot, asks the reader to type a name.
          irreversible={false}
          actionLabel={
            pending.action === 'delete' ? t('mcp.deleteAction') : t('mcp.disconnectAction')
          }
          busy={busy}
          onConfirm={() => void confirmPending()}
        />
      ) : null}

      {creating ? (
        <McpServerDialog
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            void refresh();
          }}
        />
      ) : null}
      {editing ? (
        <McpServerDialog
          server={editing}
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
 * One server row. Proxy rows' tool-count readout opens the tool-inspection
 * drawer (#112) while connected — the row itself stays single-line, so the
 * table can never be stretched by upstream tool descriptions. Direct rows
 * render as a plain, non-expandable row with a neutral status hint (Harness
 * Nexus never dials them).
 *
 * Defined at module scope (React perf rule — never nest component definitions).
 */
function ServerRow({
  server,
  site,
  status,
  isAdmin,
  onAsk,
  onEdited,
  onStatusChange,
  logout,
}: {
  server: McpServer;
  /** The derived dial site (`auto` already resolved). */
  site: 'client' | 'server';
  status: McpServerStatus | undefined;
  isAdmin: boolean;
  /** The row asks; the page's ConfirmDialog is what actually acts. */
  onAsk: (action: 'delete' | 'disconnect', server: McpServer) => void;
  onEdited: (s: McpServer) => void;
  onStatusChange: () => Promise<void>;
  logout: () => void;
}) {
  const { t } = useI18n();
  const [inspecting, setInspecting] = useState(false);
  const [pendingConnect, setPendingConnect] = useState(false);

  const isServerDialed = site === 'server';
  const connState = status?.status;
  const isConnected = connState === 'connected';
  const isConnecting = connState === 'connecting' || pendingConnect;
  const toolCount = status?.toolCount ?? 0;

  async function connect() {
    setPendingConnect(true);
    try {
      await withAuthGuard(() => api.connectMcpServer(server.id), logout);
      await onStatusChange(); // pick up the new state immediately
      toast.success(t('mcp.connectingToast', { name: server.name }));
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('mcp.connectFailed'));
    } finally {
      setPendingConnect(false);
    }
  }

  // Common cells shared by server-dialed and client-dialed rows.
  const dialSiteCell = (
    <Badge variant={isServerDialed ? 'default' : 'secondary'}>
      {server.dialSite === 'auto'
        ? t('mcp.dialAutoDerived', {
            site: site === 'client' ? t('mcp.dialClient') : t('mcp.dialServer'),
          })
        : server.dialSite}
    </Badge>
  );
  const transportCell = (
    <Badge variant="secondary" className="role-data-sm">
      {server.transport.type}
    </Badge>
  );
  const scopeCell = <ScopeBadge scope={server.scope} />;
  const actionsCell = (
    <TableCell className="pr-6 text-right">
      <div className="flex items-center justify-end gap-1">
        {isServerDialed && isConnected ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground h-(--row-ctl-h)"
            disabled={server.scope === 'global' && !isAdmin}
            onClick={() => onAsk('disconnect', server)}
          >
            <PlugZapIcon className="size-4" />
            {t('mcp.disconnect')}
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-(--row-ctl-h)">
              <MoreHorizontalIcon className="size-4" />
              <span className="sr-only">{t('common.openMenu')}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {isServerDialed && isConnected ? (
              <DropdownMenuItem onClick={() => onAsk('disconnect', server)}>
                <PlugZapIcon /> {t('mcp.disconnect')}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              variant="destructive"
              disabled={server.scope === 'global' && !isAdmin}
              onClick={() => onAsk('delete', server)}
            >
              <TrashIcon /> {t('common.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </TableCell>
  );

  // ---- client-dialed row: plain, non-expandable, neutral status ----
  if (!isServerDialed) {
    return (
      <>
        <TableRow>
          <TableCell className="pl-6 font-medium">{server.name}</TableCell>
          <TableCell>{dialSiteCell}</TableCell>
          <TableCell>
            <Badge variant="secondary" className="role-data-sm">
              {t('mcp.dialedByShim')}
            </Badge>
          </TableCell>
          <TableCell>{transportCell}</TableCell>
          <TableCell>{scopeCell}</TableCell>
          {actionsCell}
        </TableRow>
      </>
    );
  }

  // ---- server-dialed row: single-line; tools inspect in the drawer ----
  const canInspect = !(server.scope === 'global' && !isAdmin);
  const { tools, refreshing, refresh } = useServerTools(
    server.id,
    server.name,
    inspecting && canInspect,
    logout,
  );
  const lampState: McpServerStatus['status'] = connState ?? 'disconnected';
  return (
    <>
      <TableRow>
        <TableCell className="pl-6 font-medium">{server.name}</TableCell>
        <TableCell>{dialSiteCell}</TableCell>
        <TableCell>
          {/* The count IS the drawer's entry (#112) — it only renders while
           * connected. Non-admins on a global row MAY open the drawer too; it
           * then explains that inspection is admin-only instead of fetching
           * into a 404. */}
          <StatusBadge
            status={connState}
            detail={status?.detail}
            toolCount={toolCount}
            onInspect={() => setInspecting(true)}
          />
        </TableCell>
        <TableCell>{transportCell}</TableCell>
        <TableCell>{scopeCell}</TableCell>
        <TableCell className="pr-6 text-right">
          <div className="flex items-center justify-end gap-1">
            {isConnected ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground h-(--row-ctl-h)"
                disabled={server.scope === 'global' && !isAdmin}
                onClick={() => onAsk('disconnect', server)}
              >
                <PlugZapIcon className="size-4" />
                {t('mcp.disconnect')}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className="h-(--row-ctl-h)"
                disabled={isConnecting || (server.scope === 'global' && !isAdmin)}
                onClick={connect}
              >
                {isConnecting ? (
                  <LoaderIcon className="size-4 animate-spin" />
                ) : (
                  <PlugIcon className="size-4" />
                )}
                {isConnecting
                  ? t('mcp.connecting')
                  : connState === 'error'
                    ? t('mcp.reconnect')
                    : t('mcp.connect')}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-(--row-ctl-h)">
                  <MoreHorizontalIcon className="size-4" />
                  <span className="sr-only">{t('common.openMenu')}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {isConnected ? (
                  <DropdownMenuItem
                    disabled={server.scope === 'global' && !isAdmin}
                    onClick={() => onAsk('disconnect', server)}
                  >
                    <PlugZapIcon /> {t('mcp.disconnect')}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  disabled={server.scope === 'global' && !isAdmin}
                  onClick={() => onEdited(server)}
                >
                  <PencilIcon /> {t('common.edit')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  disabled={server.scope === 'global' && !isAdmin}
                  onClick={() => onAsk('delete', server)}
                >
                  <TrashIcon /> {t('common.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </TableCell>
      </TableRow>
      <ToolInspectorDrawer
        open={inspecting}
        onOpenChange={setInspecting}
        title={server.name}
        lamp={
          <Lamp
            state={lampState === 'disconnected' ? 'offline' : lampState}
            word={lampState}
            pulse={lampState === 'connecting'}
          />
        }
        adminOnly={!canInspect}
        tools={tools}
        refreshing={refreshing}
        onRefresh={refresh}
      />
    </>
  );
}

/**
 * The platform's built-in MCP service (#106) — pinned first row of the table.
 * Global and non-modifiable: no connect/edit/delete actions, always available
 * (the tools are served in-process on the /mcp outlet). The tool-count readout
 * opens the same tool-inspection drawer as the pooled rows, fed straight from
 * the descriptor — no registry round-trip, no refresh (#112).
 *
 * Defined at module scope (React perf rule — never nest component definitions).
 */
function BuiltinServiceRow({ service }: { service: BuiltinMcpService }) {
  const { t } = useI18n();
  const [inspecting, setInspecting] = useState(false);
  return (
    <>
      <TableRow>
        <TableCell className="pl-6 font-medium">{t('mcp.builtinName')}</TableCell>
        <TableCell>
          <Badge variant="default">server</Badge>
        </TableCell>
        <TableCell>
          <div className="flex items-center gap-2">
            {/* Status words stay English (wire vocabulary, like every other
             * row); the service is in-process, so "built-in" IS its state. */}
            <Lamp state="connected" word="built-in" />
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current nums text-xs underline-offset-2 hover:underline"
              aria-label={t('mcp.expandTools')}
              onClick={() => setInspecting(true)}
            >
              {service.tools.length === 1
                ? t('mcp.toolOne', { count: 1 })
                : t('mcp.toolMany', { count: service.tools.length })}
            </button>
          </div>
        </TableCell>
        <TableCell>
          <Badge variant="secondary" className="role-data-sm">
            built-in
          </Badge>
        </TableCell>
        <TableCell>
          <ScopeBadge scope="global" />
        </TableCell>
        <TableCell className="pr-6" />
      </TableRow>
      <ToolInspectorDrawer
        open={inspecting}
        onOpenChange={setInspecting}
        title={t('mcp.builtinName')}
        lamp={<Lamp state="connected" word="built-in" />}
        hint={t('mcp.builtinHint')}
        tools={service.tools}
      />
    </>
  );
}

/**
 * Live connection status — the two-channel status device (`Lamp`: the lamp
 * carries the tone, the word the state) plus the tool-count readout when
 * connected, and the error detail when present. With `onInspect` the count IS
 * the tool drawer's entry (#112) — the row keeps a single affordance instead
 * of a chevron + link pair.
 */
function StatusBadge({
  status,
  detail,
  toolCount,
  onInspect,
}: {
  status: McpServerStatus['status'] | undefined;
  detail: string | undefined;
  toolCount: number;
  /** Present = clicking the count opens the tool-inspection drawer. */
  onInspect?: () => void;
}) {
  const { t } = useI18n();
  const resolved: McpServerStatus['status'] = status ?? 'disconnected';
  const count =
    toolCount === 1
      ? t('mcp.toolOne', { count: toolCount })
      : t('mcp.toolMany', { count: toolCount });
  return (
    <>
      <div className="flex items-center gap-2">
        <Lamp
          state={resolved === 'disconnected' ? 'offline' : resolved}
          word={resolved}
          pulse={resolved === 'connecting'}
        />
        {resolved === 'connected' ? (
          onInspect ? (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current nums text-xs underline-offset-2 hover:underline"
              aria-label={t('mcp.expandTools')}
              onClick={onInspect}
            >
              {count}
            </button>
          ) : (
            <span className="text-muted-foreground nums text-xs">{count}</span>
          )
        ) : null}
        {resolved === 'error' && detail ? (
          <span className="text-muted-foreground truncate text-xs" title={detail}>
            {detail}
          </span>
        ) : null}
      </div>
    </>
  );
}

/** Tool lists at or above this size get the inspector's search box. */
const TOOL_SEARCH_THRESHOLD = 8;

/**
 * Lazily fetch a server's cached tool list while the inspector drawer is open
 * (fetch on first open, then cache locally); `refresh` re-pulls from the
 * upstream. The Phase 2.4 panel's data logic, relocated into the drawer (#112).
 */
function useServerTools(serverId: string, serverName: string, active: boolean, logout: () => void) {
  const { t } = useI18n();
  const [tools, setTools] = useState<McpToolInfo[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      return await withAuthGuard(() => api.listMcpServerTools(serverId), logout);
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('mcp.loadToolsFailed'));
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t is stable per language; dep array kept as-is
  }, [serverId, logout]);

  // Fetch once when the drawer first opens (the list stays cached afterwards).
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void (async () => {
      const loaded = await load();
      if (!cancelled) setTools(loaded);
    })();
    return () => {
      cancelled = true;
    };
  }, [load, active]);

  async function refresh() {
    setRefreshing(true);
    try {
      const fresh = await withAuthGuard(() => api.refreshMcpServerTools(serverId), logout);
      setTools(fresh);
      toast.success(t('mcp.refreshedToast', { name: serverName }));
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('mcp.refreshFailed'));
    } finally {
      setRefreshing(false);
    }
  }

  return { tools, refreshing, refresh };
}

/**
 * The tool-inspection drawer (#112) — the right-side sheet each row's
 * tool-count readout opens. Tall content (long upstream descriptions,
 * parameter lists, raw input schemas) belongs here, not in a colSpan table
 * cell whose min-content width stretched the whole table: the row stays
 * single-line and the table keeps its width. Server rows pass a lazily
 * fetched list plus refresh; the built-in service row passes its static
 * descriptor and no refresh.
 */
function ToolInspectorDrawer({
  open,
  onOpenChange,
  title,
  lamp,
  hint,
  adminOnly,
  tools,
  refreshing,
  onRefresh,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** The status device (Lamp) for the drawer's description line. */
  lamp: ReactNode;
  /** A one-line note pinned above the list (the built-in service's hint). */
  hint?: string;
  /** Show the admin-only note instead of the list (global row, non-admin). */
  adminOnly?: boolean;
  /** The tool list; null = still loading (server rows fetch on open). */
  tools: McpToolInfo[] | null;
  refreshing?: boolean;
  /** Omit for a static list (the built-in service) — no refresh renders. */
  onRefresh?: () => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  // A fresh open (or another server's drawer) starts unfiltered.
  useEffect(() => {
    if (open) setQuery('');
  }, [open]);
  const needle = query.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (tools === null || needle === '') return tools;
    return tools.filter(
      (tool) =>
        tool.name.toLowerCase().includes(needle) ||
        (tool.description ?? '').toLowerCase().includes(needle),
    );
  }, [tools, needle]);

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <div className="flex items-center justify-between gap-2 pr-1">
            <DrawerTitle className="min-w-0 truncate">{title}</DrawerTitle>
            {onRefresh ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground h-7 shrink-0"
                disabled={refreshing}
                onClick={onRefresh}
              >
                <RefreshCwIcon className={cn('size-3.5', refreshing && 'animate-spin')} />
                {t('mcp.refresh')}
              </Button>
            ) : null}
          </div>
          <DrawerDescription asChild>
            <div className="flex items-center gap-2">
              {lamp}
              {tools !== null ? (
                <span className="text-muted-foreground nums text-xs">
                  {tools.length === 1
                    ? t('mcp.toolOne', { count: tools.length })
                    : t('mcp.toolMany', { count: tools.length })}
                </span>
              ) : null}
            </div>
          </DrawerDescription>
        </DrawerHeader>
        <DrawerBody className="flex flex-col gap-2">
          {hint ? <p className="text-muted-foreground text-xs">{hint}</p> : null}
          {adminOnly ? (
            <p className="text-muted-foreground text-xs">{t('mcp.toolsAdminOnly')}</p>
          ) : filtered === null ? (
            <p className="text-muted-foreground text-xs">{t('mcp.loadingTools')}</p>
          ) : filtered.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              {needle !== '' ? t('mcp.noMatchingTools', { query: query.trim() }) : t('mcp.noTools')}
            </p>
          ) : (
            <>
              {needle !== '' || filtered.length >= TOOL_SEARCH_THRESHOLD ? (
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('mcp.searchTools')}
                  autoComplete="off"
                  spellCheck={false}
                  className="h-8"
                />
              ) : null}
              <ul className="flex flex-col gap-0.5">
                {filtered.map((tool) => (
                  <ToolRow key={tool.name} tool={tool} />
                ))}
              </ul>
            </>
          )}
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}

/**
 * One tool item in the inspector: the trigger line is the name plus the
 * description — clamped to two lines while collapsed, full when expanded
 * (the drawer has the room the table cell never did); expanding reveals the
 * parameter list and, behind a disclosure, the raw JSON schema.
 */
function ToolRow({ tool }: { tool: McpToolInfo }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [schemaOpen, setSchemaOpen] = useState(false);
  const params = extractParams(tool.inputSchema);
  const schemaJson = JSON.stringify(tool.inputSchema, null, 2);
  return (
    <li>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="hover:bg-muted/40 -mx-1.5 flex w-full items-start gap-1.5 rounded-xs px-1.5 py-1 text-left"
          >
            <ChevronRightIcon
              className={cn(
                'text-muted-foreground mt-0.5 size-3.5 shrink-0 transition-transform',
                open && 'rotate-90',
              )}
            />
            <span className="min-w-0 flex-1">
              <code className="text-foreground text-xs font-medium break-all">{tool.name}</code>
              {tool.description ? (
                <span
                  className={cn(
                    'text-muted-foreground mt-0.5 block text-xs leading-5',
                    !open && 'line-clamp-2',
                  )}
                >
                  {tool.description}
                </span>
              ) : null}
            </span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-1 ml-5 flex flex-col gap-2 pb-1">
            {params.length === 0 ? (
              <p className="text-muted-foreground text-xs">{t('mcp.noParams')}</p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {params.map((p) => (
                  <li key={p.name} className="nums text-xs">
                    <code className="text-foreground">{p.name}</code>
                    <span className="text-muted-foreground"> : {p.type}</span>
                    {p.required ? (
                      <span className="text-warn ml-2 font-medium">{t('mcp.required')}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            <Collapsible open={schemaOpen} onOpenChange={setSchemaOpen}>
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1 text-xs"
                >
                  <ChevronRightIcon
                    className={cn('size-3 transition-transform', schemaOpen && 'rotate-90')}
                  />
                  {t('mcp.rawSchema')}
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <Well variant="code" copy={schemaJson} className="mt-1.5 max-h-64 overflow-y-auto">
                  {schemaJson}
                </Well>
              </CollapsibleContent>
            </Collapsible>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  );
}

/**
 * Pull a flat { name, type, required } list out of a JSON-Schema inputSchema.
 * MCP tools follow JSON-Schema: `properties` maps name→{ type }, `required`
 * lists the mandatory names. Returns [] if the shape isn't recognized.
 */
function extractParams(
  schema: Record<string, unknown>,
): { name: string; type: string; required: boolean }[] {
  const properties = schema.properties;
  if (!properties || typeof properties !== 'object') return [];
  const requiredList = Array.isArray(schema.required) ? (schema.required as unknown[]) : [];
  const requiredSet = new Set(requiredList.map(String));
  return Object.entries(properties).map(([name, def]) => ({
    name,
    type:
      typeof def === 'object' && def !== null && 'type' in def
        ? String((def as { type: unknown }).type)
        : 'any',
    required: requiredSet.has(name),
  }));
}

const DEFAULT_HEADERS_JSON = '{"Authorization": "Bearer ${cred:token}"}';
const DEFAULT_ENV_JSON = '{}';

/** Parse a JSON object string into Record<string,string>; returns {} on empty/invalid. */
function parseStringRecord(raw: string): Record<string, string> | undefined {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '{}') return undefined;
  try {
    const obj = JSON.parse(trimmed);
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return undefined;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = typeof v === 'string' ? v : JSON.stringify(v);
    }
    return out;
  } catch {
    return undefined;
  }
}

function McpServerDialog({
  server,
  onClose,
  onSaved,
}: {
  /** Present → edit mode (PATCH name/transport/dialSite; scope immutable). */
  server?: McpServer;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { logout, user } = useAuth();
  const { t } = useI18n();
  const isAdmin = user?.role === 'admin';
  const editing = server !== undefined;
  const [name, setName] = useState(server?.name ?? '');
  const [dialSite, setDialSite] = useState<DialSite>(server?.dialSite ?? 'auto');
  const [type, setType] = useState<TransportType>(
    (server?.transport.type as TransportType | undefined) ?? 'streamable-http',
  );
  const [url, setUrl] = useState(
    server && server.transport.type !== 'stdio' ? server.transport.url : '',
  );
  // stdio fields
  const [command, setCommand] = useState(
    server?.transport.type === 'stdio' ? server.transport.command : '',
  );
  const [args, setArgs] = useState(
    server?.transport.type === 'stdio' && server.transport.args
      ? server.transport.args.join(' ')
      : '',
  ); // space-joined for the input; split on submit
  const [envJson, setEnvJson] = useState(
    server?.transport.type === 'stdio' && server.transport.env
      ? JSON.stringify(server.transport.env, null, 2)
      : DEFAULT_ENV_JSON,
  );
  // http fields
  const [headersJson, setHeadersJson] = useState(
    server && server.transport.type !== 'stdio' && server.transport.headers
      ? JSON.stringify(server.transport.headers, null, 2)
      : DEFAULT_HEADERS_JSON,
  );
  const [scope, setScope] = useState<Scope>(server?.scope ?? 'personal');
  const [busy, setBusy] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const [creds, setCreds] = useState<CredentialView[]>([]);
  useEffect(() => {
    api
      .listCredentials()
      .then(setCreds)
      .catch(() => setCreds([]));
  }, []);

  const isStdio = type === 'stdio';

  function onTypeChange(next: TransportType) {
    setType(next);
    // Interlock: stdio can never be server-dialed. Falling back to `auto`
    // keeps the two selects out of combinations the API would 409.
    if (next === 'stdio' && dialSite === 'server') setDialSite('auto');
  }

  /**
   * Client-side mirror of the server's assertDialSite, run before submit so
   * the dialog can never send a transport × dial-site pair the API rejects.
   */
  function dialSiteProblem(): string | undefined {
    const transport = isStdio ? { type: 'stdio' as const, command } : { type, url };
    const isDistributable = (n: string): boolean =>
      creds.find((c) => c.name === n)?.distributable === true;
    const resolved = resolveDialSite({ dialSite, transport }, isDistributable);
    if (isStdio && resolved === 'server') return t('mcp.stdioNeedsClient');
    if (dialSite === 'client') {
      const offender = transportPlaceholderNames(transport).find(
        (n) => creds.some((c) => c.name === n) && !isDistributable(n),
      );
      if (offender) return t('mcp.credNotDistributable', { name: offender });
    }
    return undefined;
  }

  function applyImport(entry: Record<string, unknown>, entryName: string) {
    setName(entryName);
    const hasCommand = typeof entry.command === 'string';
    if (hasCommand) {
      // stdio — auto derives client (stdio can never be server-dialed).
      setDialSite('auto');
      setType('stdio');
      setCommand(String(entry.command));
      setArgs(Array.isArray(entry.args) ? (entry.args as string[]).join(' ') : '');
      if (entry.env && typeof entry.env === 'object') {
        setEnvJson(JSON.stringify(entry.env, null, 2));
      }
    } else {
      const u = typeof entry.serverUrl === 'string' ? entry.serverUrl : entry.url;
      setDialSite('auto');
      setType('streamable-http');
      if (u) setUrl(String(u));
      if (entry.headers && typeof entry.headers === 'object') {
        setHeadersJson(JSON.stringify(entry.headers, null, 2));
      }
    }
    setImportOpen(false);
    toast.success(t('mcp.importedToast', { name: entryName }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const problem = dialSiteProblem();
    if (problem) {
      toast.error(problem);
      return;
    }
    setBusy(true);
    try {
      const transport = isStdio
        ? (() => {
            const splitArgs = args.trim() ? args.trim().split(/\s+/) : undefined;
            const env = parseStringRecord(envJson);
            return {
              type: 'stdio' as const,
              command,
              ...(splitArgs ? { args: splitArgs } : {}),
              ...(env ? { env } : {}),
            };
          })()
        : (() => {
            const headers = parseStringRecord(headersJson);
            return { type, url, ...(headers ? { headers } : {}) };
          })();
      if (editing && server) {
        await withAuthGuard(
          () => api.updateMcpServer(server.id, { name, dialSite, transport }),
          logout,
        );
        toast.success(t('mcp.updatedToast'));
      } else {
        await withAuthGuard(
          () => api.createMcpServer({ name, dialSite, scope, transport }),
          logout,
        );
        toast.success(t('mcp.addedToast'));
      }
      onSaved();
    } catch (e) {
      toast.error(
        e instanceof HarnessNexusError
          ? e.message
          : editing
            ? t('common.saveFailed')
            : t('common.createFailed'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <FormDialog
        open
        onClose={onClose}
        title={editing ? t('mcp.editServer') : t('mcp.addServer')}
        description={
          dialSite === 'server'
            ? t('mcp.descServer')
            : dialSite === 'client'
              ? t('mcp.descClient')
              : t('mcp.descAuto')
        }
        size="lg"
      >
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex justify-end">
            <Button type="button" variant="outline" size="sm" onClick={() => setImportOpen(true)}>
              <FileJsonIcon className="size-4" />
              {t('mcp.importJson')}
            </Button>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {/* content-start on every cell: the scope cell grows an edit-mode
              hint <p>, and without it align-content:stretch distributes that
              extra height into the OTHER cells' rows — pushing their inputs
              around (the same alignment bug the Profiles edit dialog fixed). */}
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-2">
              <Label htmlFor="mcp-name">{t('common.name')}</Label>
              <Input
                id="mcp-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('mcp.namePlaceholder')}
                autoComplete="off"
                spellCheck={false}
                required
              />
            </div>
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-2">
              <Label htmlFor="mcp-dial-site">{t('mcp.dialSite')}</Label>
              <Select value={dialSite} onValueChange={(v) => setDialSite(v as DialSite)}>
                <SelectTrigger className="w-full [&>span]:truncate" id="mcp-dial-site">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t('mcp.dialSiteAuto')}</SelectItem>
                  <SelectItem value="client">{t('mcp.dialSiteClient')}</SelectItem>
                  <SelectItem value="server" disabled={isStdio}>
                    {t('mcp.dialSiteServer')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-2">
              <Label htmlFor="mcp-type">{t('mcp.transport')}</Label>
              <Select value={type} onValueChange={(v) => onTypeChange(v as TransportType)}>
                <SelectTrigger className="w-full [&>span]:truncate" id="mcp-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="streamable-http">streamable-http</SelectItem>
                  <SelectItem value="sse">sse</SelectItem>
                  <SelectItem value="stdio" disabled={dialSite === 'server'}>
                    {t('mcp.transportStdio')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-2">
              <Label htmlFor="mcp-scope">{t('common.scope')}</Label>
              <Select
                value={scope}
                onValueChange={(v) => setScope(v as Scope)}
                disabled={!isAdmin || editing}
              >
                <SelectTrigger id="mcp-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="personal">{t('common.scopePersonal')}</SelectItem>
                  <SelectItem value="global" disabled={!isAdmin}>
                    {t('common.scopeGlobal')}
                    {!isAdmin ? t('mcp.adminSuffix') : ''}
                  </SelectItem>
                </SelectContent>
              </Select>
              {editing ? (
                <p className="text-muted-foreground text-xs">{t('mcp.scopeImmutable')}</p>
              ) : null}
            </div>
          </div>

          {isStdio ? (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="mcp-command">{t('mcp.command')}</Label>
                  <Input
                    id="mcp-command"
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    placeholder={t('mcp.commandPlaceholder')}
                    autoComplete="off"
                    spellCheck={false}
                    required
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="mcp-args">{t('mcp.args')}</Label>
                  <Input
                    id="mcp-args"
                    value={args}
                    onChange={(e) => setArgs(e.target.value)}
                    placeholder={t('mcp.argsPlaceholder')}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="mcp-env">{t('mcp.env')}</Label>
                <Textarea
                  id="mcp-env"
                  value={envJson}
                  onChange={(e) => setEnvJson(e.target.value)}
                  className="font-mono text-xs"
                  rows={3}
                  spellCheck={false}
                  placeholder='{"API_KEY": "${cred:context7-key}"}'
                />
              </div>
            </>
          ) : (
            <>
              <div className="grid gap-2">
                <Label htmlFor="mcp-url">{t('mcp.url')}</Label>
                <Input
                  id="mcp-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://mcp.example.com/mcp"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="mcp-headers">{t('mcp.headers')}</Label>
                <Textarea
                  id="mcp-headers"
                  value={headersJson}
                  onChange={(e) => setHeadersJson(e.target.value)}
                  className="font-mono text-xs"
                  rows={3}
                  spellCheck={false}
                />
              </div>
            </>
          )}

          <PlaceholderChips creds={creds} />

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy
                ? editing
                  ? t('common.saving')
                  : t('mcp.adding')
                : editing
                  ? t('common.save')
                  : t('mcp.addServer')}
            </Button>
          </div>
        </form>

        <ImportJsonDialog open={importOpen} onOpenChange={setImportOpen} onImport={applyImport} />
      </FormDialog>
    </>
  );
}

/** Shows available credential placeholders as copyable monospace chips. */
function PlaceholderChips({ creds }: { creds: CredentialView[] }) {
  const { t } = useI18n();
  if (creds.length === 0) return null;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground text-xs">{t('mcp.availablePlaceholders')}</span>
        {creds.map((c) => (
          <button
            key={c.id}
            type="button"
            className="bg-muted font-mono text-muted-foreground hover:bg-accent rounded px-2 py-0.5 text-[11px] transition-colors"
            onClick={() => {
              void navigator.clipboard.writeText(`\${cred:${c.name}}`);
              toast.success(t('mcp.copiedPlaceholder', { name: c.name }));
            }}
            title={t('mcp.copyPlaceholder', { name: c.name })}
          >
            {'${cred:'}
            {c.name}
            {'}'}
          </button>
        ))}
      </div>
    </>
  );
}

/** Modal that parses a single-entry `{ mcpServers: { name: {...} } }` blob. */
function ImportJsonDialog({
  open,
  onOpenChange,
  onImport,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onImport: (entry: Record<string, unknown>, name: string) => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState('');

  function onParse() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      toast.error(t('mcp.invalidJson'));
      return;
    }
    const root = parsed as { mcpServers?: Record<string, unknown> } | null;
    if (!root || typeof root !== 'object' || !root.mcpServers) {
      toast.error(t('mcp.expectedMcpServers'));
      return;
    }
    const entries = Object.entries(root.mcpServers);
    if (entries.length === 0) {
      toast.error(t('mcp.noEntries'));
      return;
    }
    if (entries.length > 1) {
      toast.error(t('mcp.multipleEntries', { count: entries.length }));
      return;
    }
    const first = entries[0];
    if (!first) {
      toast.error(t('mcp.noEntries'));
      return;
    }
    const [entryName, raw] = first;
    if (typeof raw !== 'object' || raw === null) {
      toast.error(t('mcp.entryNotObject', { name: entryName }));
      return;
    }
    onImport(raw as Record<string, unknown>, entryName);
    setText('');
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('mcp.importTitle')}</DialogTitle>
            <DialogDescription>
              {t('mcp.importDescLead')}
              <code className="font-mono">{'{ "mcpServers": { "name": {...} } }'}</code>
              {t('mcp.importDescMid')}
              <code className="font-mono">command</code>
              {t('mcp.importDescArrowDirect')}
              <code className="font-mono">serverUrl</code>
              {t('mcp.importDescArrowProxy')}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="font-mono text-xs"
            rows={10}
            spellCheck={false}
            placeholder={
              '{\n  "mcpServers": {\n    "context7": {\n      "serverUrl": "https://mcp.context7.com/mcp",\n      "headers": { "CONTEXT7_API_KEY": "${cred:context7-key}" }\n    }\n  }\n}'
            }
            autoFocus
          />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="button" onClick={onParse}>
              {t('mcp.parse')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
