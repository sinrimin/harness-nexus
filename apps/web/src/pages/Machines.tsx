import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { LaptopIcon, MoreHorizontalIcon, PlusIcon, TrashIcon } from 'lucide-react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n, dateLocale } from '@/i18n';
import { patchMachineList } from '@/lib/machine-presence.js';
import { useMachineStatus } from '@/components/shell/use-presence.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
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
  Chip,
  CommandLine,
  ConfirmDialog,
  DataTable,
  DataText,
  Field,
  FilterBar,
  FilterSelect,
  LabelText,
  Lamp,
  Note,
  PageIntro,
  Readout,
  SortSelect,
  TableSearch,
  Well,
  tableState,
} from '@/components/kit';
import {
  effectiveSort,
  matchesQuery,
  sortRows,
  useListQuery,
  type ListQuerySpec,
} from '@/lib/list-query';
import { PageSlot } from '@/components/shell/page-slots';
import { HarnessNexusError, type MachineView } from '@harness-nexus/sdk';

/**
 * The list's vocabulary (07-p3-list-pages.md §5). `-status` rather than
 * `status`: when you sort a fleet by status you want the ones that are *up*
 * first (the comparator puts `true` after `false` ascending).
 */
const MACHINE_SPEC: ListQuerySpec = {
  filters: { status: ['online', 'offline'] },
  sort: ['-lastSeen', 'name', '-status'],
};

/**
 * Machines (Phase 8 C1). Enrollment creates the machine + its machine token
 * (shown once, with a ready-to-paste `hnx daemon` command). Online status is
 * live socket presence pushed over the /app channel — honest by construction:
 * the row shows offline the moment the daemon disconnects.
 *
 * The list is the reference for the kit's list archetype: the shell states the
 * facts (how many are online, of how many), every protocol value sits in a
 * Well, status is a lamp plus its word, and the two destructive actions ask
 * through a dialog that names what it is about to do.
 */
export function MachinesPage() {
  const { logout } = useAuth();
  const { t } = useI18n();
  const [items, setItems] = useState<MachineView[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [reveal, setReveal] = useState<{ machine: MachineView; token: string } | null>(null);
  const [pending, setPending] = useState<{
    action: 'remove' | 'chat';
    machine: MachineView;
    next?: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setItems(await withAuthGuard(() => api.listMachines(), logout));
      setError(null);
    } catch (e) {
      // The list keeps its shape and states the failure in place — a toast
      // alone would leave the page blank with no way to ask again.
      setError(e);
    }
  }, [logout]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live presence: patch rows in place on machine:status pushes.
  useMachineStatus((e) => setItems((prev) => patchMachineList(prev, e)));

  async function confirmPending(): Promise<void> {
    if (pending === null) return;
    const { action, machine, next } = pending;
    setBusy(true);
    try {
      if (action === 'remove') {
        await withAuthGuard(() => api.deleteMachine(machine.id), logout);
        toast.success(t('machines.removed'));
      } else {
        const enabled = next === true;
        await withAuthGuard(
          () => api.updateMachine(machine.id, { remoteChatEnabled: enabled }),
          logout,
        );
        toast.success(enabled ? t('machines.chatEnabled') : t('machines.chatDisabled'));
      }
      setPending(null);
      await refresh();
    } catch (e) {
      toast.error(
        e instanceof HarnessNexusError
          ? e.message
          : action === 'remove'
            ? t('machines.removeFailed')
            : t('common.updateFailed'),
      );
    } finally {
      setBusy(false);
    }
  }

  const onlineCount = items?.filter((m) => m.online).length ?? 0;
  const total = items?.length ?? 0;
  const offlineCount = total - onlineCount;

  const query = useListQuery(MACHINE_SPEC);
  const visible = useMemo(() => {
    if (items === null) return null;
    const rows = items.filter(
      (m) =>
        matchesQuery(query.q, [m.name, m.hostname, m.os, m.arch, m.daemonVersion, m.id]) &&
        (query.filters['status'] === null || (query.filters['status'] === 'online') === m.online),
    );
    return sortRows(rows, effectiveSort(MACHINE_SPEC, query), (m, key) =>
      key === 'name' ? m.name : key === 'status' ? m.online : m.lastSeenAt,
    );
  }, [items, query.q, query.filters, query.sort]);

  const statusLabels = useMemo(
    () => ({ online: t('machines.online'), offline: t('machines.offline') }),
    [t],
  );
  const sortLabels = useMemo(
    () => ({
      '-lastSeen': t('machines.sortLastSeen'),
      name: t('common.sortName'),
      '-status': t('machines.sortStatus'),
    }),
    [t],
  );

  const state = tableState({
    error,
    loading: items === null,
    count: visible?.length ?? 0,
    filtered: query.active,
  });

  return (
    <>
      <PageSlot slot="actions">
        <Button onClick={() => setEnrolling(true)}>
          <PlusIcon className="size-4" />
          {t('machines.enrollButton')}
        </Button>
      </PageSlot>

      <PageIntro
        sub={
          <>
            {t('machines.subtitleA')}{' '}
            <Well variant="chip" copy="hnx daemon">
              hnx daemon
            </Well>{' '}
            {t('machines.subtitleB')}
          </>
        }
      />

      <DataTable
        columns={7}
        label={t('machines.enrolledTitle')}
        icon={<LaptopIcon />}
        meta={
          items === null ? undefined : (
            <Readout
              layout="inline"
              size="sm"
              lamp={
                onlineCount === total && total > 0
                  ? 'online'
                  : offlineCount > 0
                    ? 'warn'
                    : 'offline'
              }
              value={onlineCount}
              total={total}
              label={t('machines.online')}
              {...(offlineCount > 0
                ? { qualifier: t('machines.offlineCount', { count: offlineCount }) }
                : {})}
            />
          )
        }
        state={state}
        error={error}
        onRetry={() => void refresh()}
        onClearFilters={query.clear}
        toolbar={
          <FilterBar query={query} shown={visible?.length} total={items?.length}>
            <TableSearch query={query} placeholder={t('machines.searchPlaceholder')} />
            <FilterSelect
              query={query}
              spec={MACHINE_SPEC}
              name="status"
              allLabel={t('machines.allStatuses')}
              labels={statusLabels}
            />
            <SortSelect
              query={query}
              spec={MACHINE_SPEC}
              label={t('common.sortLabel')}
              labels={sortLabels}
            />
          </FilterBar>
        }
        empty={{
          title: t('machines.empty'),
          hint: t('machines.emptyHint'),
          action: (
            <Button onClick={() => setEnrolling(true)}>
              <PlusIcon className="size-4" />
              {t('machines.enrollButton')}
            </Button>
          ),
        }}
      >
        <TableHeader>
          <TableRow>
            <TableHead>{t('common.name')}</TableHead>
            <TableHead>{t('machines.host')}</TableHead>
            <TableHead>{t('machines.daemon')}</TableHead>
            <TableHead>{t('common.status')}</TableHead>
            <TableHead>{t('machines.remoteChat')}</TableHead>
            <TableHead>{t('machines.lastSeen')}</TableHead>
            <TableHead className="text-right">{t('common.actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible?.map((m) => (
            <MachineRow key={m.id} machine={m} onAsk={setPending} />
          ))}
        </TableBody>
      </DataTable>

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

      {pending !== null ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) setPending(null);
          }}
          title={
            pending.action === 'remove'
              ? t('machines.removeAction')
              : pending.next === true
                ? t('machines.chatEnableAction')
                : t('machines.chatDisableAction')
          }
          consequence={
            pending.action === 'remove'
              ? t('machines.removeConsequence')
              : pending.next === true
                ? t('machines.chatEnableConsequence')
                : t('machines.chatDisableConsequence')
          }
          impact={[
            { label: 'machine', value: pending.machine.id },
            ...(pending.machine.daemonVersion !== null &&
            pending.machine.daemonVersion !== undefined
              ? [{ label: 'daemon', value: pending.machine.daemonVersion }]
              : []),
          ]}
          {...(pending.action === 'remove' ? { confirmPhrase: pending.machine.name } : {})}
          actionLabel={
            pending.action === 'remove'
              ? t('machines.removeAction')
              : pending.next === true
                ? t('machines.chatEnableAction')
                : t('machines.chatDisableAction')
          }
          tone={pending.action === 'remove' ? 'danger' : 'default'}
          // The comp's second hazard button: removing a machine decommissions
          // hardware (its daemon, its tokens), it does not delete a record.
          {...(pending.action === 'remove' ? { hazard: true } : {})}
          busy={busy}
          onConfirm={() => void confirmPending()}
        />
      ) : null}
    </>
  );
}

function MachineRow({
  machine,
  onAsk,
}: {
  machine: MachineView;
  onAsk: (ask: { action: 'remove' | 'chat'; machine: MachineView; next?: boolean }) => void;
}) {
  const { t, lang } = useI18n();
  const host = [machine.hostname, machine.os, machine.arch].filter(Boolean).join(' · ');

  return (
    <>
      <TableRow>
        <TableCell className="font-medium">
          <Link to={`/machines/${machine.id}`} className="hover:underline">
            {machine.name}
          </Link>
        </TableCell>
        <TableCell className="text-muted-foreground">
          {host === '' ? (
            <DataText size="sm" tone="dim">
              —
            </DataText>
          ) : (
            /* Chip scale, not the full Well: a table cell's protocol value is a
             * chip in the comps (`wchip wide` carries a job detail and a whole
             * session id), and the same facts sit in chips in the machine's own
             * nameplate. At Well scale a 26-char host filled the cell with a
             * black window and grew the row on a phone (#23). */
            <Well variant="chip" copy={host}>
              {host}
            </Well>
          )}
        </TableCell>
        <TableCell>
          {machine.daemonVersion ? (
            <span className="flex items-center gap-1">
              <DataText size="sm" className="shrink-0">
                {machine.daemonVersion}
              </DataText>
              {/* A daemon reports a dozen capabilities; the list shows the first
               * few and lets the rest be counted — the full set belongs to the
               * machine's own page, not to a table column. */}
              {machine.capabilities.slice(0, 3).map((c) => (
                <Well key={c} variant="chip">
                  {c}
                </Well>
              ))}
              {machine.capabilities.length > 3 ? (
                <Chip to={`/machines/${machine.id}`} tone="muted">
                  +{machine.capabilities.length - 3}
                </Chip>
              ) : null}
            </span>
          ) : (
            <DataText size="sm" tone="dim">
              {t('machines.neverConnected')}
            </DataText>
          )}
        </TableCell>
        <TableCell>
          <Lamp
            state={machine.online ? 'online' : 'offline'}
            word={machine.online ? t('machines.online') : t('machines.offline')}
          />
        </TableCell>
        <TableCell>
          <Switch
            checked={machine.remoteChatEnabled}
            onCheckedChange={(v) => onAsk({ action: 'chat', machine, next: v })}
            aria-label={t('machines.toggleChatAria', { name: machine.name })}
          />
        </TableCell>
        <TableCell>
          <DataText size="sm" tone="dim">
            {machine.lastSeenAt
              ? new Date(machine.lastSeenAt).toLocaleString(dateLocale(lang))
              : '—'}
          </DataText>
        </TableCell>
        <TableCell className="text-right">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-8">
                <MoreHorizontalIcon className="size-4" />
                <span className="sr-only">{t('common.openMenu')}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                variant="destructive"
                onClick={() => onAsk({ action: 'remove', machine })}
              >
                <TrashIcon /> {t('machines.removeAction')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </TableCell>
      </TableRow>
    </>
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
    <>
      <FormDialog
        open
        onClose={onClose}
        title={t('machines.enrollTitle')}
        description={t('machines.enrollDescA')}
      >
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <CommandLine
            command="hnx enroll --server <url> --token <your-pat>"
            note={t('machines.enrollDescB')}
          />
          <Field label={t('common.name')} htmlFor="machine-name" required>
            <Input
              id="machine-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('machines.namePlaceholder')}
              autoComplete="off"
              spellCheck={false}
              required
            />
          </Field>
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
    </>
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

  if (reveal === null) return null;
  const command = `hnx daemon --server ${window.location.origin} --token ${reveal.token} --machine-id ${reveal.machine.id}`;

  return (
    <>
      <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
        <DialogContent
          showCloseButton={false}
          data-surface="panel"
          className="gap-0 overflow-hidden p-0 sm:max-w-xl"
        >
          <DialogHeader className="h-(--panel-head-h) flex-row items-center border-b px-3">
            <DialogTitle className="role-label text-foreground">
              {t('machines.revealTitle')}
            </DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-3 p-(--panel-pad)">
            <DialogDescription className="text-sm">
              {t('machines.revealDescA')} <strong>{reveal.machine.name}</strong>{' '}
              {t('machines.revealDescB')}
            </DialogDescription>

            <Note tone="warn">{t('machines.revealWarning')}</Note>

            <CommandLine command={command} />

            <div className="flex flex-col gap-1.5">
              <LabelText size="sm">{t('machines.tokenLabel')}</LabelText>
              <Well variant="code" copy={reveal.token}>
                {reveal.token}
              </Well>
            </div>
          </div>

          <DialogFooter className="flex-row justify-end border-t px-3 py-2">
            <Button type="button" onClick={onClose}>
              {t('common.done')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
