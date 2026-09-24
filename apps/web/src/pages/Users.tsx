import { useEffect, useState } from 'react';
import { api } from '@/api';
import { PageIntro } from '@/components/kit';
import { PageSlot } from '@/components/shell/page-slots';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n, dateLocale } from '@/i18n';
import { toast } from 'sonner';
import { HarnessNexusError, type PublicUser, type Role } from '@harness-nexus/sdk';
import { Card, CardContent } from '@/components/ui/card';
import { FormDialog } from '@/components/ui/form-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { MoreHorizontalIcon, PlusIcon, ShieldCheckIcon, UserIcon, TrashIcon } from 'lucide-react';

export function UsersPage() {
  const { logout } = useAuth();
  const { t, lang } = useI18n();
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [creating, setCreating] = useState(false);

  async function refresh() {
    try {
      setUsers(await withAuthGuard(() => api.listUsers(), logout));
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('users.loadFailed'));
    }
  }
  useEffect(() => {
    void refresh();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  async function remove(u: PublicUser) {
    if (!confirm(t('users.confirmDelete', { username: u.username }))) return;
    try {
      await withAuthGuard(() => api.deleteUser(u.id), logout);
      toast.success(t('users.deleted', { username: u.username }));
      await refresh();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.deleteFailed'));
    }
  }

  return (
    <>
      <PageSlot slot="actions">
        <Button onClick={() => setCreating(true)}>
          <PlusIcon className="size-4" />
          {t('users.addUser')}
        </Button>
      </PageSlot>

      <PageIntro
        sub={
          <>
            {t('users.subtitle')}{' '}
            {users.length === 1
              ? t('users.countOne', { count: users.length })
              : t('users.countMany', { count: users.length })}
          </>
        }
      />

      <Card>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">{t('users.username')}</TableHead>
                <TableHead>{t('users.role')}</TableHead>
                <TableHead>{t('common.status')}</TableHead>
                <TableHead>{t('users.created')}</TableHead>
                <TableHead className="pr-6 text-right">{t('common.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.map((u) => (
                <TableRow key={u.id}>
                  <TableCell className="pl-6 font-medium">{u.username}</TableCell>
                  <TableCell>
                    <Badge variant={u.role === 'admin' ? 'default' : 'secondary'} className="gap-1">
                      {u.role === 'admin' ? <ShieldCheckIcon /> : <UserIcon />}
                      {u.role === 'admin' ? t('common.roleAdmin') : t('common.roleUser')}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span className="text-muted-foreground capitalize">{u.status}</span>
                  </TableCell>
                  <TableCell className="text-muted-foreground tabular-nums">
                    {new Date(u.createdAt).toLocaleDateString(dateLocale(lang), {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                    })}
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
                        <DropdownMenuItem variant="destructive" onClick={() => remove(u)}>
                          <TrashIcon /> {t('common.delete')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
              {users.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-muted-foreground py-8 text-center">
                    {t('users.noUsers')}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {creating ? (
        <CreateUser
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void refresh();
          }}
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
