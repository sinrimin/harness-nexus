// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { BracesIcon, PlugZapIcon } from 'lucide-react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n } from '@/i18n';
import { PageSlot, usePageTitle } from '@/components/shell/page-slots.js';
import { PageAction } from '@/components/shell/page-action.js';
import { DataTable, Note, PageIntro, Panel, PanelHeader } from '@/components/kit';
import { tableState } from '@/components/kit/table.js';
import { Field } from '@/components/kit/field.js';
import { ConfirmDialog } from '@/components/kit/confirm-dialog.js';
import { FormDialog } from '@/components/ui/form-dialog.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { ApiToolServiceView } from '@harness-nexus/sdk';
import { HarnessNexusError } from '@harness-nexus/sdk';

/**
 * #80 — API tools: LLM-authored JSON bundles; the page is upload/download/
 * probe/display, deliberately NO per-field forms. Validation errors surface
 * verbatim — they are the authoring loop's feedback.
 */

function downloadBundle(service: ApiToolServiceView): void {
  const blob = new Blob([JSON.stringify(service.bundle, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${service.bundle.name}.api-tools.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function errText(e: unknown): string {
  return e instanceof HarnessNexusError ? e.message : String(e);
}

export function ApiToolsPage(): React.ReactNode {
  const { t } = useI18n();
  const { user, logout } = useAuth();
  const [items, setItems] = useState<ApiToolServiceView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [replaceOf, setReplaceOf] = useState<ApiToolServiceView | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<ApiToolServiceView | null>(null);
  const [probeTool, setProbeTool] = useState('');
  const [probeArgs, setProbeArgs] = useState('{}');
  const [probeResult, setProbeResult] = useState<string | null>(null);
  const [allowlist, setAllowlist] = useState<{ host: string; internal?: boolean }[] | null>(null);
  const [allowHost, setAllowHost] = useState('');
  const [allowInternal, setAllowInternal] = useState(false);

  usePageTitle(t('apiTools.title'));

  const refresh = (): void => {
    withAuthGuard(() => api.listApiToolServices(), logout)
      .then((res) => {
        setItems(res.services);
        setError(null);
      })
      .catch((e) => setError(errText(e)));
  };

  useEffect(refresh, [logout]);
  useEffect(() => {
    if (user?.role !== 'admin') return;
    withAuthGuard(() => api.getApiToolAllowlist(), logout)
      .then((res) => setAllowlist(res.entries))
      .catch(() => setAllowlist(null));
  }, [user?.role, logout]);

  const rows = useMemo(() => items ?? [], [items]);

  const confirmDelete = async (): Promise<void> => {
    if (pendingDelete === null) return;
    setBusy(true);
    try {
      await withAuthGuard(() => api.deleteApiToolService(pendingDelete.id), logout);
    } catch (e) {
      toast.error(t('apiTools.deleteFailed', { error: errText(e) }));
    }
    setBusy(false);
    setPendingDelete(null);
    refresh();
  };

  const runProbe = async (): Promise<void> => {
    if (probe === null) return;
    let args: Record<string, unknown> = {};
    try {
      args = probeArgs.trim() === '' ? {} : (JSON.parse(probeArgs) as Record<string, unknown>);
    } catch {
      toast.error(t('apiTools.probeArgsInvalid'));
      return;
    }
    setProbeResult(t('apiTools.probeRunning'));
    try {
      const res = await withAuthGuard(
        () => api.probeApiToolService(probe.id, probeTool, args),
        logout,
      );
      setProbeResult(res.result.output);
    } catch (e) {
      setProbeResult(errText(e));
    }
  };

  const saveAllowlist = (): void => {
    if (allowlist === null) return;
    withAuthGuard(() => api.updateApiToolAllowlist(allowlist), logout)
      .then(() => toast.success(t('apiTools.allowlistSaved')))
      .catch((e) => toast.error(errText(e)));
  };

  return (
    <>
      <PageSlot slot="actions">
        <PageAction label={t('apiTools.uploadButton')} onClick={() => setUploadOpen(true)} />
      </PageSlot>

      <PageIntro sub={t('apiTools.subtitle')} />

      {error !== null ? <Note tone="fail">{error}</Note> : null}

      <DataTable
        columns={5}
        label={t('apiTools.listTitle')}
        icon={<BracesIcon />}
        state={tableState({ error, loading: items === null, count: rows.length })}
        error={error}
        onRetry={() => refresh()}
        empty={{
          title: t('apiTools.empty'),
          hint: t('apiTools.emptyHint'),
        }}
      >
        <TableHeader>
          <TableRow>
            <TableHead>{t('common.name')}</TableHead>
            <TableHead>{t('apiTools.colBaseUrl')}</TableHead>
            <TableHead>{t('apiTools.colTools')}</TableHead>
            <TableHead>{t('common.scope')}</TableHead>
            <TableHead className="text-right">{t('common.actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((s) => (
            <TableRow key={s.id}>
              <TableCell>
                <span className="font-medium">{s.bundle.name}</span>
                {s.bundle.description !== undefined ? (
                  <span className="text-muted-foreground block truncate text-xs">
                    {s.bundle.description}
                  </span>
                ) : null}
              </TableCell>
              <TableCell>
                <span className="block max-w-64 truncate font-mono text-xs">
                  {s.bundle.baseUrl}
                </span>
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {s.bundle.tools.map((tool) => (
                    <Badge key={tool.name} variant="secondary" className="font-mono text-[10px]">
                      {tool.name}
                    </Badge>
                  ))}
                </div>
              </TableCell>
              <TableCell>
                <span className="font-mono text-xs">
                  {s.scope === 'global' ? t('common.scopeGlobal') : t('common.scopePersonal')}
                </span>
              </TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setProbe(s);
                      setProbeTool(s.bundle.tools[0]?.name ?? '');
                      setProbeArgs('{}');
                      setProbeResult(null);
                    }}
                  >
                    <PlugZapIcon className="size-3.5" />
                    {t('apiTools.probeAction')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => downloadBundle(s)}>
                    {t('apiTools.downloadAction')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setReplaceOf(s)}>
                    {t('apiTools.replaceAction')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPendingDelete({ id: s.id, name: s.bundle.name })}
                  >
                    {t('common.delete')}
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </DataTable>

      {user?.role === 'admin' && allowlist !== null ? (
        <Panel>
          <PanelHeader title={t('apiTools.allowlistTitle')} />
          <div className="space-y-2 p-4 text-sm">
            <p className="text-muted-foreground text-xs">{t('apiTools.allowlistHint')}</p>
            <div className="flex flex-wrap gap-1">
              {allowlist.length === 0 ? (
                <span className="text-muted-foreground text-xs">
                  {t('apiTools.allowlistEmpty')}
                </span>
              ) : (
                allowlist.map((e) => (
                  <Badge key={e.host} variant="secondary" className="font-mono text-[10px]">
                    {e.host}
                    {e.internal === true ? ' · internal' : ''}
                  </Badge>
                ))
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={allowHost}
                onChange={(e) => setAllowHost(e.target.value)}
                placeholder="api.example.com"
                spellCheck={false}
                autoComplete="off"
                className="border-input bg-background rounded-md px-2 py-1 font-mono text-xs"
                size={24}
              />
              <label className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  checked={allowInternal}
                  onChange={(e) => setAllowInternal(e.target.checked)}
                />
                {t('apiTools.allowlistInternal')}
              </label>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (allowHost.trim() === '') return;
                  setAllowlist([
                    ...allowlist.filter((x) => x.host !== allowHost.trim()),
                    { host: allowHost.trim(), ...(allowInternal ? { internal: true } : {}) },
                  ]);
                  setAllowHost('');
                  setAllowInternal(false);
                }}
              >
                {t('apiTools.allowlistAdd')}
              </Button>
              <Button size="sm" onClick={() => saveAllowlist()}>
                {t('common.save')}
              </Button>
            </div>
          </div>
        </Panel>
      ) : null}

      {uploadOpen || replaceOf !== null ? (
        <BundleDialog
          replacing={replaceOf}
          onClose={() => {
            setUploadOpen(false);
            setReplaceOf(null);
          }}
          onSaved={() => {
            setUploadOpen(false);
            setReplaceOf(null);
            refresh();
          }}
        />
      ) : null}

      {probe !== null ? (
        <FormDialog
          open
          onClose={() => setProbe(null)}
          title={t('apiTools.probeTitle', { name: probe.bundle.name })}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void runProbe();
            }}
            className="flex flex-col gap-4"
          >
            <Field label={t('apiTools.probeTool')}>
              <Select value={probeTool} onValueChange={setProbeTool}>
                <SelectTrigger className="w-full" aria-label={t('apiTools.probeTool')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {probe.bundle.tools.map((tool) => (
                    <SelectItem key={tool.name} value={tool.name}>
                      {tool.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('apiTools.probeArgs')} hint={t('apiTools.probeArgsHint')}>
              <textarea
                value={probeArgs}
                onChange={(e) => setProbeArgs(e.target.value)}
                rows={3}
                spellCheck={false}
                className="font-mono text-xs"
              />
            </Field>
            {probeResult !== null ? (
              <pre className="bg-muted/50 max-h-72 overflow-auto rounded-md border p-3 font-mono text-xs whitespace-pre-wrap">
                {probeResult}
              </pre>
            ) : null}
            <Button type="submit">{t('apiTools.probeRun')}</Button>
          </form>
        </FormDialog>
      ) : null}

      {pendingDelete !== null ? (
        <ConfirmDialog
          open
          title={t('apiTools.deleteTitle')}
          consequence={t('apiTools.deleteBody')}
          impact={[{ label: 'service', value: pendingDelete.name }]}
          actionLabel={t('common.delete')}
          tone="danger"
          irreversible={false}
          busy={busy}
          onOpenChange={(o) => {
            if (!o) setPendingDelete(null);
          }}
          onConfirm={() => void confirmDelete()}
        />
      ) : null}
    </>
  );
}

/** The upload/replace dialog: a JSON textarea IS the interface (#80). */
function BundleDialog({
  replacing,
  onClose,
  onSaved,
}: {
  replacing: ApiToolServiceView | null;
  onClose: () => void;
  onSaved: () => void;
}): React.ReactNode {
  const { t } = useI18n();
  const { user, logout } = useAuth();
  const [text, setText] = useState(
    replacing !== null ? JSON.stringify(replacing.bundle, null, 2) : '{\n  "version": 1\n}\n',
  );
  const [scope, setScope] = useState<'personal' | 'global'>('personal');
  const [busy, setBusy] = useState(false);

  const save = async (): Promise<void> => {
    let bundle: unknown;
    try {
      bundle = JSON.parse(text);
    } catch {
      toast.error(t('apiTools.jsonInvalid'));
      return;
    }
    setBusy(true);
    try {
      if (replacing !== null) {
        await withAuthGuard(() => api.updateApiToolService(replacing.id, bundle), logout);
      } else {
        await withAuthGuard(
          () =>
            api.createApiToolService(
              bundle,
              scope === 'global' && user?.role === 'admin' ? 'global' : 'personal',
            ),
          logout,
        );
      }
      toast.success(t('apiTools.saved'));
      onSaved();
    } catch (e) {
      toast.error(t('apiTools.saveFailed', { error: errText(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormDialog
      open
      onClose={onClose}
      title={replacing !== null ? t('apiTools.replaceTitle') : t('apiTools.uploadTitle')}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="flex flex-col gap-4"
      >
        {replacing === null && user?.role === 'admin' ? (
          <Field label={t('common.scope')}>
            <Select
              value={scope}
              onValueChange={(v) => setScope(v === 'global' ? 'global' : 'personal')}
            >
              <SelectTrigger className="w-full" aria-label={t('common.scope')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="personal">{t('common.scopePersonal')}</SelectItem>
                <SelectItem value="global">{t('common.scopeGlobal')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        ) : null}
        <Field label={t('apiTools.bundleLabel')} hint={t('apiTools.bundleHint')}>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={16}
            spellCheck={false}
            className="font-mono text-xs"
          />
        </Field>
        <Button type="submit" disabled={busy}>
          {t('common.save')}
        </Button>
      </form>
    </FormDialog>
  );
}
