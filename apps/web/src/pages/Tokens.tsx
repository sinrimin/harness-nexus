import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  KeyRoundIcon,
  PlusIcon,
  TrashIcon,
  CopyIcon,
  CheckIcon,
  MoreHorizontalIcon,
} from 'lucide-react';
import { api } from '@/api';
import {
  ConfirmDialog,
  DataTable,
  FilterBar,
  FilterSelect,
  PageIntro,
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
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n, dateLocale } from '@/i18n';
import { PageSlot } from '@/components/shell/page-slots';
import { PageAction } from '@/components/shell/page-action';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { FormDialog } from '@/components/ui/form-dialog';
import { HarnessNexusError, type PatView } from '@harness-nexus/sdk';

/** The list's vocabulary (07-p3-list-pages.md §5). */
const TOKEN_SPEC: ListQuerySpec = {
  filters: { kind: ['api', 'marketplace'] },
  sort: ['-created', 'name'],
};

/**
 * A token's purpose is carried by its scopes, not by a field (pats.ts:
 * `kind: 'marketplace'` becomes `scopes: ['marketplace']`). So the filter reads
 * the same fact the Scope column shows.
 */
function tokenKind(p: PatView): 'api' | 'marketplace' {
  return p.scopes.includes('marketplace') ? 'marketplace' : 'api';
}

export function TokensPage() {
  const { logout } = useAuth();
  const { t, lang } = useI18n();
  const [items, setItems] = useState<PatView[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState<PatView | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      setItems(await withAuthGuard(() => api.listPats(), logout));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const query = useListQuery(TOKEN_SPEC);
  const visible = useMemo(() => {
    if (items === null) return null;
    const rows = items.filter(
      (p) =>
        matchesQuery(query.q, [p.name, p.prefix, p.scopes]) &&
        (query.filters['kind'] === null || tokenKind(p) === query.filters['kind']),
    );
    return sortRows(rows, effectiveSort(TOKEN_SPEC, query), (p, key) =>
      key === 'name' ? p.name : p.createdAt,
    );
  }, [items, query.q, query.filters, query.sort]);

  const kindLabels = useMemo(
    () => ({ api: t('tokens.kindApi'), marketplace: t('tokens.kindMarketplace') }),
    [t],
  );
  const sortLabels = useMemo(
    () => ({ '-created': t('tokens.sortNewest'), name: t('common.sortName') }),
    [t],
  );

  async function confirmRevoke() {
    const p = pending;
    if (p === null) return;
    setBusy(true);
    try {
      await withAuthGuard(() => api.revokePat(p.id), logout);
      toast.success(t('tokens.revokedToast'));
      setPending(null);
      await refresh();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('tokens.revokeFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageSlot slot="actions">
        <PageAction label={t('tokens.createButton')} onClick={() => setCreating(true)} />
      </PageSlot>

      <PageIntro
        sub={
          <>
            {t('tokens.subtitle1')}
            <Well variant="chip" copy="hnpat_">
              {'hnpat_…'}
            </Well>
            {t('tokens.subtitle2')} <strong>{t('tokens.subtitleMarketplace')}</strong>
            {t('tokens.subtitle3')} <strong>{t('tokens.subtitleOnce')}</strong>
            {t('tokens.subtitle4')}
          </>
        }
      />

      <DataTable
        columns={7}
        label={t('tokens.listTitle')}
        icon={<KeyRoundIcon />}
        state={tableState({
          error,
          loading: items === null,
          count: visible?.length ?? 0,
          filtered: query.active,
        })}
        error={error}
        onRetry={() => void refresh()}
        onClearFilters={query.clear}
        toolbar={
          <FilterBar query={query} shown={visible?.length} total={items?.length}>
            <TableSearch query={query} placeholder={t('tokens.searchPlaceholder')} />
            <FilterSelect
              query={query}
              spec={TOKEN_SPEC}
              name="kind"
              allLabel={t('tokens.allKinds')}
              labels={kindLabels}
            />
            <SortSelect
              query={query}
              spec={TOKEN_SPEC}
              label={t('common.sortLabel')}
              labels={sortLabels}
            />
          </FilterBar>
        }
        empty={{
          title: t('tokens.empty'),
          hint: t('tokens.emptyHint'),
          action: (
            <Button onClick={() => setCreating(true)} className="gap-1.5">
              <PlusIcon className="size-4" />
              {t('tokens.createButton')}
            </Button>
          ),
        }}
      >
        <TableHeader>
          <TableRow>
            <TableHead>{t('common.name')}</TableHead>
            <TableHead>{t('tokens.prefix')}</TableHead>
            <TableHead>{t('tokens.scopes')}</TableHead>
            <TableHead>{t('tokens.expires')}</TableHead>
            <TableHead>{t('tokens.lastUsed')}</TableHead>
            <TableHead>{t('tokens.created')}</TableHead>
            <TableHead className="text-right">{t('common.actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible?.map((p) => (
            <TableRow key={p.id}>
              <TableCell className="font-medium">{p.name}</TableCell>
              <TableCell className="font-mono text-xs tabular-nums">{p.prefix}…</TableCell>
              <TableCell>
                {p.scopes.length === 0 ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {p.scopes.map((s) => (
                      <Badge key={s} variant="secondary" className="font-mono text-[10px]">
                        {s}
                      </Badge>
                    ))}
                  </div>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground tabular-nums">
                {p.expiresAt ? (
                  new Date(p.expiresAt).toLocaleDateString(dateLocale(lang), {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                  })
                ) : (
                  <span className="text-muted-foreground">{t('tokens.never')}</span>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground tabular-nums">
                {p.lastUsedAt ? (
                  new Date(p.lastUsedAt).toLocaleDateString(dateLocale(lang), {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                  })
                ) : (
                  <span className="text-muted-foreground">{t('tokens.never')}</span>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground tabular-nums">
                {new Date(p.createdAt).toLocaleDateString(dateLocale(lang), {
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
                    <DropdownMenuItem variant="destructive" onClick={() => setPending(p)}>
                      <TrashIcon /> {t('tokens.revoke')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </DataTable>

      {creating ? (
        <CreateToken onClose={() => setCreating(false)} onCreated={() => void refresh()} />
      ) : null}

      {pending !== null ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) setPending(null);
          }}
          title={t('tokens.revokeAction')}
          consequence={t('tokens.revokeConsequence')}
          impact={[
            { label: 'token', value: pending.name },
            { label: 'prefix', value: pending.prefix },
            { label: 'kind', value: tokenKind(pending) },
          ]}
          // Tier 2: a revoked token cannot be restored — the reader types its
          // name (03-interaction.md §2).
          confirmPhrase={pending.name}
          actionLabel={t('tokens.revokeAction')}
          busy={busy}
          onConfirm={() => void confirmRevoke()}
        />
      ) : null}
    </>
  );
}

/** The create form in a dialog, plus the one-shot token reveal dialog. */
function CreateToken({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { logout } = useAuth();
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'api' | 'marketplace'>('api');
  const [expiresLocal, setExpiresLocal] = useState(''); // datetime-local string, "" = never
  const [busy, setBusy] = useState(false);
  // The raw token lives only here, never in the list. Cleared on dialog close.
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  // For marketplace tokens: the one-shot `claude plugin marketplace add` command.
  const [createdAddCommand, setCreatedAddCommand] = useState<string | null>(null);
  const [copied, setCopied] = useState<'token' | 'command' | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const expiresAt = expiresLocal === '' ? undefined : new Date(expiresLocal).toISOString();
      const { token, addCommand } = await withAuthGuard(
        () => api.createPat({ name, ...(kind !== 'api' ? { kind } : {}), expiresAt }),
        logout,
      );
      toast.success(t('tokens.createdToast'));
      setCreatedToken(token);
      setCreatedAddCommand(addCommand ?? null);
      setCopied(null);
      setName('');
      setExpiresLocal('');
      // The form dialog closes itself (the reveal takes over below); the page
      // stays mounted until the reader dismisses the token, because the token
      // exists nowhere else.
      onCreated();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.createFailed'));
    } finally {
      setBusy(false);
    }
  }

  function copy(kind: 'token' | 'command', text: string | null) {
    if (!text) return;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(kind);
      toast.success(
        kind === 'token' ? t('tokens.tokenCopiedToast') : t('tokens.commandCopiedToast'),
      );
    });
  }

  return (
    <>
      {/* One dialog at a time: the form until the token exists, then the
          reveal. Both live here so the token never leaves this component. */}
      <FormDialog
        open={createdToken === null}
        onClose={onClose}
        title={t('tokens.newTitle')}
        description={t('tokens.newDesc')}
      >
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="pat-name">{t('common.name')}</Label>
              <Input
                id="pat-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('tokens.namePlaceholder')}
                autoComplete="off"
                spellCheck={false}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="pat-kind">{t('tokens.purpose')}</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as 'api' | 'marketplace')}>
                <SelectTrigger id="pat-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="api">{t('tokens.kindApi')}</SelectItem>
                  <SelectItem value="marketplace">{t('tokens.kindMarketplace')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="pat-expires">{t('tokens.expiresOptional')}</Label>
            <Input
              id="pat-expires"
              type="datetime-local"
              value={expiresLocal}
              onChange={(e) => setExpiresLocal(e.target.value)}
            />
          </div>
          {kind === 'marketplace' && (
            <p className="text-muted-foreground text-sm">
              {t('tokens.note1')}
              <code className="font-mono">claude-code</code> {t('tokens.note2')}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? t('tokens.creating') : t('tokens.createButton')}
            </Button>
          </div>
        </form>
      </FormDialog>

      <Dialog
        open={createdToken !== null}
        onOpenChange={(o) => {
          if (!o) {
            setCreatedToken(null);
            setCreatedAddCommand(null);
            onClose();
          }
        }}
      >
        <DialogContent showCloseButton={false} className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('tokens.revealTitle')}</DialogTitle>
            <DialogDescription>{t('tokens.revealDesc')}</DialogDescription>
          </DialogHeader>

          <Alert variant="destructive">
            <AlertDescription>{t('tokens.revealWarning')}</AlertDescription>
          </Alert>

          {createdAddCommand && (
            <div className="grid gap-2">
              <p className="text-sm font-medium">{t('tokens.installLabel')}</p>
              <div className="bg-muted flex items-center gap-2 rounded-md border p-3">
                <code className="text-foreground min-w-0 flex-1 break-all font-mono text-xs">
                  {createdAddCommand}
                </code>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="shrink-0"
                  onClick={() => copy('command', createdAddCommand)}
                >
                  {copied === 'command' ? (
                    <CheckIcon className="size-4" />
                  ) : (
                    <CopyIcon className="size-4" />
                  )}
                  {copied === 'command' ? t('common.copied') : t('common.copy')}
                </Button>
              </div>
            </div>
          )}

          <div className="bg-muted flex items-center gap-2 rounded-md border p-3">
            <code className="text-foreground min-w-0 flex-1 break-all font-mono text-sm">
              {createdToken}
            </code>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="shrink-0"
              onClick={() => copy('token', createdToken)}
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
            <Button
              type="button"
              onClick={() => {
                setCreatedToken(null);
                setCreatedAddCommand(null);
                onClose();
              }}
            >
              {t('common.done')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
