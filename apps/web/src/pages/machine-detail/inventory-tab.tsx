import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { BoxesIcon, CameraIcon, GitCompareArrowsIcon, LaptopIcon, UploadIcon } from 'lucide-react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n, dateLocale } from '@/i18n';
import {
  HarnessNexusError,
  type ImportResult,
  type InventoryDiff,
  type Profile,
} from '@harness-nexus/sdk';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { ConfirmDialog, Note, TableStateRow } from '@/components/kit';
import type { InventoryEntry } from './types.js';

/**
 * 清单 tab — the scanned artifact surface: per-target item tables (what the
 * agent's own store holds), capture-as-profile per target, and the C3
 * diff/import flow at the bottom. Runtime management lives in the 代理 tab.
 */
export function InventoryTab({
  inventory,
  machineId,
  targets,
}: {
  inventory: InventoryEntry[] | null;
  machineId: string;
  targets: string[];
}) {
  const { t } = useI18n();
  if (inventory === null) {
    return (
      <>
        <p className="text-muted-foreground py-8 text-center text-sm">
          {t('machineDetail.loadingInventory')}
        </p>
      </>
    );
  }
  if (inventory.length === 0) {
    return (
      <>
        <Card>
          <CardContent className="text-muted-foreground py-8 text-center text-sm">
            {t('machineDetail.emptyInventory')}
          </CardContent>
        </Card>
      </>
    );
  }
  return (
    <>
      <div className="flex flex-col gap-6">
        {inventory.map((entry) => (
          <TargetItemsCard key={entry.target} entry={entry} machineId={machineId} />
        ))}
        {targets.length > 0 ? <DiffAndImport machineId={machineId} targets={targets} /> : null}
      </div>
    </>
  );
}

/** One target's scanned items + capture-as-profile footer. */
function TargetItemsCard({ entry, machineId }: { entry: InventoryEntry; machineId: string }) {
  const { t, lang } = useI18n();
  const agent = entry.agents[0];
  const items = entry.agents.flatMap((a) => a.items);
  const notInstalled = entry.runtime !== null && !entry.runtime.installed;
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <LaptopIcon className="size-4" />
            <span className="font-mono">{entry.target}</span>
            {agent?.profileApplied ? (
              <Badge variant="secondary" className="text-[10px]">
                {t('machineDetail.profileApplied')}
              </Badge>
            ) : null}
          </CardTitle>
          <CardDescription>
            {notInstalled ? `${t('machineDetail.runtimeNotInstalled')} · ` : ''}
            {t('machineDetail.itemsReported', {
              count: items.length,
              time: new Date(entry.reportedAt).toLocaleString(dateLocale(lang)),
            })}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-0 px-0">
          {/* A not-installed Agent leads with its absence; leftover items (if
            any) still render honestly below — files can outlive binaries. */}
          {notInstalled && items.length === 0 ? (
            // Degradation, not emptiness (03-interaction.md §1): the reason
            // sits in a note where a centred sentence used to.
            <div className="p-(--panel-pad)">
              <Note tone="warn" title={t('machineDetail.runtimeNotInstalled')} />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">{t('machineDetail.kind')}</TableHead>
                  <TableHead>{t('common.name')}</TableHead>
                  <TableHead>{t('machineDetail.origin')}</TableHead>
                  <TableHead>{t('machineDetail.summary')}</TableHead>
                  <TableHead className="pr-6">{t('machineDetail.path')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.length === 0 ? (
                  // P6 — the vacuum is a designed state row, not a centred
                  // sentence: lamp sockets, the fact, and nothing else (the
                  // action — Scan — lives in the page header).
                  <TableStateRow
                    state="empty"
                    columns={5}
                    empty={{ title: t('machineDetail.emptyTarget') }}
                  />
                ) : (
                  items.map((item) => (
                    <TableRow key={`${item.kind}:${item.name}`}>
                      <TableCell className="pl-6">
                        <KindBadge kind={item.kind} />
                      </TableCell>
                      <TableCell className="font-mono text-xs">{item.name}</TableCell>
                      <TableCell>
                        <OriginBadge origin={item.origin} />
                      </TableCell>
                      <TableCell className="max-w-[28rem] truncate text-muted-foreground text-xs">
                        {item.importable
                          ? (item.summary ?? item.contentPreview ?? '—')
                          : t('machineDetail.notImportable', {
                              note: item.note ?? t('machineDetail.unknown'),
                            })}
                      </TableCell>
                      <TableCell className="text-muted-foreground pr-6 font-mono text-xs">
                        {item.path}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
          <CaptureForm machineId={machineId} target={entry.target} />
        </CardContent>
      </Card>
    </>
  );
}

function KindBadge({ kind }: { kind: string }) {
  return (
    <>
      <Badge variant="outline" className="font-mono text-[10px]">
        {kind}
      </Badge>
    </>
  );
}

function OriginBadge({ origin }: { origin: 'platform' | 'local' }) {
  const { t } = useI18n();
  return (
    <>
      <Badge variant={origin === 'platform' ? 'secondary' : 'default'} className="text-[10px]">
        {origin === 'platform' ? 'hnx' : t('machineDetail.originLocal')}
      </Badge>
    </>
  );
}

/** Capture-as-profile footer (Phase 9 W1) — confirm-first, one input + button. */
function CaptureForm({ machineId, target }: { machineId: string; target: string }) {
  const { logout } = useAuth();
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  // P6 — the confirm dialog; the button below opens it, the dialog confirms.
  const [ask, setAsk] = useState(false);

  async function capture(): Promise<void> {
    setAsk(false);
    setBusy(true);
    try {
      const res = await withAuthGuard(
        () =>
          api.captureMachineInventory(machineId, {
            target: target as Parameters<typeof api.captureMachineInventory>[1]['target'],
            profileName: name.trim(),
          }),
        logout,
      );
      toast.success(t('machineDetail.capturedToast', { name: res.profile.name, target }));
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('machineDetail.captureFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="flex flex-wrap items-end gap-3 border-t px-6 pt-4">
        <div className="grid min-w-56 gap-2">
          <Label htmlFor={`capture-${target}`}>{t('machineDetail.captureNameLabel')}</Label>
          <Input
            id={`capture-${target}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('machineDetail.captureNamePlaceholder')}
            autoComplete="off"
            spellCheck={false}
            required
          />
        </div>
        <Button
          variant="outline"
          onClick={() => setAsk(true)}
          disabled={busy || name.trim() === ''}
        >
          <CameraIcon className="size-4" />
          {busy ? t('machineDetail.capturing') : t('machineDetail.captureButton')}
        </Button>
      </div>

      {ask ? (
        <ConfirmDialog
          open
          onOpenChange={setAsk}
          title={t('machineDetail.captureButton')}
          consequence={t('machineDetail.captureConsequence')}
          impact={[
            { label: 'target', value: target },
            { label: 'profile', value: name.trim() },
          ]}
          actionLabel={t('machineDetail.captureButton')}
          // A new profile is deletable, so this is the ordinary tier.
          tone="default"
          irreversible={false}
          busy={busy}
          onConfirm={() => void capture()}
        />
      ) : null}
    </>
  );
}

function DiffAndImport({ machineId, targets }: { machineId: string; targets: string[] }) {
  const { logout } = useAuth();
  const { t } = useI18n();
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const [profileId, setProfileId] = useState<string>('');
  const [diff, setDiff] = useState<InventoryDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [profileName, setProfileName] = useState('');
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setProfiles(await withAuthGuard(() => api.listProfiles(), logout));
      } catch {
        setProfiles([]);
      }
    })();
  }, [logout]);

  const eligible = useMemo(
    () => (profiles ?? []).filter((p) => targets.includes(p.target)),
    [profiles, targets],
  );

  async function runDiff(id: string): Promise<void> {
    setDiff(null);
    setDiffError(null);
    setSelected(new Set());
    setResult(null);
    try {
      setDiff(await withAuthGuard(() => api.diffMachineInventory(machineId, id), logout));
    } catch (e) {
      setDiffError(e instanceof HarnessNexusError ? e.message : t('machineDetail.diffFailed'));
    }
  }

  function toggle(key: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function runImport(): Promise<void> {
    if (!diff) return;
    const items = diff.notInProfile
      .filter((i) => i.importable && selected.has(`${i.kind}:${i.name}`))
      .map((i) => ({ kind: i.kind, name: i.name }));
    if (items.length === 0) {
      toast.error(t('machineDetail.selectFirst'));
      return;
    }
    setImporting(true);
    try {
      const res = await withAuthGuard(
        () =>
          api.importMachineInventory(machineId, {
            target: diff.target,
            profileName: profileName.trim(),
            items,
          }),
        logout,
      );
      setResult(res);
      toast.success(
        t('machineDetail.createdToast', {
          name: res.profile.name,
          created: res.created.length,
          reused: res.reused.length,
        }),
      );
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('machineDetail.importFailed'));
    } finally {
      setImporting(false);
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <GitCompareArrowsIcon className="size-4" />
            {t('machineDetail.diffTitle')}
          </CardTitle>
          <CardDescription>{t('machineDetail.diffDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid min-w-64 gap-2">
              <Label htmlFor="diff-profile">{t('machineDetail.profileLabel')}</Label>
              <Select
                value={profileId}
                onValueChange={(v) => {
                  setProfileId(v);
                  void runDiff(v);
                }}
              >
                <SelectTrigger id="diff-profile" className="font-mono text-xs">
                  <SelectValue placeholder={t('machineDetail.pickProfile')} />
                </SelectTrigger>
                <SelectContent>
                  {eligible.map((p) => (
                    <SelectItem key={p.id} value={p.id} className="font-mono text-xs">
                      {p.name} ({p.target})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <p className="text-muted-foreground pb-2 text-sm">
              {eligible.length === 0 ? t('machineDetail.noProfileMatch') : null}
            </p>
          </div>

          {diffError ? (
            <Alert variant="destructive">
              <AlertDescription>{diffError}</AlertDescription>
            </Alert>
          ) : null}

          {diff ? (
            <>
              <div className="grid gap-2 sm:grid-cols-3">
                <SummaryStat label={t('machineDetail.statApplied')} value={diff.summary.applied} />
                <SummaryStat label={t('machineDetail.statMissing')} value={diff.summary.missing} />
                <SummaryStat
                  label={t('machineDetail.statCandidates')}
                  value={diff.summary.candidates}
                />
              </div>

              {diff.missingOnMachine.length > 0 ? (
                <div>
                  <p className="mb-1 text-sm font-medium">{t('machineDetail.driftHeading')}</p>
                  <ul className="text-muted-foreground flex flex-wrap gap-2 text-xs">
                    {diff.missingOnMachine.map((e) => (
                      <li key={`${e.kind}:${e.name}`} className="border rounded-md px-2 py-1">
                        <span className="font-mono">
                          {e.kind}:{e.name}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <div>
                <p className="mb-1 text-sm font-medium">
                  {t('machineDetail.candidatesHeading', { count: diff.notInProfile.length })}
                </p>
                {diff.notInProfile.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    {t('machineDetail.nothingToImport')}
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {diff.notInProfile.map((item) => {
                      const key = `${item.kind}:${item.name}`;
                      return (
                        <li key={key} className="flex items-center gap-2">
                          <Checkbox
                            id={`imp-${key}`}
                            checked={selected.has(key)}
                            onCheckedChange={() => toggle(key)}
                            disabled={!item.importable}
                            aria-label={t('machineDetail.importItemAria', { name: item.name })}
                          />
                          <label
                            htmlFor={`imp-${key}`}
                            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-sm"
                          >
                            <KindBadge kind={item.kind} />
                            <span className="font-mono text-xs">{item.name}</span>
                            <span className="text-muted-foreground truncate text-xs">
                              {item.summary ?? item.path}
                            </span>
                            {!item.importable ? (
                              <span className="text-muted-foreground text-xs">
                                {item.note
                                  ? t('machineDetail.notImportableShortNote', { note: item.note })
                                  : t('machineDetail.notImportableShort')}
                              </span>
                            ) : null}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              {diff.notInProfile.some((i) => i.importable) ? (
                <div className="flex flex-wrap items-end gap-3 border-t pt-4">
                  <div className="grid min-w-64 gap-2">
                    <Label htmlFor="import-profile-name">{t('machineDetail.newNameLabel')}</Label>
                    <Input
                      id="import-profile-name"
                      value={profileName}
                      onChange={(e) => setProfileName(e.target.value)}
                      placeholder={t('machineDetail.newNamePlaceholder')}
                      autoComplete="off"
                      spellCheck={false}
                      required
                    />
                  </div>
                  <Button
                    onClick={() => void runImport()}
                    disabled={importing || profileName.trim().length === 0 || selected.size === 0}
                  >
                    <UploadIcon className="size-4" />
                    {importing
                      ? t('machineDetail.importing')
                      : t('machineDetail.importButton', { count: selected.size })}
                  </Button>
                </div>
              ) : null}
            </>
          ) : null}

          {result ? (
            <Alert>
              <BoxesIcon className="size-4" />
              <AlertTitle>
                {t('machineDetail.importedInto')}{' '}
                <Link to="/profiles" className="underline">
                  {result.profile.name}
                </Link>{' '}
                {result.failed.length > 0
                  ? t('machineDetail.importStatsFailed', {
                      created: result.created.length,
                      reused: result.reused.length,
                      failed: result.failed.length,
                    })
                  : t('machineDetail.importStats', {
                      created: result.created.length,
                      reused: result.reused.length,
                    })}
              </AlertTitle>
              <AlertDescription>
                {result.failed.length > 0 ? (
                  <span className="block">
                    {t('machineDetail.failedList', {
                      list: result.failed.map((f) => `${f.name} (${f.error})`).join('; '),
                    })}
                  </span>
                ) : null}
                {result.warnings.length > 0 ? (
                  <span className="block">
                    {result.warnings.map((w, i) => (
                      <span key={i} className="block">
                        · {w}
                      </span>
                    ))}
                  </span>
                ) : null}
              </AlertDescription>
            </Alert>
          ) : null}
        </CardContent>
      </Card>
    </>
  );
}

function SummaryStat({ label, value }: { label: string; value: number }) {
  return (
    <>
      <div className="rounded-md border p-3">
        <p className="font-mono text-xl tabular-nums">{value}</p>
        <p className="text-muted-foreground text-xs">{label}</p>
      </div>
    </>
  );
}
