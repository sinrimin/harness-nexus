import { useEffect, useState } from 'react';
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
import { PageIntro, Well } from '@/components/kit';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n, dateLocale } from '@/i18n';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import { HarnessNexusError, type PatView } from '@harness-nexus/sdk';

export function TokensPage() {
  const { logout } = useAuth();
  const { t, lang } = useI18n();
  const [items, setItems] = useState<PatView[] | null>(null);

  async function refresh() {
    try {
      setItems(await withAuthGuard(() => api.listPats(), logout));
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('tokens.loadFailed'));
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function revoke(p: PatView) {
    if (!confirm(t('tokens.confirmRevoke', { name: p.name }))) return;
    try {
      await withAuthGuard(() => api.revokePat(p.id), logout);
      toast.success(t('tokens.revokedToast'));
      await refresh();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('tokens.revokeFailed'));
    }
  }

  return (
    <>
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

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRoundIcon className="size-4" />
            {t('tokens.listTitle')}
          </CardTitle>
          <CardDescription>{t('tokens.listDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-6">{t('common.name')}</TableHead>
                <TableHead>{t('tokens.prefix')}</TableHead>
                <TableHead>{t('tokens.scopes')}</TableHead>
                <TableHead>{t('tokens.expires')}</TableHead>
                <TableHead>{t('tokens.lastUsed')}</TableHead>
                <TableHead>{t('tokens.created')}</TableHead>
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
                    {t('tokens.empty')}
                  </TableCell>
                </TableRow>
              ) : (
                items.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="pl-6 font-medium">{p.name}</TableCell>
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
                    <TableCell className="pr-6 text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="size-8">
                            <MoreHorizontalIcon className="size-4" />
                            <span className="sr-only">{t('common.openMenu')}</span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem variant="destructive" onClick={() => revoke(p)}>
                            <TrashIcon /> {t('tokens.revoke')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <CreateToken onCreated={refresh} />
    </>
  );
}

/** Renders the create form and the one-shot token reveal dialog. */
function CreateToken({ onCreated }: { onCreated: () => void }) {
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
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <PlusIcon className="size-4" />
            {t('tokens.newTitle')}
          </CardTitle>
          <CardDescription>{t('tokens.newDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
              <div className="grid gap-2">
                <Label htmlFor="pat-expires">{t('tokens.expiresOptional')}</Label>
                <Input
                  id="pat-expires"
                  type="datetime-local"
                  value={expiresLocal}
                  onChange={(e) => setExpiresLocal(e.target.value)}
                />
              </div>
            </div>
            {kind === 'marketplace' && (
              <p className="text-muted-foreground text-sm">
                {t('tokens.note1')}
                <code className="font-mono">claude-code</code> {t('tokens.note2')}
              </p>
            )}
            <div>
              <Button type="submit" disabled={busy}>
                {busy ? t('tokens.creating') : t('tokens.createButton')}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Dialog
        open={createdToken !== null}
        onOpenChange={(o) => {
          if (!o) {
            setCreatedToken(null);
            setCreatedAddCommand(null);
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
