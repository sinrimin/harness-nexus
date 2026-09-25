import { useEffect, useMemo, useState } from 'react';
import { api } from '@/api';
import {
  ConfirmDialog,
  DataTable,
  FilterBar,
  FilterSelect,
  PageIntro,
  Readout,
  SortSelect,
  TableSearch,
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
import { PageAction } from '@/components/shell/page-action';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n, dateLocale } from '@/i18n';
import { toast } from 'sonner';
import { HarnessNexusError, type PublicUser, type Role } from '@harness-nexus/sdk';
import { FormDialog } from '@/components/ui/form-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { MoreHorizontalIcon, ShieldCheckIcon, UserIcon, TrashIcon } from 'lucide-react';

/** The list's vocabulary (07-p3-list-pages.md §5). */
const USER_SPEC: ListQuerySpec = {
  filters: { role: ['admin', 'user'], status: ['active', 'disabled'] },
  sort: ['username', '-created'],
};

export function UsersPage() {
  const { logout, user: viewer } = useAuth();
  const { t, lang } = useI18n();
  // null = still loading. The old `[]` made a brand-new page render the empty
  // state while the fetch was in flight — an empty list that was not empty.
  const [users, setUsers] = useState<PublicUser[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<PublicUser | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      setUsers(await withAuthGuard(() => api.listUsers(), logout));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }
  useEffect(() => {
    void refresh();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const query = useListQuery(USER_SPEC);
  const visible = useMemo(() => {
    if (users === null) return null;
    const rows = users.filter(
      (u) =>
        matchesQuery(query.q, [u.username, u.role, u.status]) &&
        (query.filters['role'] === null || u.role === query.filters['role']) &&
        (query.filters['status'] === null || u.status === query.filters['status']),
    );
    return sortRows(rows, effectiveSort(USER_SPEC, query), (u, key) =>
      key === 'created' ? u.createdAt : u.username,
    );
  }, [users, query.q, query.filters, query.sort]);

  const roleLabels = useMemo(
    () => ({ admin: t('common.roleAdmin'), user: t('common.roleUser') }),
    [t],
  );
  const statusLabels = useMemo(
    () => ({ active: t('users.statusActive'), disabled: t('users.statusDisabled') }),
    [t],
  );
  const sortLabels = useMemo(
    () => ({ username: t('users.sortUsername'), '-created': t('users.sortCreated') }),
    [t],
  );

  async function setRole(u: PublicUser, role: Role) {
    try {
      await withAuthGuard(() => api.updateUserRole(u.id, role), logout);
      toast.success(
        t('users.nowRole', {
          username: u.username,
          role: role === 'admin' ? t('common.roleAdmin') : t('common.roleUser'),
        }),
      );
      await refresh();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.updateFailed'));
    }
  }

  async function confirmRemove() {
    const u = pending;
    if (u === null) return;
    setBusy(true);
    try {
      await withAuthGuard(() => api.deleteUser(u.id), logout);
      toast.success(t('users.deleted', { username: u.username }));
      setPending(null);
      await refresh();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.deleteFailed'));
    } finally {
      setBusy(false);
    }
  }

  const total = users?.length ?? 0;

  return (
    <>
      <PageSlot slot="actions">
        <PageAction label={t('users.addUser')} onClick={() => setCreating(true)} />
      </PageSlot>

      <PageIntro sub={t('users.subtitle')} />

      <DataTable
        columns={5}
        label={t('users.title')}
        icon={<UserIcon />}
        meta={
          <Readout
            layout="inline"
            size="sm"
            value={total}
            label={t('users.countLabel')}
            loading={users === null}
          />
        }
        state={tableState({
          error,
          loading: users === null,
          count: visible?.length ?? 0,
          filtered: query.active,
        })}
        error={error}
        onRetry={() => void refresh()}
        onClearFilters={query.clear}
        toolbar={
          <FilterBar query={query} shown={visible?.length} total={total}>
            <TableSearch query={query} placeholder={t('users.searchPlaceholder')} />
            <FilterSelect
              query={query}
              spec={USER_SPEC}
              name="role"
              allLabel={t('users.allRoles')}
              labels={roleLabels}
            />
            <FilterSelect
              query={query}
              spec={USER_SPEC}
              name="status"
              allLabel={t('users.allStatuses')}
              labels={statusLabels}
            />
            <SortSelect
              query={query}
              spec={USER_SPEC}
              label={t('common.sortLabel')}
              labels={sortLabels}
            />
          </FilterBar>
        }
        empty={{
          title: t('users.noUsers'),
          hint: t('users.emptyHint'),
        }}
      >
        <TableHeader>
          <TableRow>
            <TableHead>{t('users.username')}</TableHead>
            <TableHead>{t('users.role')}</TableHead>
            <TableHead>{t('common.status')}</TableHead>
            <TableHead>{t('users.created')}</TableHead>
            <TableHead className="text-right">{t('common.actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible?.map((u) => (
            <TableRow key={u.id}>
              <TableCell className="font-medium">{u.username}</TableCell>
              <TableCell>
                <Badge variant={u.role === 'admin' ? 'default' : 'secondary'} className="gap-1">
                  {u.role === 'admin' ? <ShieldCheckIcon /> : <UserIcon />}
                  {u.role === 'admin' ? t('common.roleAdmin') : t('common.roleUser')}
                </Badge>
              </TableCell>
              <TableCell>
                <span className="text-muted-foreground">
                  {u.status === 'active' ? t('users.statusActive') : t('users.statusDisabled')}
                </span>
              </TableCell>
              <TableCell className="text-muted-foreground tabular-nums">
                {new Date(u.createdAt).toLocaleDateString(dateLocale(lang), {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })}
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
                    <DropdownMenuLabel>{t('users.role')}</DropdownMenuLabel>
                    <DropdownMenuItem
                      disabled={u.role === 'admin'}
                      onClick={() => setRole(u, 'admin')}
                    >
                      <ShieldCheckIcon /> {t('users.makeAdmin')}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={u.role === 'user'}
                      onClick={() => setRole(u, 'user')}
                    >
                      <UserIcon /> {t('users.makeUser')}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={u.id === viewer?.id}
                      onClick={() => setPending(u)}
                    >
                      <TrashIcon /> {t('common.delete')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </DataTable>

      {creating ? (
        <CreateUser
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void refresh();
          }}
        />
      ) : null}

      {pending !== null ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) setPending(null);
          }}
          title={t('users.deleteAction')}
          consequence={t('users.deleteConsequence')}
          impact={[
            { label: 'user', value: pending.username },
            { label: 'role', value: pending.role },
          ]}
          actionLabel={t('users.deleteAction')}
          busy={busy}
          onConfirm={() => void confirmRemove()}
        />
      ) : null}
    </>
  );
}

function CreateUser({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { logout } = useAuth();
  const { t } = useI18n();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('user');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      await withAuthGuard(() => api.createUser({ username, password, role }), logout);
      toast.success(t('users.createdOk', { username }));
      onCreated();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.createFailed'));
    }
  }

  return (
    <>
      <FormDialog
        open
        onClose={onClose}
        title={t('users.addUser')}
        description={t('users.addUserDesc')}
      >
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="new-username">{t('users.username')}</Label>
              <Input
                id="new-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="new-password">{t('users.password')}</Label>
              <Input
                id="new-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="new-role">{t('users.role')}</Label>
            <Select value={role} onValueChange={(v) => setRole(v as Role)}>
              <SelectTrigger id="new-role" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">{t('common.roleUser')}</SelectItem>
                <SelectItem value="admin">{t('common.roleAdmin')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit">{t('common.create')}</Button>
          </div>
        </form>
      </FormDialog>
    </>
  );
}
