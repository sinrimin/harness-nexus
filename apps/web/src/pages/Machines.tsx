import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import {
  CheckIcon,
  CopyIcon,
  LaptopIcon,
  MoreHorizontalIcon,
  PlusIcon,
  TrashIcon,
} from 'lucide-react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n, dateLocale } from '@/i18n';
import { AppShell } from '@/components/app-shell';
import { appSocket, type MachineStatusEvent } from '@/realtime';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
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
import { Alert, AlertDescription } from '@/components/ui/alert';
import { StateSignal } from '@/components/state-signal';
import { HarnessNexusError, type MachineView } from '@harness-nexus/sdk';

/**
 * Machines (Phase 8 C1). Enrollment creates the machine + its machine token
 * (shown once, with a ready-to-paste `hnx daemon` command). Online status is
 * live socket presence pushed over the /app channel — honest by construction:
 * the row shows offline the moment the daemon disconnects.
 */
export function MachinesPage() {
  const { logout } = useAuth();
  const { t } = useI18n();
  const [items, setItems] = useState<MachineView[] | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [reveal, setReveal] = useState<{ machine: MachineView; token: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setItems(await withAuthGuard(() => api.listMachines(), logout));
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('machines.loadFailed'));
    }
  }, [logout, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live presence: patch rows in place on machine:status pushes.
  useEffect(() => {
    const socket = appSocket();
    const onStatus = (e: MachineStatusEvent): void => {
      setItems(
        (prev) =>
          prev?.map((m) =>
            m.id === e.machineId
              ? {
                  ...m,
                  online: e.online,
                  lastSeenAt: e.lastSeenAt,
                  ...(e.daemonVersion !== undefined ? { daemonVersion: e.daemonVersion } : {}),
                }
              : m,
          ) ?? prev,
      );
    };
    socket.on('machine:status', onStatus);
    return () => {
      socket.off('machine:status', onStatus);
    };
  }, []);

  return (
    <AppShell>
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('machines.title')}</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {t('machines.subtitleA')} <code className="font-mono">hnx daemon</code>{' '}
            {t('machines.subtitleB')}
          </p>
        </div>
        <Button onClick={() => setEnrolling(true)}>
          <PlusIcon className="size-4" />
          {t('machines.enrollButton')}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <LaptopIcon className="size-4" />
            {t('machines.enrolledTitle')}
          </CardTitle>
          <CardDescription>{t('machines.enrolledDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">{t('common.name')}</TableHead>
                <TableHead>{t('machines.host')}</TableHead>
                <TableHead>{t('machines.daemon')}</TableHead>
                <TableHead>{t('common.status')}</TableHead>
                <TableHead>{t('machines.remoteChat')}</TableHead>
                <TableHead>{t('machines.lastSeen')}</TableHead>
                <TableHead className="pr-6 text-right">{t('common.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items === null ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-muted-foreground py-8 text-center">
                    {t('common.loading')}
                  </TableCell>
                </TableRow>
              ) : items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-muted-foreground py-8 text-center">
                    {t('machines.empty')}
                  </TableCell>
                </TableRow>
              ) : (
                items.map((m) => <MachineRow key={m.id} machine={m} onRevoke={refresh} />)
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {enrolling ? (
        <EnrollCard
          onClose={() => setEnrolling(false)}
          onEnrolled={() => {
            setEnrolling(false);
            void refresh();
          }}
          onReveal={setReveal}
        />
      ) : null}
      <RevealDialog reveal={reveal} onClose={() => setReveal(null)} />
    </AppShell>
  );
}

function OnlineDot({ online }: { online: boolean }) {
  const { t } = useI18n();
  return (
    <span className="inline-flex items-center gap-2">
      <StateSignal state={online ? 'online' : 'inactive'} />
      <span className="tabular-nums">{online ? t('machines.online') : t('machines.offline')}</span>
    </span>
  );
}

function MachineRow({ machine, onRevoke }: { machine: MachineView; onRevoke: () => void }) {
  const { logout } = useAuth();
  const { t, lang } = useI18n();
  const [remoteChat, setRemoteChat] = useState(machine.remoteChatEnabled);

  useEffect(() => {
    setRemoteChat(machine.remoteChatEnabled);
  }, [machine.remoteChatEnabled]);

  async function toggleRemoteChat(next: boolean): Promise<void> {
    const consent = next
      ? confirm(t('machines.confirmEnable', { name: machine.name }))
      : confirm(t('machines.confirmDisable', { name: machine.name }));
    if (!consent) return;
    setRemoteChat(next);
    try {
      await withAuthGuard(() => api.updateMachine(machine.id, { remoteChatEnabled: next }), logout);
      toast.success(next ? t('machines.chatEnabled') : t('machines.chatDisabled'));
    } catch (e) {
      setRemoteChat(!next);
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.updateFailed'));
    }
  }

  async function revoke(): Promise<void> {
    if (!confirm(t('machines.confirmRemove', { name: machine.name }))) return;
    try {
      await withAuthGuard(() => api.deleteMachine(machine.id), logout);
      toast.success(t('machines.removed'));
      onRevoke();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('machines.removeFailed'));
    }
  }

  const host = [machine.hostname, machine.os, machine.arch].filter(Boolean).join(' · ');

  return (
    <TableRow>
      <TableCell className="pl-6 font-medium">
        <Link to={`/machines/${machine.id}`} className="hover:underline">
          {machine.name}
        </Link>
      </TableCell>
      <TableCell className="text-muted-foreground font-mono text-xs">{host || '—'}</TableCell>
      <TableCell>
        {machine.daemonVersion ? (
          <span className="flex flex-wrap items-center gap-1">
            <span className="font-mono text-xs tabular-nums">{machine.daemonVersion}</span>
            {machine.capabilities.map((c) => (
              <Badge key={c} variant="secondary" className="font-mono text-[10px]">
                {c}
              </Badge>
            ))}
          </span>
        ) : (
          <span className="text-muted-foreground">{t('machines.neverConnected')}</span>
        )}
      </TableCell>
      <TableCell>
        <OnlineDot online={machine.online} />
      </TableCell>
      <TableCell>
        <Switch
          checked={remoteChat}
          onCheckedChange={(v) => void toggleRemoteChat(v)}
          aria-label={t('machines.toggleChatAria', { name: machine.name })}
        />
      </TableCell>
      <TableCell className="text-muted-foreground tabular-nums">
        {machine.lastSeenAt ? new Date(machine.lastSeenAt).toLocaleString(dateLocale(lang)) : '—'}
      </TableCell>
      <TableCell className="pr-6 text-right">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="size-8">
              <MoreHorizontalIcon className="size-4" />
              <span className="sr-only">{t('common.openMenu')}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem variant="destructive" onClick={() => void revoke()}>
              <TrashIcon /> {t('common.remove')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}

function EnrollCard({
  onClose,
  onEnrolled,
  onReveal,
}: {
  onClose: () => void;
  onEnrolled: () => void;
  onReveal: (r: { machine: MachineView; token: string }) => void;
}) {
  const { logout } = useAuth();
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await withAuthGuard(() => api.createMachine({ name }), logout);
      toast.success(t('machines.enrolledToast'));
      onReveal(res);
      onEnrolled();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('machines.enrollFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('machines.enrollTitle')}
      description={
        <>
          {t('machines.enrollDescA')}{' '}
          <code className="font-mono">
            hnx enroll --server &lt;url&gt; --token &lt;your-pat&gt;
          </code>
          {t('machines.enrollDescB')}
        </>
      }
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="grid gap-2">
          <Label htmlFor="machine-name">{t('common.name')}</Label>
          <Input
            id="machine-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('machines.namePlaceholder')}
            autoComplete="off"
            spellCheck={false}
            required
          />
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? t('machines.enrolling') : t('machines.enrollButton')}
          </Button>
        </div>
      </form>
    </FormDialog>
  );
}

/** One-shot reveal: the machine token + the ready-to-paste daemon command. */
function RevealDialog({
  reveal,
  onClose,
}: {
  reveal: { machine: MachineView; token: string } | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState<'token' | 'command' | null>(null);

  useEffect(() => {
    setCopied(null);
  }, [reveal]);

  if (reveal === null) return null;
  const command = `hnx daemon --server ${window.location.origin} --token ${reveal.token} --machine-id ${reveal.machine.id}`;

  function copy(kind: 'token' | 'command', text: string): void {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(kind);
      toast.success(kind === 'token' ? t('machines.tokenCopied') : t('machines.commandCopied'));
    });
  }

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent showCloseButton={false} className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('machines.revealTitle')}</DialogTitle>
          <DialogDescription>
            {t('machines.revealDescA')} <strong>{reveal.machine.name}</strong>{' '}
            {t('machines.revealDescB')}
          </DialogDescription>
        </DialogHeader>

        <Alert variant="destructive">
          <AlertDescription>{t('machines.revealWarning')}</AlertDescription>
        </Alert>

        <div className="bg-muted flex items-center gap-2 rounded-md border p-3">
          <code className="text-foreground min-w-0 flex-1 break-all font-mono text-xs">
            {command}
          </code>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="shrink-0"
            onClick={() => copy('command', command)}
          >
            {copied === 'command' ? (
              <CheckIcon className="size-4" />
            ) : (
              <CopyIcon className="size-4" />
            )}
            {copied === 'command' ? t('common.copied') : t('common.copy')}
          </Button>
        </div>

        <div className="bg-muted flex items-center gap-2 rounded-md border p-3">
          <code className="text-foreground min-w-0 flex-1 break-all font-mono text-sm">
            {reveal.token}
          </code>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="shrink-0"
            onClick={() => copy('token', reveal.token)}
          >
            {copied === 'token' ? (
              <CheckIcon className="size-4" />
            ) : (
              <CopyIcon className="size-4" />
            )}
            {copied === 'token' ? t('common.copied') : t('common.copy')}
          </Button>
        </div>

        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t('common.done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
