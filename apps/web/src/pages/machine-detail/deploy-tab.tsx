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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { StateSignal } from '@/components/state-signal';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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

/**
 * 部署与作业 tab — the machine's operational surface: profile deployments +
 * the job table + agent instances (Phase 8 C4), and the live adapter-process
 * panel with the operator kill (Phase 9 W11 C).
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
    <div className="flex flex-col gap-6">
      <DeploymentsCard
        machineId={machineId}
        online={online}
        jobs={jobs}
        agents={agents}
        onChanged={onChanged}
      />
      <AdaptersCard machineId={machineId} online={online} capabilities={capabilities} />
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

/**
 * The job-table detail cell: error text, the queued hint, or — for succeeded
 * #6 marketplace deploys — `marketplace · <plugin> v<version>` from the result
 * payload (read defensively; adapter results have no `method`).
 */
function jobDetailText(job: JobView, t: ReturnType<typeof useI18n>['t']): string {
  if (job.error) return job.error;
  if (job.status === 'queued') return t('machineDetail.waitingDaemon');
  if (job.status === 'succeeded' && job.result && typeof job.result === 'object') {
    const r = job.result as { method?: unknown; name?: unknown; installedVersion?: unknown };
    if (r.method === 'marketplace') {
      const name = typeof r.name === 'string' ? r.name : '';
      const ver = typeof r.installedVersion === 'string' ? ` v${r.installedVersion}` : '';
      return `${t('machineDetail.viaMarketplace')} · ${name}${ver}`;
    }
  }
  return '—';
}

function JobStatusBadge({ status }: { status: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <StateSignal state={JOB_STATUS_SIGNAL[status] ?? 'inactive'} />
      <span className="font-mono text-xs tabular-nums">{status}</span>
    </span>
  );
}

/**
 * Deploy jobs + deployed agent instances (Phase 8 C4). A deploy queues when
 * the daemon is offline and replays on reconnect — the hint says so instead
 * of hiding the queue.
 */
function DeploymentsCard({
  machineId,
  online,
  jobs,
  agents,
  onChanged,
}: {
  machineId: string;
  online: boolean;
  jobs: JobView[] | null;
  agents: AgentInstanceView[];
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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <RocketIcon className="size-4" />
          {t('machineDetail.deployTitle')}
        </CardTitle>
        <CardDescription>{t('machineDetail.deployDesc')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid min-w-64 gap-2">
            <Label htmlFor="deploy-profile">{t('machineDetail.profileLabel')}</Label>
            <Select value={profileId} onValueChange={setProfileId}>
              <SelectTrigger id="deploy-profile" className="font-mono text-xs">
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
          <Button onClick={() => void deploy()} disabled={busy || profileId === ''}>
            <RocketIcon className="size-4" />
            {busy
              ? t('machineDetail.creating')
              : online
                ? t('machineDetail.deploy')
                : t('machineDetail.queueDeploy')}
          </Button>
          <p className="text-muted-foreground pb-2 text-sm">
            {profiles !== null && profiles.length === 0 ? t('machineDetail.noDeployable') : null}
          </p>
        </div>

        <div className="overflow-hidden rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">{t('machineDetail.job')}</TableHead>
                <TableHead>{t('common.status')}</TableHead>
                <TableHead>{t('machineDetail.detail')}</TableHead>
                <TableHead className="pr-4 text-right">{t('common.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs === null ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground py-6 text-center">
                    {t('machineDetail.loadingJobs')}
                  </TableCell>
                </TableRow>
              ) : jobs.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-muted-foreground py-6 text-center">
                    {t('machineDetail.noJobs')}
                  </TableCell>
                </TableRow>
              ) : (
                jobs.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell className="pl-4">
                      <span className="flex items-center gap-2">
                        <Badge variant="outline" className="font-mono text-[10px]">
                          {job.type}
                        </Badge>
                        <span className="text-muted-foreground font-mono text-xs">
                          {new Date(job.createdAt).toLocaleString(dateLocale(lang))}
                        </span>
                      </span>
                    </TableCell>
                    <TableCell>
                      <JobStatusBadge status={job.status} />
                    </TableCell>
                    <TableCell className="max-w-[24rem] truncate text-muted-foreground text-xs">
                      {jobDetailText(job, t)}
                    </TableCell>
                    <TableCell className="pr-4 text-right">
                      {job.status === 'queued' ? (
                        <Button variant="ghost" size="sm" onClick={() => void cancel(job)}>
                          <SquareIcon className="size-4" />
                          {t('common.cancel')}
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <div>
          <p className="mb-2 text-sm font-medium">
            {t('machineDetail.agentsHeading', { count: agents.length })}
          </p>
          {agents.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('machineDetail.noAgents')}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {agents.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{a.name}</span>
                  <Badge variant="outline" className="font-mono text-[10px]">
                    {a.target}
                  </Badge>
                  {a.source === 'detected' ? (
                    <Badge variant="secondary" className="text-[10px]">
                      {t('machineDetail.detectedSource')}
                    </Badge>
                  ) : null}
                  <span className="text-muted-foreground font-mono text-xs">{a.directory}</span>
                  {a.profileVersion ? (
                    <span className="text-muted-foreground font-mono text-xs tabular-nums">
                      v{a.profileVersion}
                    </span>
                  ) : null}
                  <Button asChild variant="ghost" size="sm" className="ml-auto">
                    <Link to={`/chat/agents/${a.id}`}>
                      <MessageSquareIcon className="size-4" />
                      {t('machineDetail.chat')}
                    </Link>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
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
function AdaptersCard({
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

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <CpuIcon className="size-4" />
            {t('machineDetail.adaptersTitle')}
          </CardTitle>
          <CardDescription>{t('machineDetail.adaptersDesc')}</CardDescription>
        </div>
        {available ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void load()}
            disabled={loading}
            className="shrink-0"
          >
            <RefreshCwIcon className={loading ? 'size-4 animate-spin' : 'size-4'} />
            {t('machineDetail.adaptersRefresh')}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent>
        {!available ? (
          <p className="text-muted-foreground py-6 text-center text-sm">
            {t('machineDetail.adaptersOffline')}
          </p>
        ) : (
          <div className="overflow-hidden rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">{t('machineDetail.adapterTarget')}</TableHead>
                  <TableHead>{t('machineDetail.adapterNative')}</TableHead>
                  <TableHead>{t('machineDetail.adapterUptime')}</TableHead>
                  <TableHead>PGID</TableHead>
                  <TableHead className="pr-4 text-right">{t('common.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows === null || loading ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-muted-foreground py-6 text-center">
                      {t('machineDetail.adaptersLoading')}
                    </TableCell>
                  </TableRow>
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-muted-foreground py-6 text-center">
                      {t('machineDetail.adaptersEmpty')}
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((a) => (
                    <TableRow key={a.wireSessionId}>
                      <TableCell className="pl-4">
                        <Badge variant="outline" className="font-mono text-[10px]">
                          {a.target}
                        </Badge>
                      </TableCell>
                      <TableCell
                        className="max-w-56 truncate font-mono text-xs"
                        title={a.nativeSessionId ?? ''}
                      >
                        {a.nativeSessionId ?? '—'}
                      </TableCell>
                      <TableCell className="nums text-sm">
                        {adapterUptime(a.startedAt, lang)}
                      </TableCell>
                      <TableCell className="nums font-mono text-xs">{a.pgid}</TableCell>
                      <TableCell className="pr-4 text-right">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={killing !== null}
                          onClick={() => void kill(a.wireSessionId)}
                        >
                          {killing === a.wireSessionId
                            ? t('common.saving')
                            : t('machineDetail.adapterKill')}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
