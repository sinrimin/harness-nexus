import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  ServerIcon,
  PlusIcon,
  TrashIcon,
  GlobeIcon,
  UserIcon,
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
import { PageIntro, Well } from '@/components/kit';
import { PageSlot } from '@/components/shell/page-slots';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
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
  type CredentialView,
} from '@harness-nexus/sdk';

type Scope = 'global' | 'personal';
type TransportType = 'sse' | 'streamable-http' | 'stdio';

/** Status poll interval for the live connection state (Phase 2.4). */
const STATUS_POLL_MS = 5000;

/**
 * Status → color token map. Color encodes connection STATE ONLY (Signal design
 * system rule): `--ok` green = live, `--danger` red = failed (the management
 * page is an operator diagnostics surface, so error gets the stronger danger
 * token rather than warn — distinguishes a hard failure from the transient
 * `connecting` amber), `--warn` amber = connecting, muted = idle. `--signal`
 * (cyan) is deliberately NOT used here — it is reserved for liveness/links.
 * Hoisted to module scope (static config, per the React perf rule in AGENTS.md).
 */
const STATUS_DOT_CLASS: Record<McpServerStatus['status'], string> = {
  connected: 'bg-ok',
  error: 'bg-danger',
  connecting: 'bg-warn',
  disconnected: 'bg-muted-foreground/50',
};

/** Location/launch info shown for a row, per transport shape. */
function endpointOf(s: McpServer): string {
  if (s.transport.type === 'stdio') return s.transport.command;
  return s.transport.url;
}

export function McpManagementPage() {
  const { logout, user } = useAuth();
  const { t } = useI18n();
  const [items, setItems] = useState<McpServer[] | null>(null);
  const [statuses, setStatuses] = useState<Map<string, McpServerStatus>>(new Map());
  // name → distributable, for deriving `auto` dial sites client-side (display
  // only; the server derives authoritatively).
  const [distributable, setDistributable] = useState<Map<string, boolean>>(new Map());
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<McpServer | null>(null);
  const isAdmin = user?.role === 'admin';

  const refresh = useCallback(async () => {
    try {
      const [servers, creds] = await Promise.all([
        withAuthGuard(() => api.listMcpServers(), logout),
        api.listCredentials().catch(() => [] as CredentialView[]),
      ]);
      setItems(servers);
      const map = new Map<string, boolean>();
      for (const c of creds) if (!map.has(c.name)) map.set(c.name, c.distributable);
      setDistributable(map);
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('mcp.loadFailed'));
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
    if (!confirm(t('mcp.confirmDelete', { name: s.name }))) return;
    try {
      const res = await withAuthGuard(() => api.deleteMcpServer(s.id), logout);
      toast.success(res.mode === 'soft' ? t('mcp.deletedSoftToast') : t('mcp.deletedHardToast'));
      await refresh();
      await refreshStatuses();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.deleteFailed'));
    }
  }

  return (
    <>
      <PageSlot slot="actions">
        <Button onClick={() => setCreating(true)}>
          <PlusIcon className="size-4" />
          {t('mcp.addServer')}
        </Button>
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

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ServerIcon className="size-4" />
            {t('mcp.serversTitle')}
          </CardTitle>
          <CardDescription>{t('mcp.serversDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6 w-[34%]">{t('common.name')}</TableHead>
                <TableHead>{t('mcp.dialSite')}</TableHead>
                <TableHead>{t('common.status')}</TableHead>
                <TableHead>{t('mcp.transport')}</TableHead>
                <TableHead>{t('common.scope')}</TableHead>
                <TableHead className="pr-6 text-right">{t('common.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items === null ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground py-8 text-center">
                    {t('common.loading')}
                  </TableCell>
                </TableRow>
              ) : items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground py-8 text-center">
                    {t('mcp.empty')}
                  </TableCell>
                </TableRow>
              ) : (
                items.map((s) => (
                  <ServerRow
                    key={s.id}
                    server={s}
                    site={resolveDialSite(s, (name) => distributable.get(name) === true)}
                    status={statuses.get(s.id)}
                    isAdmin={isAdmin}
                    onRemoved={remove}
                    onEdited={setEditing}
                    onStatusChange={refreshStatuses}
                    logout={logout}
                  />
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

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
 * One server row. Proxy rows are wrapped in a Collapsible: the row itself is the
 * trigger (Name cell carries a chevron when connected), and the tool-inspection
 * panel expands below it. Direct rows render as a plain, non-expandable row with
 * a neutral status hint (Harness Nexus never dials them).
 *
 * Defined at module scope (React perf rule — never nest component definitions).
 */
function ServerRow({
  server,
  site,
  status,
  isAdmin,
  onRemoved,
  onEdited,
  onStatusChange,
  logout,
}: {
  server: McpServer;
  /** The derived dial site (`auto` already resolved). */
  site: 'client' | 'server';
  status: McpServerStatus | undefined;
  isAdmin: boolean;
  onRemoved: (s: McpServer) => void;
  onEdited: (s: McpServer) => void;
  onStatusChange: () => Promise<void>;
  logout: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
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

  async function disconnect() {
    if (!confirm(t('mcp.confirmDisconnect', { name: server.name }))) return;
    try {
      await withAuthGuard(() => api.disconnectMcpServer(server.id), logout);
      await onStatusChange();
      toast.success(t('mcp.disconnectedToast', { name: server.name }));
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('mcp.disconnectFailed'));
    }
  }

  // Common cells shared by server-dialed and client-dialed rows.
  const dialSiteCell = (
    <Badge variant={isServerDialed ? 'default' : 'secondary'} className="font-mono text-[10px]">
      {server.dialSite === 'auto'
        ? t('mcp.dialAutoDerived', {
            site: site === 'client' ? t('mcp.dialClient') : t('mcp.dialServer'),
          })
        : server.dialSite}
    </Badge>
  );
  const transportCell = (
    <Badge variant="secondary" className="font-mono text-[10px]">
      {server.transport.type}
    </Badge>
  );
  const scopeCell = (
    <Badge variant={server.scope === 'global' ? 'default' : 'secondary'} className="gap-1">
      {server.scope === 'global' ? (
        <GlobeIcon className="size-3" />
      ) : (
        <UserIcon className="size-3" />
      )}
      {server.scope === 'global' ? t('common.scopeGlobal') : t('common.scopePersonal')}
    </Badge>
  );
  const actionsCell = (
    <TableCell className="pr-6 text-right">
      <div className="flex items-center justify-end gap-1">
        {isServerDialed && isConnected ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground h-8"
            onClick={disconnect}
          >
            <PlugZapIcon className="size-4" />
            {t('mcp.disconnect')}
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8">
              <MoreHorizontalIcon className="size-4" />
              <span className="sr-only">{t('common.openMenu')}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {isServerDialed && isConnected ? (
              <DropdownMenuItem onClick={disconnect}>
                <PlugZapIcon /> {t('mcp.disconnect')}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              variant="destructive"
              disabled={server.scope === 'global' && !isAdmin}
              onClick={() => onRemoved(server)}
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
            <Badge variant="outline" className="font-mono text-[10px]">
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

  // ---- server-dialed row: expandable when connected ----
  return (
    <>
      <Collapsible asChild open={open} onOpenChange={setOpen}>
        <>
          <TableRow data-state={open ? 'open' : 'closed'}>
            <TableCell className="pl-6 font-medium">
              <div className="flex items-center gap-2">
                {/* The trigger is the chevron + name; only meaningful when connected. */}
                <CollapsibleTrigger asChild>
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground flex items-center gap-1 disabled:opacity-30"
                    disabled={!isConnected}
                    aria-label={open ? t('mcp.collapseTools') : t('mcp.expandTools')}
                  >
                    <ChevronRightIcon
                      className={`size-4 transition-transform ${open ? 'rotate-90' : ''}`}
                    />
                  </button>
                </CollapsibleTrigger>
                <span>{server.name}</span>
              </div>
            </TableCell>
            <TableCell>{dialSiteCell}</TableCell>
            <TableCell>
              <StatusBadge status={connState} detail={status?.detail} toolCount={toolCount} />
            </TableCell>
            <TableCell>{transportCell}</TableCell>
            <TableCell>{scopeCell}</TableCell>
            <TableCell className="pr-6 text-right">
              <div className="flex items-center justify-end gap-1">
                {isConnected ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground h-8"
                    onClick={disconnect}
                  >
                    <PlugZapIcon className="size-4" />
                    {t('mcp.disconnect')}
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8"
                    disabled={isConnecting}
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
                    <Button variant="ghost" size="icon" className="size-8">
                      <MoreHorizontalIcon className="size-4" />
                      <span className="sr-only">{t('common.openMenu')}</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {isConnected ? (
                      <DropdownMenuItem onClick={disconnect}>
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
                      onClick={() => onRemoved(server)}
                    >
                      <TrashIcon /> {t('common.delete')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </TableCell>
          </TableRow>
          <CollapsibleContent asChild>
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={6} className="bg-muted/30 px-6 py-4">
                <ToolList serverId={server.id} serverName={server.name} logout={logout} />
              </TableCell>
            </TableRow>
          </CollapsibleContent>
        </>
      </Collapsible>
    </>
  );
}

/**
 * Live connection status badge — a colored dot (state-encoded, see
 * STATUS_DOT_CLASS) + a label, plus a tool-count badge when connected. Uses
 * neutral Badge variants; color comes from the dot only (Signal system).
 */
function StatusBadge({
  status,
  detail,
  toolCount,
}: {
  status: McpServerStatus['status'] | undefined;
  detail: string | undefined;
  toolCount: number;
}) {
  const { t } = useI18n();
  const resolved: McpServerStatus['status'] = status ?? 'disconnected';
  const dotClass = STATUS_DOT_CLASS[resolved];
  const label = resolved;
  return (
    <>
      <div className="flex items-center gap-2">
        <Badge variant="secondary" className="gap-1.5 font-mono text-[10px]">
          <span className={`inline-block size-2 rounded-full ${dotClass}`} aria-hidden="true" />
          {label}
        </Badge>
        {resolved === 'connected' ? (
          <Badge variant="outline" className="nums font-mono text-[10px]">
            {toolCount === 1
              ? t('mcp.toolOne', { count: toolCount })
              : t('mcp.toolMany', { count: toolCount })}
          </Badge>
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

/**
 * The expandable tool-inspection panel for a connected proxy server. Lazily
 * fetches the tool list when first opened, then caches locally; the Refresh
 * button re-pulls from the upstream. Each tool can expand to show its
 * inputSchema parameters.
 */
function ToolList({
  serverId,
  serverName,
  logout,
}: {
  serverId: string;
  serverName: string;
  logout: () => void;
}) {
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

  // Fetch once on mount (the panel only renders when the row is expanded).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loaded = await load();
      if (!cancelled) setTools(loaded);
    })();
    return () => {
      cancelled = true;
    };
  }, [load]);

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

  return (
    <>
      <div>
        <div className="mb-2 flex items-center gap-2">
          <span className="text-muted-foreground text-xs font-medium">
            {tools ? t('mcp.toolsHeaderCount', { count: tools.length }) : t('mcp.toolsHeader')}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground h-7"
            disabled={refreshing}
            onClick={refresh}
          >
            <RefreshCwIcon className={`size-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            {t('mcp.refresh')}
          </Button>
        </div>
        {tools === null ? (
          <p className="text-muted-foreground text-xs">{t('mcp.loadingTools')}</p>
        ) : tools.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t('mcp.noTools')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {tools.map((tool) => (
              <ToolRow key={tool.name} tool={tool} />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/** One tool row with an expandable parameter detail. */
function ToolRow({ tool }: { tool: McpToolInfo }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const params = extractParams(tool.inputSchema);
  return (
    <>
      <li>
        <Collapsible open={open} onOpenChange={setOpen}>
          <div className="flex items-center gap-2">
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-left"
              >
                <ChevronRightIcon
                  className={`size-3.5 transition-transform ${open ? 'rotate-90' : ''}`}
                />
                <code className="text-foreground text-xs font-medium">{tool.name}</code>
              </button>
            </CollapsibleTrigger>
            {tool.description ? (
              <span className="text-muted-foreground truncate text-xs" title={tool.description}>
                — {tool.description}
              </span>
            ) : null}
          </div>
          <CollapsibleContent>
            <div className="ml-5 mt-1">
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
            </div>
          </CollapsibleContent>
        </Collapsible>
      </li>
    </>
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
            <div className="grid content-start gap-2">
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
            <div className="grid content-start gap-2">
              <Label htmlFor="mcp-dial-site">{t('mcp.dialSite')}</Label>
              <Select value={dialSite} onValueChange={(v) => setDialSite(v as DialSite)}>
                <SelectTrigger id="mcp-dial-site">
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
            <div className="grid content-start gap-2">
              <Label htmlFor="mcp-type">{t('mcp.transport')}</Label>
              <Select value={type} onValueChange={(v) => onTypeChange(v as TransportType)}>
                <SelectTrigger id="mcp-type">
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
            <div className="grid content-start gap-2">
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
