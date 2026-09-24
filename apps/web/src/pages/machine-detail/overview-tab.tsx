import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n, dateLocale } from '@/i18n';
import { HarnessNexusError, type MachineView } from '@harness-nexus/sdk';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';

/**
 * 概览 tab — machine identity + the two machine-level settings that used to
 * cram the page header toolbar (base workspace, remote chat). Identity data
 * only; liveness color stays on the always-visible page header.
 */
export function OverviewTab({
  machine,
  onChanged,
}: {
  machine: MachineView | null;
  onChanged: () => void;
}) {
  const { t, lang } = useI18n();
  if (machine === null) {
    return (
      <>
        <p className="text-muted-foreground py-8 text-center text-sm">
          {t('machineDetail.loading')}
        </p>
      </>
    );
  }
  const rows: { label: string; value: string; mono?: boolean }[] = [
    { label: t('machineDetail.metaHostname'), value: machine.hostname || '—', mono: true },
    {
      label: t('machineDetail.metaPlatform'),
      value: [machine.os, machine.arch].filter(Boolean).join(' · ') || '—',
      mono: true,
    },
    { label: t('machineDetail.metaDaemon'), value: machine.daemonVersion ?? '—', mono: true },
    {
      label: t('machineDetail.metaLastSeen'),
      value:
        machine.lastSeenAt === null
          ? '—'
          : new Date(machine.lastSeenAt).toLocaleString(dateLocale(lang)),
    },
  ];
  return (
    <>
      <div className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('machineDetail.metaTitle')}</CardTitle>
            <CardDescription>{t('machineDetail.metaDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-x-8 gap-y-3 sm:grid-cols-2">
            {rows.map((r) => (
              <div
                key={r.label}
                className="flex items-baseline justify-between gap-4 border-b pb-2 last:border-b-0 sm:border-b-0 sm:border-t sm:pt-2.5 first:sm:border-t-0 first:sm:pt-0"
              >
                <span className="text-muted-foreground shrink-0 text-xs">{r.label}</span>
                <span
                  className={`text-right text-sm ${r.mono === true ? 'font-mono text-xs' : ''}`}
                >
                  {r.value}
                </span>
              </div>
            ))}
            <div className="flex items-baseline justify-between gap-4 sm:col-span-2">
              <span className="text-muted-foreground shrink-0 text-xs">
                {t('machineDetail.metaCapabilities')}
              </span>
              <span className="flex flex-wrap justify-end gap-1.5">
                {machine.capabilities.length === 0 ? (
                  <span className="text-muted-foreground text-sm">—</span>
                ) : (
                  machine.capabilities.map((c) => (
                    <Badge key={c} variant="outline" className="font-mono text-[10px]">
                      {c}
                    </Badge>
                  ))
                )}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('machineDetail.settingsTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <BaseWorkspaceField machine={machine} onChanged={onChanged} />
            <div className="border-t pt-4">
              <RemoteChatToggle machine={machine} onChanged={onChanged} />
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

/** Base workspace field (Phase 9 W6) — inline edit + save; empty clears it. */
function BaseWorkspaceField({
  machine,
  onChanged,
}: {
  machine: MachineView;
  onChanged: () => void;
}) {
  const { logout } = useAuth();
  const { t } = useI18n();
  const [value, setValue] = useState(machine.baseWorkspace ?? '');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setValue(machine.baseWorkspace ?? '');
  }, [machine.baseWorkspace]);

  async function save(): Promise<void> {
    const next = value.trim();
    if (busy) return;
    setBusy(true);
    try {
      await withAuthGuard(
        () =>
          api.updateMachine(machine.id, {
            baseWorkspace: next === '' ? null : next,
          }),
        logout,
      );
      toast.success(t('machineDetail.baseWorkspaceSaved'));
      onChanged();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.updateFailed'));
    } finally {
      setBusy(false);
    }
  }

  const dirty = value.trim() !== (machine.baseWorkspace ?? '');
  return (
    <>
      <label className="text-muted-foreground flex flex-wrap items-center gap-2 text-sm">
        <span className="w-40 shrink-0">{t('machineDetail.baseWorkspace')}</span>
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="/home/user/projects"
          autoComplete="off"
          spellCheck={false}
          className="h-8 w-64 font-mono text-xs"
          aria-label={t('machineDetail.baseWorkspace')}
        />
        <Button variant="outline" size="sm" disabled={!dirty || busy} onClick={() => void save()}>
          {busy ? t('common.saving') : t('common.save')}
        </Button>
      </label>
    </>
  );
}

/** Remote chat toggle — a remote-code-execution switch; confirm-first. */
function RemoteChatToggle({ machine, onChanged }: { machine: MachineView; onChanged: () => void }) {
  const { logout } = useAuth();
  const { t } = useI18n();
  async function toggle(next: boolean): Promise<void> {
    if (next && !window.confirm(t('machineDetail.chatConfirm'))) {
      return;
    }
    try {
      await withAuthGuard(() => api.updateMachine(machine.id, { remoteChatEnabled: next }), logout);
      toast.success(next ? t('machineDetail.chatEnabled') : t('machineDetail.chatDisabled'));
      onChanged();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.updateFailed'));
    }
  }
  return (
    <>
      <label className="text-muted-foreground flex items-center gap-2 text-sm">
        <Switch checked={machine.remoteChatEnabled} onCheckedChange={(v) => void toggle(v)} />
        {t('machineDetail.chatLabel')}
      </label>
    </>
  );
}
