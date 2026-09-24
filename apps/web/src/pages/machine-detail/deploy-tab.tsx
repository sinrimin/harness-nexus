import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { CpuIcon, MessageSquareIcon, RefreshCwIcon, RocketIcon, SquareIcon } from 'lucide-react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n, dateLocale } from '@/i18n';
import {
  HarnessNexusError,
  type AdapterProcessView,
  type AgentInstanceView,
  type JobView,
  type Profile,
} from '@harness-nexus/sdk';
import { StateSignal } from '@/components/state-signal';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DataTable, Note, Panel, PanelBody, Readout, tableState, Well } from '@/components/kit';

/**
 * 部署与作业 tab — the machine's operational surface: profile deployments +
 * the job table + agent instances (Phase 8 C4), and the live adapter-process
 * panel with the operator kill (Phase 9 W11 C).
 *
 * P5 turned the two hand-rolled tables (a `Card > div.border > Table` shell and
 * two flavours of centred `colSpan` state row) into `DataTable`s: the panel, the
 * head, the row geometry and the four state rows are the kit's, and the page
 * keeps only the columns. Job type/status/detail are the devices the content
 * map asks for — a chip for the type, a lamp + word for the status, a chip for
 * the detail, and one plain sentence for the single place a failure is prose.
 */
export function DeployTab({
  machineId,
  online,
  jobs,
  agents,
  onChanged,
  capabilities,
}: {
  machineId: string;
  online: boolean;
  jobs: JobView[] | null;
  agents: AgentInstanceView[];
  onChanged: () => void;
  capabilities: string[];
}) {
  return (
    <div className="flex flex-col gap-(--gap)">
      <DeploymentsPanel
        machineId={machineId}
        online={online}
        jobs={jobs}
        onChanged={onChanged}
      />
      <AgentsTable agents={agents} />
      <AdaptersPanel machineId={machineId} online={online} capabilities={capabilities} />
    </div>
  );
}

/** Job wire status → signal state (state colors only; --signal unused). */
const JOB_STATUS_SIGNAL: Record<string, 'succeeded' | 'failed' | 'running' | 'cancelled'> = {
  succeeded: 'succeeded',
  failed: 'failed',
  running: 'running',
  cancelled: 'cancelled',
};

/** Status → the rail word, so the two channels never disagree (02-content.md §3.3). */
const JOB_STATUS_WORD: Record<string, string> = {
  succeeded: 'succeeded',
  failed: 'failed',
  running: 'running',
  queued: 'queued',
  cancelled: 'cancelled',
};

/**
 * The job-table detail cell: error text, the queued hint, or — for succeeded
 * #6 marketplace deploys — `marketplace · <plugin> v<version>` from the result
 * payload (read defensively; adapter results have no `method`).
 */
function jobDetail(job: JobView, t: ReturnType<typeof useI18n>['t']): { text: string; fail: boolean } {
  if (job.error) return { text: job.error, fail: true };
  if (job.status === 'queued') return { text: t('machineDetail.waitingDaemon'), fail: false };
  if (job.status === 'succeeded' && job.result && typeof job.result === 'object') {
    const r = job.result as { method?: unknown; name?: unknown; installedVersion?: unknown };
    if (r.method === 'marketplace') {
      const name = typeof r.name === 'string' ? r.name : '';
      const ver = typeof r.installedVersion === 'string' ? ` v${r.installedVersion}` : '';
      return { text: `${t('machineDetail.viaMarketplace')} · ${name}${ver}`, fail: false };
    }
  }
  return { text: '—', fail: false };
}

/**
 * Deploy jobs + deployed agent instances (Phase 8 C4). A deploy queues when
 * the daemon is offline and replays on reconnect — the toolbar says so through
 * the button's own label instead of hiding the queue.
 */
function DeploymentsPanel({
  machineId,
  online,
  jobs,
  onChanged,
}: {
  machineId: string;
  online: boolean;
  jobs: JobView[] | null;
  onChanged: () => void;
}) {
  const { logout } = useAuth();
  const { t, lang } = useI18n();
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [profileId, setProfileId] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const all = await withAuthGuard(() => api.listProfiles(), logout);
        // Local-write adapters (hermes/codex/deepseek/pi) + claude-code, which
        // deploys through the 3.5 marketplace emitter (#6): the daemon drives
        // CC's own plugin CLI — same button, install-or-update.
        setProfiles(
          all.filter(
            (p) =>
              p.target === 'hermes' ||
              p.target === 'codex' ||
              p.target === 'deepseek' ||
              p.target === 'pi' ||
              p.target === 'claude-code',
          ),
        );
      } catch {
        setProfiles([]);
      }
    })();
  }, [logout]);

  async function deploy(): Promise<void> {
    if (!profileId) return;
    setBusy(true);
    try {
      await withAuthGuard(() => api.createMachineJob(machineId, { profileId }), logout);
      toast.success(online ? t('machineDetail.dispatchToast') : t('machineDetail.queuedToast'));
      onChanged();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('machineDetail.deployFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(job: JobView): Promise<void> {
    try {
      await withAuthGuard(() => api.cancelJob(job.id), logout);
      onChanged();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('machineDetail.cancelFailed'));
    }
  }

  const jobCount = jobs?.length ?? 0;

  return (
    <DataTable
      columns={4}
      label={t('machineDetail.deployTitle')}
      icon={<RocketIcon />}
      meta={<Readout layout="inline" size="sm" value={jobCount} label={t('machineDetail.jobsFigure')} />}
      state={tableState({ loading: jobs === null, count: jobCount })}
      empty={{
        title: t('machineDetail.noJobsTitle'),
        hint: t('machineDetail.noJobsHint'),
      }}
      toolbar={
        <>
          <div className="flex items-center gap-2">
            <Label htmlFor="deploy-profile" className="sr-only">
              {t('machineDetail.profileLabel')}
            </Label>
            <Select value={profileId} onValueChange={setProfileId}>
              <SelectTrigger id="deploy-profile" className="h-8 w-64 font-mono text-xs">
                <SelectValue placeholder={t('machineDetail.pickProfile')} />
              </SelectTrigger>
              <SelectContent>
                {(profiles ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id} className="font-mono text-xs">
                    {p.name} (
                    {p.target === 'claude-code'
                      ? `claude-code · ${t('machineDetail.viaMarketplace')}`
                      : p.target}
                    )
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button size="sm" onClick={() => void deploy()} disabled={busy || profileId === ''}>
            <RocketIcon className="size-3.5" />
            {busy
              ? t('machineDetail.creating')
              : online
                ? t('machineDetail.deploy')
                : t('machineDetail.queueDeploy')}
          </Button>
          <span className="text-muted-foreground text-xs">
            {profiles !== null && profiles.length === 0 ? t('machineDetail.noDeployable') : null}
          </span>
        </>
      }
    >
      <TableHeader>
        <TableRow>
          <TableHead>{t('machineDetail.job')}</TableHead>
          <TableHead>{t('common.status')}</TableHead>
          <TableHead>{t('machineDetail.detail')}</TableHead>
          <TableHead className="text-right">{t('common.actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {(jobs ?? []).map((job) => {
          const detail = jobDetail(job, t);
          return (
            <TableRow key={job.id}>
              <TableCell>
                <span className="flex items-center gap-2">
                  {/* Job type is an enum → Badge; the timestamp is numeric data →
                      the data role (02-content.md §4). */}
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {job.type}
                  </Badge>
                  <span className="text-muted-foreground role-data-sm">
                    {new Date(job.createdAt).toLocaleString(dateLocale(lang))}
                  </span>
                </span>
              </TableCell>
              <TableCell>
                <span className="inline-flex items-center gap-2">
                  <StateSignal state={JOB_STATUS_SIGNAL[job.status] ?? 'inactive'} />
                  <span className="role-data text-xs">{JOB_STATUS_WORD[job.status] ?? job.status}</span>
                </span>
              </TableCell>
              <TableCell className="max-w-[28rem]">
                {detail.fail ? (
                  // The one place a long sentence is allowed — a failure detail.
                  <span className="text-state-fail-ink line-clamp-2 text-xs">{detail.text}</span>
                ) : (
                  <span className="text-muted-foreground truncate text-xs">{detail.text}</span>
                )}
              </TableCell>
              <TableCell className="text-right">
                {job.status === 'queued' ? (
                  <Button variant="ghost" size="sm" onClick={() => void cancel(job)}>
                    <SquareIcon className="size-3.5" />
                    {t('common.cancel')}
                  </Button>
                ) : null}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </DataTable>
  );
}

/** 9 W11 C — uptime for an adapter row (startedAt is an epoch-ms number). */
function adapterUptime(startedAt: number, locale: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - startedAt) / 60000));
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (minutes < 60) return rtf.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return rtf.format(-hours, 'hour');
  return rtf.format(-Math.round(hours / 24), 'day');
}

/**
 * 9 W11 C — the adapter-process panel: present-tense PROCESS truth from the
 * daemon (`adapters:report` over /ctl), on-demand from the machine page. The
 * per-row 终止 is the OPERATOR kill (owner-or-admin); the owner's everyday
 * path remains the chat tab bar's ×.
 */
function AdaptersPanel({
  machineId,
  online,
  capabilities,
}: {
  machineId: string;
  online: boolean;
  capabilities: string[];
}) {
  const { logout } = useAuth();
  const { t, lang } = useI18n();
  const [rows, setRows] = useState<AdapterProcessView[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [killing, setKilling] = useState<string | null>(null);
  const available = online && capabilities.includes('chat');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await withAuthGuard(() => api.listMachineAdapters(machineId), logout));
    } catch (e) {
      setRows([]);
      toast.error(
        e instanceof HarnessNexusError ? e.message : t('machineDetail.adaptersLoadFailed'),
      );
    } finally {
      setLoading(false);
    }
  }, [machineId, logout, t]);

  useEffect(() => {
    if (available) void load();
    else setRows(null);
  }, [available, load]);

  async function kill(sessionId: string): Promise<void> {
    if (!window.confirm(t('machineDetail.adapterKillConfirm'))) return;
    setKilling(sessionId);
    try {
      await withAuthGuard(() => api.closeMachineAdapter(machineId, sessionId), logout);
      toast.success(t('machineDetail.adapterKilled'));
      await load();
    } catch (e) {
      toast.error(
        e instanceof HarnessNexusError ? e.message : t('machineDetail.adaptersLoadFailed'),
      );
    } finally {
      setKilling(null);
    }
  }

  // Unavailable is not an empty table: the report needs a live daemon with the
  // chat capability, and a Note says so where a centred sentence used to.
  if (!available) {
    return (
      <Panel label={t('machineDetail.adaptersTitle')} icon={<CpuIcon />}>
        <PanelBody>
          <Note title={t('machineDetail.adaptersOffline')} />
        </PanelBody>
      </Panel>
    );
  }

  const count = rows?.length ?? 0;
  return (
    <DataTable
      columns={5}
      label={t('machineDetail.adaptersTitle')}
      icon={<CpuIcon />}
      meta={
        <Readout
          layout="inline"
          size="sm"
          value={count}
          label={t('machineDetail.adaptersFigure')}
        />
      }
      actions={
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCwIcon className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
          {t('machineDetail.adaptersRefresh')}
        </Button>
      }
      state={tableState({ loading: rows === null || loading, count })}
      empty={{
        title: t('machineDetail.adaptersEmpty'),
        hint: t('machineDetail.adaptersEmptyHint'),
      }}
    >
      <TableHeader>
        <TableRow>
          <TableHead>{t('machineDetail.adapterTarget')}</TableHead>
          <TableHead>{t('machineDetail.adapterNative')}</TableHead>
          <TableHead>{t('machineDetail.adapterUptime')}</TableHead>
          <TableHead>PGID</TableHead>
          <TableHead className="text-right">{t('common.actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {(rows ?? []).map((a) => (
          <TableRow key={a.wireSessionId}>
            <TableCell>
              <Badge variant="outline" className="font-mono text-[10px]">
                {a.target}
              </Badge>
            </TableCell>
            <TableCell className="max-w-56">
              {a.nativeSessionId === null ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                <Well copy={a.nativeSessionId}>{a.nativeSessionId}</Well>
              )}
            </TableCell>
            <TableCell className="nums text-sm">{adapterUptime(a.startedAt, lang)}</TableCell>
            <TableCell className="role-data text-xs">{a.pgid}</TableCell>
            <TableCell className="text-right">
              <Button
                variant="ghost"
                size="sm"
                disabled={killing !== null}
                onClick={() => void kill(a.wireSessionId)}
              >
                {killing === a.wireSessionId ? t('common.saving') : t('machineDetail.adapterKill')}
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </DataTable>
  );
}

/** Agent instances (deployed or detected) as chips — the row links to chat. */
function AgentsTable({ agents }: { agents: AgentInstanceView[] }) {
  const { t } = useI18n();
  return (
    <DataTable
      columns={4}
      label={t('machineDetail.agentsTitle')}
      meta={<Readout layout="inline" size="sm" value={agents.length} label={t('machineDetail.agentsFigure')} />}
      state={tableState({ count: agents.length })}
      empty={{ title: t('machineDetail.noAgents') }}
    >
      <TableHeader>
        <TableRow>
          <TableHead>{t('common.name')}</TableHead>
          <TableHead>{t('machineDetail.adapterTarget')}</TableHead>
          <TableHead>{t('machineDetail.agentDirectory')}</TableHead>
          <TableHead className="text-right">{t('common.actions')}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {agents.map((a) => (
          <TableRow key={a.id}>
            <TableCell>
              <span className="flex items-center gap-2">
                <span className="truncate font-medium">{a.name}</span>
                {a.source === 'detected' ? (
                  <Badge variant="secondary" className="text-[10px]">
                    {t('machineDetail.detectedSource')}
                  </Badge>
                ) : null}
              </span>
            </TableCell>
            <TableCell>
              <Badge variant="outline" className="font-mono text-[10px]">
                {a.target}
              </Badge>
            </TableCell>
            <TableCell className="max-w-64">
              <Well copy={a.directory}>{a.directory}</Well>
            </TableCell>
            <TableCell className="text-right">
              <Button asChild variant="ghost" size="sm">
                <Link to={`/chat/agents/${a.id}`}>
                  <MessageSquareIcon className="size-3.5" />
                  {t('machineDetail.chat')}
                </Link>
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </DataTable>
  );
}