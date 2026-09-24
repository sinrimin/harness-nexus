import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { RefreshCwIcon } from 'lucide-react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n } from '@/i18n';
import { appSocket, type InventoryUpdatedEvent, type MachineStatusEvent } from '@/realtime';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Lamp, PageIntro, Well } from '@/components/kit';
import { usePageTitle } from '@/components/shell/page-slots';
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
 * Machine detail (Phase 8 C3 + Phase 9 W1, restructured into tabs 2026-09):
 * a slim always-visible header (identity + scan) over four task-oriented
 * tabs — 概览 (identity + settings) / 代理 (runtime management) / 清单
 * (scanned items + diff/import) / 部署与作业 (deployments, jobs, adapter
 * processes). Data loads ONCE here; every tab pane stays mounted
 * (`forceMount` + hidden) so switching never loses form state and costs
 * nothing extra — the pre-tab page mounted all of this at once anyway.
 * Signal rules: the online dot is the only state color in the header; tabs
 * are quiet navigation and never spend `--signal`.
 */
export function MachineDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { logout } = useAuth();
  const { t } = useI18n();
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

  // Live updates: presence patches the header; a fresh snapshot refetches.
  useEffect(() => {
    const socket = appSocket();
    const onStatus = (e: MachineStatusEvent): void => {
      setMachine((prev) =>
        prev && prev.id === e.machineId
          ? {
              ...prev,
              online: e.online,
              lastSeenAt: e.lastSeenAt,
              ...(e.daemonVersion !== undefined ? { daemonVersion: e.daemonVersion } : {}),
            }
          : prev,
      );
    };
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
    socket.on('machine:status', onStatus);
    socket.on('inventory:updated', onInventory);
    socket.on('job:update', onJobUpdate);
    return () => {
      socket.off('machine:status', onStatus);
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

  return (
    <>
      <PageIntro
        sub={
          <>
            <Lamp
              state={machine?.online === true ? 'online' : 'offline'}
              word={
                machine?.online === true ? t('machineDetail.online') : t('machineDetail.offline')
              }
            />
            {machine?.hostname ? (
              <Well variant="chip" copy={machine.hostname}>
                {[machine.hostname, machine.os, machine.arch].filter(Boolean).join(' · ')}
              </Well>
            ) : null}
            {machine?.daemonVersion ? (
              <Well variant="chip" copy={machine.daemonVersion}>
                {t('machineDetail.daemonVersion', { version: machine.daemonVersion })}
              </Well>
            ) : null}
          </>
        }
      />

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <Button onClick={() => void scan()} disabled={scanning || machine?.online !== true}>
          <RefreshCwIcon className={scanning ? 'size-4 animate-spin' : 'size-4'} />
          {scanning ? t('machineDetail.scanning') : t('machineDetail.scanNow')}
        </Button>
        <span className="text-muted-foreground text-sm">
          {machine?.online !== true
            ? t('machineDetail.scanHintOffline')
            : t('machineDetail.scanHint')}
        </span>
      </div>

      <Tabs value={tab} onValueChange={onTabChange}>
        <TabsList>
          <TabsTrigger value="overview">{t('machineDetail.tabOverview')}</TabsTrigger>
          <TabsTrigger value="agents">{t('machineDetail.tabAgents')}</TabsTrigger>
          <TabsTrigger value="inventory">{t('machineDetail.tabInventory')}</TabsTrigger>
          <TabsTrigger value="deploy">{t('machineDetail.tabDeploy')}</TabsTrigger>
        </TabsList>

        {/*
          Every pane forceMounts and hides via data-state — form state survives
          tab switches and the fetch cost equals the old single long page.
        */}
        <TabsContent value="overview" forceMount className="data-[state=inactive]:hidden">
          <OverviewTab machine={machine} onChanged={() => void refresh()} />
        </TabsContent>
        <TabsContent value="agents" forceMount className="data-[state=inactive]:hidden">
          {inventory === null ? (
            <p className="text-muted-foreground py-8 text-center text-sm">
              {t('machineDetail.loadingInventory')}
            </p>
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
            online={machine?.online === true}
            jobs={jobs}
            agents={agents}
            onChanged={refreshJobs}
            capabilities={machine?.capabilities ?? []}
          />
        </TabsContent>
      </Tabs>
    </>
  );
}
