import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { LaptopIcon, RefreshCwIcon } from 'lucide-react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n, dateLocale } from '@/i18n';
import { appSocket, type InventoryUpdatedEvent } from '@/realtime';
import { patchMachine } from '@/lib/machine-presence.js';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Lamp, Panel, PanelHeader, Well } from '@/components/kit';
import { PageSlot, usePageTitle } from '@/components/shell/page-slots';
import { useMachineStatus } from '@/components/shell/use-presence.js';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  HarnessNexusError,
  type AgentInstanceView,
  type JobView,
  type MachineView,
} from '@harness-nexus/sdk';
import { OverviewTab } from './overview-tab.js';
import { AgentsTab } from './agents-tab.js';
import { InventoryTab } from './inventory-tab.js';
import { DeployTab } from './deploy-tab.js';
import type { InventoryEntry } from './types.js';

/** Wire shape of `job:update` (mirrors shared/realtime.ts). */
interface JobUpdateEvent {
  job: JobView;
}

/** The `?tab=` values (deep-linkable; default 概览). */
type TabValue = 'overview' | 'agents' | 'inventory' | 'deploy';
const TAB_VALUES: readonly TabValue[] = ['overview', 'agents', 'inventory', 'deploy'];

/**
 * Machine detail (Phase 8 C3 + Phase 9 W1; P5 reshaped the shell).
 *
 * The page is ONE panel whose nameplate is the machine's wire identity (host,
 * platform, daemon version, presence) and whose last row is the tab bar — the
 * tabs are the panel's own bottom edge, not a page-level strip (01-skeleton.md
 * §7.3). Data loads ONCE here; every tab pane stays mounted (`forceMount` +
 * hidden) so switching never loses form state and costs nothing extra — the
 * pre-tab page mounted all of this at once anyway.
 *
 * The name stays the `<h1>` in the topbar (P2 owns page identity); the panel
 * carries the *facts* instead, so the same name is never printed twice on one
 * screen. Signal rules: presence is the only state color in the nameplate;
 * tabs are quiet navigation and never spend `--signal`.
 */
export function MachineDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { logout } = useAuth();
  const { t, lang } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const tab: TabValue = TAB_VALUES.includes(tabParam as TabValue)
    ? (tabParam as TabValue)
    : 'overview';
  const [machine, setMachine] = useState<MachineView | null>(null);
  const [inventory, setInventory] = useState<InventoryEntry[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [jobs, setJobs] = useState<JobView[] | null>(null);
  const [agents, setAgents] = useState<AgentInstanceView[]>([]);

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const [m, inv] = await Promise.all([
        withAuthGuard(() => api.getMachine(id), logout),
        withAuthGuard(() => api.getMachineInventory(id), logout),
      ]);
      setMachine(m);
      setInventory(inv);
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('machineDetail.loadFailed'));
    }
  }, [id, logout, t]);

  const refreshJobs = useCallback(async () => {
    if (!id) return;
    try {
      const [jobs, agents] = await Promise.all([
        withAuthGuard(() => api.listMachineJobs(id), logout),
        withAuthGuard(() => api.listMachineAgents(id), logout),
      ]);
      setJobs(jobs);
      setAgents(agents);
    } catch {
      // job data is supplementary — a failure here doesn't blank the page
    }
  }, [id, logout]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void refreshJobs();
  }, [refreshJobs]);

  // Live updates: presence patches the nameplate (shared patch — P5), a fresh
  // inventory snapshot or a finished job refetches.
  useMachineStatus((e) => setMachine((prev) => (prev === null ? prev : patchMachine(prev, e))));
  useEffect(() => {
    const socket = appSocket();
    const onInventory = (e: InventoryUpdatedEvent): void => {
      if (e.machineId === id) void refresh();
    };
    const onJobUpdate = (e: JobUpdateEvent): void => {
      if (e.job.machineId !== id) return;
      setJobs((prev) => {
        const list = prev ?? [];
        return list.some((j) => j.id === e.job.id)
          ? list.map((j) => (j.id === e.job.id ? e.job : j))
          : [e.job, ...list];
      });
      if (e.job.status === 'succeeded' || e.job.status === 'failed') void refreshJobs();
    };
    socket.on('inventory:updated', onInventory);
    socket.on('job:update', onJobUpdate);
    return () => {
      socket.off('inventory:updated', onInventory);
      socket.off('job:update', onJobUpdate);
    };
  }, [id, refresh, refreshJobs]);

  async function scan(): Promise<void> {
    if (!id) return;
    setScanning(true);
    try {
      const result = await withAuthGuard(() => api.scanMachineInventory(id), logout);
      setInventory(
        result.map((r) => ({
          target: r.target,
          daemonVersion: machine?.daemonVersion ?? null,
          reportedAt: r.reportedAt,
          scannedAt: r.reportedAt,
          agents: r.agents,
          runtime: r.runtime ?? null,
        })),
      );
      toast.success(t('machineDetail.scannedToast', { count: result.length }));
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('machineDetail.scanFailed'));
    } finally {
      setScanning(false);
    }
  }

  const targets = useMemo(() => inventory?.map((i) => i.target) ?? [], [inventory]);

  const onTabChange = (v: string): void => {
    // Overview is the default — keep its URL clean.
    setSearchParams(v === 'overview' ? {} : { tab: v }, { replace: true });
  };

  // The machine's name is this page's identity, so it rides the topbar (with the
  // MESH crumb back to the list — the old back button is gone). A string, not a
  // portal: `page-slots.tsx` explains why.
  usePageTitle(machine?.name ?? t('machineDetail.fallbackTitle'));

  const online = machine?.online === true;
  const platform = [machine?.os, machine?.arch].filter(Boolean).join(' · ');

  return (
    <>
      {/* A page-level action belongs in the chrome (P2's topbar slot): scanning
          is what this page DOES, so it does not take a content row of its own. */}
      <PageSlot slot="actions">
        <Button onClick={() => void scan()} disabled={scanning || !online}>
          <RefreshCwIcon className={scanning ? 'size-4 animate-spin' : 'size-4'} />
          {scanning ? t('machineDetail.scanning') : t('machineDetail.scanNow')}
        </Button>
      </PageSlot>

      <Tabs value={tab} onValueChange={onTabChange}>
        <Panel>
          <PanelHeader
            label={t('machineDetail.machineLabel')}
            icon={<LaptopIcon />}
            meta={
              machine?.lastSeenAt === null || machine?.lastSeenAt === undefined ? undefined : (
                <span className="hidden sm:inline">
                  {t('machineDetail.lastSeenInline', {
                    time: new Date(machine.lastSeenAt).toLocaleString(dateLocale(lang)),
                  })}
                </span>
              )
            }
            actions={
              <Lamp
                state={online ? 'online' : 'offline'}
                word={online ? t('machineDetail.online') : t('machineDetail.offline')}
              />
            }
          >
            {/*
              ONE line, always (the nameplate never grows into the tab row).
              Facts that no longer fit are dropped, not wrapped: the phone keeps
              the host and the version, the platform and the last-seen figure
              come back from `md` up. `min-w-0` + `overflow-hidden` is what makes
              a too-long hostname truncate inside its Well instead of pushing the
              strip taller.
            */}
            <span className="flex min-w-0 flex-nowrap items-center gap-1.5 overflow-hidden">
              {machine?.hostname ? (
                <Well variant="chip" copy={machine.hostname}>
                  {machine.hostname}
                </Well>
              ) : null}
              {platform !== '' ? (
                <Well variant="chip" className="hidden md:inline-flex">
                  {platform}
                </Well>
              ) : null}
              {machine?.daemonVersion ? (
                <Well variant="chip" copy={machine.daemonVersion}>
                  {t('machineDetail.daemonVersion', { version: machine.daemonVersion })}
                </Well>
              ) : null}
              {!online ? (
                <span className="text-muted-foreground hidden truncate text-xs sm:inline">
                  {t('machineDetail.scanHintOffline')}
                </span>
              ) : null}
            </span>
          </PanelHeader>

          {/* The panel's own bottom edge: no border of its own, so the panel's
              frame closes the strip instead of a doubled hairline. */}
          <TabsList className="h-9 rounded-none border-b-0 px-(--panel-pad)">
            <TabsTrigger value="overview">{t('machineDetail.tabOverview')}</TabsTrigger>
            <TabsTrigger value="agents">{t('machineDetail.tabAgents')}</TabsTrigger>
            <TabsTrigger value="inventory">{t('machineDetail.tabInventory')}</TabsTrigger>
            <TabsTrigger value="deploy">{t('machineDetail.tabDeploy')}</TabsTrigger>
          </TabsList>
        </Panel>

        {/*
          The panes live outside the identity panel and stay mounted (`forceMount`
          + hidden): form state survives tab switches, and the fetch cost equals
          the old single long page.
        */}
        <div className="mt-(--gap)">
          <TabsContent value="overview" forceMount className="data-[state=inactive]:hidden">
            <OverviewTab machine={machine} onChanged={() => void refresh()} />
          </TabsContent>
          <TabsContent value="agents" forceMount className="data-[state=inactive]:hidden">
            {inventory === null ? (
              <Card>
                <CardContent className="text-muted-foreground py-8 text-center text-sm">
                  {t('machineDetail.loadingInventory')}
                </CardContent>
              </Card>
            ) : inventory.length === 0 ? (
              <Card>
                <CardContent className="text-muted-foreground py-8 text-center text-sm">
                  {t('machineDetail.emptyInventory')}
                </CardContent>
              </Card>
            ) : (
              <AgentsTab
                inventory={inventory}
                machineId={id!}
                machine={machine}
                onChanged={() => void refresh()}
              />
            )}
          </TabsContent>
          <TabsContent value="inventory" forceMount className="data-[state=inactive]:hidden">
            <InventoryTab inventory={inventory} machineId={id!} targets={targets} />
          </TabsContent>
          <TabsContent value="deploy" forceMount className="data-[state=inactive]:hidden">
            <DeployTab
              machineId={id!}
              online={online}
              jobs={jobs}
              agents={agents}
              onChanged={refreshJobs}
              capabilities={machine?.capabilities ?? []}
            />
          </TabsContent>
        </div>
      </Tabs>
    </>
  );
}