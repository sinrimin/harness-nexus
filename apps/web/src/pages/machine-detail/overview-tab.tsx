import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n, dateLocale } from '@/i18n';
import { HarnessNexusError, type MachineView } from '@harness-nexus/sdk';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import {
  ConfirmDialog,
  Field,
  LabelText,
  Panel,
  PanelBody,
  Skeleton,
  Well,
} from '@/components/kit';

/**
 * 概览 tab — machine identity + the two machine-level settings (P5).
 *
 * Identity is a definition list (02-content.md §3.6): `dt` in the prose role at
 * a fixed 138px/104px, `dd` always a `Well` — host, platform, version and
 * timestamps are protocol material, so bare right-aligned text lost the one
 * thing a reader does with them (copy the exact string). Capabilities are names
 * of things, which the device table maps to `Well chip`, not to a `Badge`.
 *
 * Settings say what they COST: remote chat is remote code execution and the
 * description says so.
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
      <div className="grid gap-(--gap) lg:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]">
        <Panel label={t('machineDetail.metaTitle')} density="compact">
          <PanelBody className="grid gap-2.5">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/3" />
          </PanelBody>
        </Panel>
      </div>
    );
  }
  const rows: { label: string; value: string | null; copy?: boolean }[] = [
    { label: t('machineDetail.metaHostname'), value: machine.hostname || null, copy: true },
    {
      label: t('machineDetail.metaPlatform'),
      value: [machine.os, machine.arch].filter(Boolean).join(' · ') || null,
    },
    { label: t('machineDetail.metaDaemon'), value: machine.daemonVersion ?? null, copy: true },
    {
      label: t('machineDetail.metaLastSeen'),
      value:
        machine.lastSeenAt === null
          ? null
          : new Date(machine.lastSeenAt).toLocaleString(dateLocale(lang)),
    },
  ];
  return (
    <div className="grid items-start gap-(--gap) lg:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]">
      <Panel label={t('machineDetail.metaTitle')} density="compact">
        <PanelBody>
          <dl className="grid gap-2.5">
            {rows.map((r) => (
              <MetaRow key={r.label} label={r.label} copy={r.copy}>
                {r.value}
              </MetaRow>
            ))}
            <MetaRow label={t('machineDetail.metaCapabilities')}>
              {machine.capabilities.length === 0 ? null : (
                <span className="flex flex-wrap gap-1.5">
                  {machine.capabilities.map((c) => (
                    <Well key={c} variant="chip">
                      {c}
                    </Well>
                  ))}
                </span>
              )}
            </MetaRow>
          </dl>
        </PanelBody>
      </Panel>

      <Panel label={t('machineDetail.settingsTitle')} density="compact">
        <PanelBody className="flex flex-col gap-5">
          <BaseWorkspaceField machine={machine} onChanged={onChanged} />
          <RemoteChatToggle machine={machine} onChanged={onChanged} />
        </PanelBody>
      </Panel>
    </div>
  );
}

/**
 * One `dt`/`dd` pair: label column fixed (104px on a phone, 138px from `sm`),
 * value always a Well. `copy` is for the two values a reader pastes elsewhere
 * (hostname, daemon version).
 */
function MetaRow({
  label,
  copy,
  children,
}: {
  label: string;
  copy?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[104px_minmax(0,1fr)] items-baseline gap-2 sm:grid-cols-[138px_minmax(0,1fr)]">
      <dt>
        <LabelText>{label}</LabelText>
      </dt>
      <dd className="min-w-0">
        {children === null || children === undefined ? (
          <span className="text-muted-foreground">—</span>
        ) : typeof children === 'string' ? (
          // Every read-only value is a Well (01-skeleton.md §7.3); `copy` is the
          // extra affordance for the two strings a reader pastes elsewhere.
          <Well copy={copy === true ? children : undefined}>{children}</Well>
        ) : (
          children
        )}
      </dd>
    </div>
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
    <Field
      label={t('machineDetail.baseWorkspace')}
      htmlFor="machine-base-workspace"
      hint={t('machineDetail.baseWorkspaceHint')}
      aside={
        <Button variant="outline" size="sm" disabled={!dirty || busy} onClick={() => void save()}>
          {busy ? t('common.saving') : t('common.save')}
        </Button>
      }
    >
      <Input
        id="machine-base-workspace"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="/home/user/projects"
        autoComplete="off"
        spellCheck={false}
        className="h-(--control-h-sm) font-mono text-xs"
      />
    </Field>
  );
}

/** Remote chat toggle — a remote-code-execution switch; confirm-first.
 *  Same action as the Machines list's switch, so it borrows that page's words
 *  (and its tier): the flip is one click back, so no "cannot be undone". */
function RemoteChatToggle({ machine, onChanged }: { machine: MachineView; onChanged: () => void }) {
  const { logout } = useAuth();
  const { t } = useI18n();
  const [pending, setPending] = useState<boolean | null>(null);
  async function toggle(next: boolean): Promise<void> {
    try {
      await withAuthGuard(() => api.updateMachine(machine.id, { remoteChatEnabled: next }), logout);
      toast.success(next ? t('machineDetail.chatEnabled') : t('machineDetail.chatDisabled'));
      onChanged();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.updateFailed'));
    }
  }
  function confirmPending(): void {
    const next = pending;
    if (next === null) return;
    setPending(null);
    void toggle(next);
  }
  return (
    <>
      <Field
        label={t('machineDetail.chatLabel')}
        aside={
          <Switch
            checked={machine.remoteChatEnabled}
            onCheckedChange={(v) => setPending(v)}
            aria-label={t('machineDetail.chatLabel')}
          />
        }
      >
        <p className="text-muted-foreground text-xs">{t('machineDetail.chatHint')}</p>
      </Field>

      {pending !== null ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) setPending(null);
          }}
          title={pending ? t('machines.chatEnableAction') : t('machines.chatDisableAction')}
          consequence={
            pending ? t('machines.chatEnableConsequence') : t('machines.chatDisableConsequence')
          }
          impact={[{ label: 'machine', value: machine.name }]}
          actionLabel={pending ? t('machines.chatEnableAction') : t('machines.chatDisableAction')}
          tone="default"
          irreversible={false}
          onConfirm={confirmPending}
        />
      ) : null}
    </>
  );
}
