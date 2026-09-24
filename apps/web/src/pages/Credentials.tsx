import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  GlobeIcon,
  KeyRoundIcon,
  MoreHorizontalIcon,
  PlusIcon,
  TrashIcon,
  UserIcon,
} from 'lucide-react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n } from '@/i18n';
import { AppShell } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { FormDialog } from '@/components/ui/form-dialog';
import {
  ConfirmDialog,
  DataTable,
  DataText,
  Field,
  PageHeader,
  Readout,
  Well,
  tableState,
} from '@/components/kit';
import { HarnessNexusError, type CredentialView } from '@harness-nexus/sdk';

type Scope = 'global' | 'personal';

/**
 * Credentials (Phase 2.1) — outbound secrets referenced by name.
 *
 * The page's whole vocabulary is one placeholder string, so the page states it
 * in a Well rather than in the sentence (02-content.md §1), and every row
 * repeats it as copyable protocol material.
 */
export function CredentialsPage() {
  const { logout, user } = useAuth();
  const { t } = useI18n();
  const [items, setItems] = useState<CredentialView[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<CredentialView | null>(null);
  const [busy, setBusy] = useState(false);
  const isAdmin = user?.role === 'admin';

  async function refresh() {
    try {
      setItems(await withAuthGuard(() => api.listCredentials(), logout));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function confirmRemove(): Promise<void> {
    if (pending === null) return;
    setBusy(true);
    try {
      await withAuthGuard(() => api.deleteCredential(pending.id), logout);
      toast.success(t('credentials.deletedToast'));
      setPending(null);
      await refresh();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.deleteFailed'));
    } finally {
      setBusy(false);
    }
  }

  const total = items?.length ?? 0;
  const globalCount = items?.filter((c) => c.scope === 'global').length ?? 0;

  return (
    <AppShell>
      <PageHeader
        title={t('credentials.title')}
        sub={
          <>
            {t('credentials.subtitle1')}{' '}
            <Well variant="chip" copy="${cred:NAME}">
              {'${cred:NAME}'}
            </Well>{' '}
            {t('credentials.subtitle2')}
          </>
        }
        actions={
          <Button onClick={() => setCreating(true)}>
            <PlusIcon className="size-4" />
            {t('common.create')}
          </Button>
        }
      />

      <DataTable
        columns={5}
        label={t('credentials.storedTitle')}
        icon={<KeyRoundIcon />}
        meta={
          items === null ? undefined : (
            <Readout
              layout="inline"
              size="sm"
              value={globalCount}
              total={total}
              label={t('common.scopeGlobal')}
            />
          )
        }
        state={tableState({ error, loading: items === null, count: total })}
        error={error}
        onRetry={() => void refresh()}
        empty={{
          title: t('credentials.empty'),
          hint: t('credentials.emptyHint'),
          action: (
            <Button onClick={() => setCreating(true)}>
              <PlusIcon className="size-4" />
              {t('common.create')}
            </Button>
          ),
        }}
      >
        <TableHeader>
          <TableRow>
            <TableHead>{t('common.name')}</TableHead>
            <TableHead>{t('credentials.placeholderHeader')}</TableHead>
            <TableHead>{t('credentials.previewHeader')}</TableHead>
            <TableHead>{t('common.scope')}</TableHead>
            <TableHead className="text-right">{t('common.actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items?.map((c) => {
            const placeholder = `\${cred:${c.name}}`;
            return (
              <TableRow key={c.id}>
                <TableCell className="font-medium">{c.name}</TableCell>
                <TableCell>
                  <Well copy={placeholder}>{placeholder}</Well>
                </TableCell>
                <TableCell>
                  <DataText size="sm" tone="dim">
                    {c.secretPreview}
                  </DataText>
                </TableCell>
                <TableCell>
                  <Badge variant={c.scope === 'global' ? 'default' : 'secondary'} className="gap-1">
                    {c.scope === 'global' ? (
                      <GlobeIcon className="size-3" />
                    ) : (
                      <UserIcon className="size-3" />
                    )}
                    {c.scope === 'global' ? t('common.scopeGlobal') : t('common.scopePersonal')}
                  </Badge>
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
                        disabled={c.scope === 'global' && !isAdmin}
                        onClick={() => setPending(c)}
                      >
                        <TrashIcon /> {t('common.delete')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </DataTable>

      {creating ? (
        <CreateCredential
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
          title={t('credentials.removeAction')}
          consequence={t('credentials.removeConsequence')}
          impact={[
            { label: 'credential', value: pending.name },
            ...(pending.scope === 'global' ? [{ label: 'scope', value: 'global' }] : []),
          ]}
          actionLabel={t('credentials.removeAction')}
          busy={busy}
          onConfirm={() => void confirmRemove()}
        />
      ) : null}
    </AppShell>
  );
}

function CreateCredential({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { logout, user } = useAuth();
  const { t } = useI18n();
  const isAdmin = user?.role === 'admin';
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');
  const [scope, setScope] = useState<Scope>('personal');
  // Phase 8 C2 — only meaningful for global scope (personal is always
  // distributable); off by default: non-distributable globals are served only
  // through the platform /mcp outlet.
  const [distributable, setDistributable] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await withAuthGuard(
        () =>
          api.createCredential({
            name,
            secret,
            scope,
            ...(scope === 'global' ? { distributable } : {}),
          }),
        logout,
      );
      toast.success(t('credentials.createdToast'));
      onCreated();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.createFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('credentials.addTitle')}
      description={t('credentials.addDesc')}
    >
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label={t('common.name')} htmlFor="cred-name" required>
            <Input
              id="cred-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('credentials.namePlaceholder')}
              autoComplete="off"
              spellCheck={false}
              required
            />
          </Field>
          <Field label={t('credentials.secret')} htmlFor="cred-secret" required>
            <Input
              id="cred-secret"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={t('credentials.secretPlaceholder')}
              required
              autoComplete="new-password"
              spellCheck={false}
            />
          </Field>
          <Field label={t('common.scope')} htmlFor="cred-scope">
            <Select value={scope} onValueChange={(v) => setScope(v as Scope)} disabled={!isAdmin}>
              <SelectTrigger id="cred-scope">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="personal">{t('common.scopePersonal')}</SelectItem>
                <SelectItem value="global" disabled={!isAdmin}>
                  {t('common.scopeGlobal')}
                  {!isAdmin && t('credentials.adminSuffix')}
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
        {scope === 'global' && isAdmin ? (
          <div className="flex items-center gap-3">
            <Switch
              id="cred-distributable"
              checked={distributable}
              onCheckedChange={setDistributable}
              aria-label={t('credentials.distributableAria')}
            />
            <Label htmlFor="cred-distributable" className="flex-wrap font-normal">
              {t('credentials.distributableLabel1')}{' '}
              <Well variant="chip" copy="hnx mcp serve">
                hnx mcp serve
              </Well>{' '}
              {t('credentials.distributableLabel2')}{' '}
              <Well variant="chip" copy="/mcp">
                /mcp
              </Well>{' '}
              {t('credentials.distributableLabel3')}
            </Label>
          </div>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={busy}>
            {busy ? t('credentials.creating') : t('credentials.createButton')}
          </Button>
        </div>
      </form>
    </FormDialog>
  );
}
