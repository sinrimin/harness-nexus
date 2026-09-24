import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ArrowRightIcon,
  BoxesIcon,
  KeyRoundIcon,
  LaptopIcon,
  LayersIcon,
  PlugZapIcon,
  SettingsIcon,
  UsersIcon,
} from 'lucide-react';
import { useAuth, withAuthGuard } from '@/auth';
import { api } from '@/api';
import { useI18n } from '@/i18n';
import { useMachineStatus } from '@/components/shell/use-presence.js';
import { patchMachineList } from '@/lib/machine-presence.js';
import {
  HarnessNexusError,
  type AgentInstanceView,
  type CredentialView,
  type LlmProviderView,
  type MachineView,
  type McpServer,
  type McpServerStatus,
  type Profile,
  type Resource,
} from '@harness-nexus/sdk';
import { MeshTopology, type FleetNode } from '@/components/mesh-topology';
import { Button } from '@/components/ui/button';
import { Chip, Lamp, PageIntro, Readout } from '@/components/kit';

/**
 * Overview — the fleet posture page. The constellation hero draws the whole
 * product (upstreams → nexus → machines, every dot a real state), the
 * figures strip answers "what's alive", and the two columns below are the
 * working entries: the fleet list (machine → manage, agent chip → chat) and
 * the assets panel. Machine presence flips LIVE on `machine:status` pushes.
 */
export function DashboardPage() {
  const { user, logout } = useAuth();
  const { t } = useI18n();
  const isAdmin = user?.role === 'admin';

  const [machines, setMachines] = useState<MachineView[] | null>(null);
  const [agentsByMachine, setAgentsByMachine] = useState<Map<string, AgentInstanceView[]> | null>(
    null,
  );
  const [servers, setServers] = useState<McpServer[] | null>(null);
  // null = fetch failed/unavailable — the MCP figure degrades to the bare total.
  const [statuses, setStatuses] = useState<McpServerStatus[] | null>(null);
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [resources, setResources] = useState<Resource[] | null>(null);
  const [creds, setCreds] = useState<CredentialView[] | null>(null);
  const [providers, setProviders] = useState<LlmProviderView[] | null>(null);

  // Parallel fetch — every list is independent, so don't serialize them.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [m, s, st, p, r, c, lp] = await Promise.all([
          withAuthGuard(() => api.listMachines(), logout),
          withAuthGuard(() => api.listMcpServers(), logout),
          withAuthGuard(() => api.listMcpServerStatuses().catch(() => null), logout) as Promise<
            McpServerStatus[] | null
          >,
          withAuthGuard(() => api.listProfiles(), logout),
          withAuthGuard(() => api.listResources(), logout),
          withAuthGuard(() => api.listCredentials(), logout),
          withAuthGuard(() => api.listLlmProviders(), logout),
        ]);
        if (cancelled) return;
        setMachines(m);
        setServers(s);
        setStatuses(st);
        setProfiles(p);
        setResources(r);
        setCreds(c);
        setProviders(lp);
        // Agents per machine — independent lists, parallel (the Chat page's
        // pattern); a failing per-machine list degrades to "no agents" only.
        const entries = await Promise.all(
          m.map(async (x) => [x.id, await api.listMachineAgents(x.id).catch(() => [])] as const),
        );
        if (cancelled) return;
        setAgentsByMachine(new Map(entries));
      } catch (e) {
        if (cancelled) return;
        toast.error(e instanceof HarnessNexusError ? e.message : t('dashboard.loadFailed'));
        setMachines([]);
        setAgentsByMachine(new Map());
        setServers([]);
        setStatuses(null);
        setProfiles([]);
        setResources([]);
        setCreds([]);
        setProviders([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [logout]);

  // Live presence: flip machine dots/rows in place on machine:status pushes.
  useMachineStatus((e) => setMachines((prev) => patchMachineList(prev, e)));

  if (!user) return null;

  const onlineCount = (machines ?? []).filter((m) => m.online).length;
  const agentTotal = (agentsByMachine ? [...agentsByMachine.values()] : []).reduce(
    (n, list) => n + list.length,
    0,
  );
  const connectedUpstreams =
    statuses !== null ? statuses.filter((s) => s.status === 'connected').length : null;

  const fleetNodes: FleetNode[] = (machines ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    online: m.online,
    agentCount: agentsByMachine?.get(m.id)?.length ?? 0,
  }));

  return (
    <>
      {/* Hero — the signature. The constellation IS the product: upstreams
          converge on the nexus, the nexus reaches out to the fleet. */}
      <section className="mb-6">
        <PageIntro sub={t('dashboard.subtitle')} className="mb-3" />
        <MeshTopology
          servers={servers ?? []}
          loading={servers === null}
          statuses={statuses ?? undefined}
          machines={fleetNodes}
        />
      </section>

      {/* Posture figures — a quiet typographic strip, each figure routes on.
          No rules: the hero card above already ends in a border. */}
      <section className="mb-8 grid grid-cols-2 gap-x-6 gap-y-4 py-4 sm:grid-cols-4">
        <Readout
          to="/machines"
          label={t('dashboard.machinesOnline')}
          value={onlineCount}
          total={machines?.length ?? 0}
          loading={machines === null}
        />
        <Readout
          to="/chat"
          label={t('dashboard.agentsFigure')}
          value={agentTotal}
          loading={agentsByMachine === null}
        />
        <Readout
          to="/mcp-servers"
          label={t('dashboard.mcpConnected')}
          value={connectedUpstreams ?? servers?.length ?? 0}
          {...(connectedUpstreams !== null ? { total: servers?.length ?? 0 } : {})}
          loading={servers === null}
        />
        <Readout
          to="/llm-providers"
          label={t('dashboard.providersFigure')}
          value={providers?.length ?? 0}
          loading={providers === null}
        />
      </section>

      {/* Working entries — the fleet (left, wide) and the assets (right). */}
      <section className="grid gap-6 lg:grid-cols-[1fr_300px]">
        <div>
          <div className="mb-2">
            <h2 className="text-base font-semibold">{t('dashboard.fleetHeading')}</h2>
            <p className="text-muted-foreground text-xs">{t('dashboard.fleetHint')}</p>
          </div>
          {machines === null ? (
            <p className="text-muted-foreground py-6 text-center text-sm" role="status">
              {t('common.loading')}
            </p>
          ) : machines.length === 0 ? (
            <div className="border-muted-foreground/20 bg-muted/30 flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-8 text-center">
              <LaptopIcon className="text-muted-foreground size-6" />
              <div>
                <p className="text-foreground text-sm font-medium">{t('dashboard.noMachines')}</p>
                <p className="text-muted-foreground mt-1 text-xs">
                  {t('dashboard.noMachinesHint')}
                </p>
              </div>
              <Button asChild size="sm" className="mt-1">
                <Link to="/machines">
                  <LaptopIcon className="size-4" /> {t('dashboard.noMachinesAction')}
                </Link>
              </Button>
            </div>
          ) : (
            <div className="border-border divide-border rounded-xl border">
              {machines.slice(0, 8).map((m) => (
                <FleetRow key={m.id} machine={m} agents={agentsByMachine?.get(m.id) ?? []} />
              ))}
              {machines.length > 8 ? (
                <Link
                  to="/machines"
                  className="text-muted-foreground hover:text-signal flex items-center justify-end gap-1 px-4 py-2 text-xs transition-colors"
                >
                  {t('dashboard.moreMachinesLink')}
                  <ArrowRightIcon className="size-3.5" />
                </Link>
              ) : null}
            </div>
          )}
        </div>

        <div>
          <div className="mb-2">
            <h2 className="text-base font-semibold">{t('dashboard.assetsHeading')}</h2>
            <p className="text-muted-foreground text-xs">{t('dashboard.assetsHint')}</p>
          </div>
          <div className="border-border divide-border rounded-xl border">
            <AssetRow
              to="/profiles"
              icon={<LayersIcon className="size-4" />}
              label={t('dashboard.assetProfiles')}
              count={profiles?.length}
            />
            <AssetRow
              to="/resources"
              icon={<BoxesIcon className="size-4" />}
              label={t('dashboard.assetResources')}
              count={resources?.length}
            />
            <AssetRow
              to="/credentials"
              icon={<KeyRoundIcon className="size-4" />}
              label={t('dashboard.assetCredentials')}
              count={creds?.length}
            />
            <AssetRow
              to="/llm-providers"
              icon={<PlugZapIcon className="size-4" />}
              label={t('dashboard.assetProviders')}
              count={providers?.length}
            />
            {isAdmin ? (
              <>
                <AssetRow
                  to="/admin/users"
                  icon={<UsersIcon className="size-4" />}
                  label={t('dashboard.users')}
                />
                <AssetRow
                  to="/admin/settings"
                  icon={<SettingsIcon className="size-4" />}
                  label={t('dashboard.settings')}
                />
              </>
            ) : null}
          </div>
        </div>
      </section>

      <p className="text-muted-foreground mt-6 text-xs">
        {t('dashboard.footerPrefix')} <code className="font-mono">/mcp?profile=&lt;id&gt;</code>
        {t('dashboard.footerSuffix')}
      </p>
    </>
  );
}

/** One posture figure — label above, big mono number below, whole cell routes. */
/**
 * One fleet row: presence dot + machine name (→ machine detail) on the left,
 * agent chips (→ that agent's chat session) on the right. Nested links are
 * siblings, never nested — the name is the row link, chips stand alone.
 */
function FleetRow({ machine, agents }: { machine: MachineView; agents: AgentInstanceView[] }) {
  const { t } = useI18n();
  const shown = agents.slice(0, 3);
  const overflow = agents.length - shown.length;
  return (
    <>
      <div className="hover:bg-muted/40 flex items-center gap-3 px-4 py-2.5 transition-colors">
        <Lamp
          state={machine.online ? 'online' : 'offline'}
          label={machine.online ? t('dashboard.legendOnline') : t('dashboard.legendOffline')}
        />
        <Link
          to={`/machines/${machine.id}`}
          className="group/min min-w-0 flex-1"
          title={machine.name}
        >
          <span className="block truncate text-sm font-medium group-hover/min:text-signal transition-colors">
            {machine.name}
          </span>
          <span className="text-muted-foreground block truncate font-mono text-xs tabular-nums">
            {machine.daemonVersion ?? '—'}
          </span>
        </Link>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
          {agents.length === 0 ? (
            <span className="text-muted-foreground text-xs">{t('dashboard.noAgents')}</span>
          ) : (
            <>
              {shown.map((a) => (
                <Chip key={a.id} to={`/chat/agents/${a.id}`} title={`${a.name} · ${a.source}`}>
                  {a.target}
                </Chip>
              ))}
              {overflow > 0 ? (
                <Chip to={`/machines/${machine.id}`} tone="muted">
                  {t('dashboard.moreAgents', { count: overflow })}
                </Chip>
              ) : null}
            </>
          )}
        </div>
      </div>
    </>
  );
}

/** One asset row — icon + label + mono count, arrow on hover. */
function AssetRow({
  to,
  icon,
  label,
  count,
}: {
  to: string;
  icon: ReactNode;
  label: string;
  count?: number;
}) {
  return (
    <>
      <Link
        to={to}
        className="hover:bg-muted/40 flex items-center gap-2.5 px-4 py-2.5 text-sm transition-colors"
      >
        <span className="text-muted-foreground">{icon}</span>
        <span className="flex-1 truncate">{label}</span>
        {count !== undefined ? (
          <span className="text-muted-foreground font-mono text-xs tabular-nums">{count}</span>
        ) : (
          <ArrowRightIcon className="text-muted-foreground/50 size-4" />
        )}
      </Link>
    </>
  );
}
