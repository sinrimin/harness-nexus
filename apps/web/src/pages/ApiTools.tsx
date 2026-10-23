// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  ArrowDownToLineIcon,
  BracesIcon,
  EyeIcon,
  FileUpIcon,
  MoreHorizontalIcon,
  PlugZapIcon,
  TrashIcon,
} from 'lucide-react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n } from '@/i18n';
import { PageSlot, usePageTitle } from '@/components/shell/page-slots.js';
import { PageAction } from '@/components/shell/page-action.js';
import { DataTable, Note, PageIntro, Panel, PanelHeader, ScopeBadge, Well } from '@/components/kit';
import { tableState } from '@/components/kit/table.js';
import { Field } from '@/components/kit/field.js';
import { ConfirmDialog } from '@/components/kit/confirm-dialog.js';
import { FormDialog } from '@/components/ui/form-dialog.js';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { Checkbox } from '@/components/ui/checkbox.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { ApiToolServiceView } from '@harness-nexus/sdk';
import { HarnessNexusError } from '@harness-nexus/sdk';

/**
 * #80 — API tools: LLM-authored JSON bundles; the page is upload/download/
 * probe/display, deliberately NO per-field forms for AUTHORING. Reading is a
 * different matter: the detail dialog and the probe's parameter form render
 * the bundle human-readable — `in`/`type`/`required` are protocol vocabulary
 * (OpenAPI-style parameter locations), shown as a table instead of raw JSON.
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
  const [detailOf, setDetailOf] = useState<ApiToolServiceView | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<ApiToolServiceView | null>(null);
  const [allowlist, setAllowlist] = useState<{ host: string; internal?: boolean }[] | null>(null);
  // #85 — the outbound host policy riding next to the allowlist (admin).
  const [outbound, setOutbound] = useState<'open' | 'restricted' | null>(null);

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
    withAuthGuard(() => api.getApiToolOutbound(), logout)
      .then((res) => setOutbound(res.outbound))
      .catch(() => setOutbound(null));
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
        className="mb-(--gap)"
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
                <Well variant="chip" copy={s.bundle.baseUrl}>
                  {s.bundle.baseUrl}
                </Well>
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap gap-1">
                  {s.bundle.tools.map((tool) => (
                    <Well key={tool.name} variant="chip" copy={tool.name}>
                      {tool.name}
                    </Well>
                  ))}
                </div>
              </TableCell>
              <TableCell>
                <ScopeBadge scope={s.scope} />
              </TableCell>
              <TableCell className="text-right">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="size-(--row-ctl-h)">
                      <MoreHorizontalIcon className="size-4" />
                      <span className="sr-only">{t('common.openMenu')}</span>
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setDetailOf(s)}>
                      <EyeIcon /> {t('apiTools.detailAction')}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => {
                        setProbe(s);
                      }}
                    >
                      <PlugZapIcon /> {t('apiTools.probeAction')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => downloadBundle(s)}>
                      <ArrowDownToLineIcon /> {t('apiTools.downloadAction')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setReplaceOf(s)}>
                      <FileUpIcon /> {t('apiTools.replaceAction')}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => setPendingDelete({ id: s.id, name: s.bundle.name })}
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

      {user?.role === 'admin' && allowlist !== null ? (
        <AllowlistPanel
          entries={allowlist}
          outbound={outbound}
          onOutboundChange={(v) => setOutbound(v)}
          onOutboundSave={(v) => {
            withAuthGuard(() => api.setApiToolOutbound(v), logout)
              .then(() => toast.success(t('apiTools.policySaved')))
              .catch((e) => toast.error(errText(e)));
          }}
          onChange={setAllowlist}
          onSave={saveAllowlist}
        />
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

      {detailOf !== null ? (
        <ServiceDetailDialog service={detailOf} onClose={() => setDetailOf(null)} />
      ) : null}

      {probe !== null ? <ProbeDialog service={probe} onClose={() => setProbe(null)} /> : null}

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

// ---- allowlist (admin) ----

function AllowlistPanel({
  entries,
  outbound,
  onOutboundChange,
  onOutboundSave,
  onChange,
  onSave,
}: {
  entries: { host: string; internal?: boolean }[];
  /** #85 — `open` (default) dials any host; `restricted` enforces the list. */
  outbound: 'open' | 'restricted' | null;
  onOutboundChange: (v: 'open' | 'restricted') => void;
  onOutboundSave: (v: 'open' | 'restricted') => void;
  onChange: (next: { host: string; internal?: boolean }[]) => void;
  onSave: () => void;
}): React.ReactNode {
  const { t } = useI18n();
  const [host, setHost] = useState('');
  const [internal, setInternal] = useState(false);

  return (
    <Panel>
      <PanelHeader title={t('apiTools.outboundTitle')} />
      <div className="space-y-2 p-4 text-sm">
        <Field label={t('apiTools.policyLabel')}>
          <Select
            value={outbound ?? 'open'}
            onValueChange={(v) => {
              const next = v === 'restricted' ? 'restricted' : 'open';
              onOutboundChange(next);
              onOutboundSave(next);
            }}
          >
            <SelectTrigger className="w-full" aria-label={t('apiTools.policyLabel')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="open">{t('apiTools.policyOpen')}</SelectItem>
              <SelectItem value="restricted">{t('apiTools.policyRestricted')}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <p className="text-muted-foreground text-xs">
          {outbound === 'restricted' ? t('apiTools.allowlistHint') : t('apiTools.policyOpenHint')}
        </p>
        <div className="flex flex-wrap gap-1">
          {entries.length === 0 ? (
            <span className="text-muted-foreground text-xs">{t('apiTools.allowlistEmpty')}</span>
          ) : (
            entries.map((e) => (
              <Well key={e.host} variant="chip" copy={e.host}>
                {e.host}
                {e.internal === true ? ' · internal' : ''}
              </Well>
            ))
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="api.example.com"
            spellCheck={false}
            autoComplete="off"
            className="w-56 font-mono text-xs"
          />
          <label className="flex items-center gap-1 text-xs">
            <Checkbox checked={internal} onCheckedChange={(v) => setInternal(v === true)} />
            {t('apiTools.allowlistInternal')}
          </label>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              if (host.trim() === '') return;
              onChange([
                ...entries.filter((x) => x.host !== host.trim()),
                { host: host.trim(), ...(internal ? { internal: true } : {}) },
              ]);
              setHost('');
              setInternal(false);
            }}
          >
            {t('apiTools.allowlistAdd')}
          </Button>
          <Button size="sm" onClick={onSave}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </Panel>
  );
}

// ---- detail (read-only, human-readable) ----

function ServiceDetailDialog({
  service,
  onClose,
}: {
  service: ApiToolServiceView;
  onClose: () => void;
}): React.ReactNode {
  const { t } = useI18n();
  const b = service.bundle;
  const headerNames = Object.keys(b.headers ?? {});
  return (
    <FormDialog
      open
      onClose={onClose}
      size="xl"
      title={t('apiTools.detailTitle', { name: b.name })}
    >
      <div className="flex flex-col gap-4">
        <div className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <DetailLine label={t('apiTools.colBaseUrl')}>
            <Well variant="chip" copy={b.baseUrl}>
              {b.baseUrl}
            </Well>
          </DetailLine>
          <DetailLine label={t('common.scope')}>
            <ScopeBadge scope={service.scope} />
          </DetailLine>
          <DetailLine label={t('apiTools.authLabel')}>
            {b.auth === undefined ? (
              <span className="text-muted-foreground text-xs">{t('apiTools.authNone')}</span>
            ) : (
              <span className="font-mono text-xs">
                {b.auth.style === 'bearer'
                  ? `Bearer · ${b.auth.credentialName}`
                  : `${b.auth.header} · ${b.auth.credentialName}`}
              </span>
            )}
          </DetailLine>
          {headerNames.length > 0 ? (
            <DetailLine label={t('apiTools.headersLabel')}>
              <span className="font-mono text-xs">{headerNames.join(', ')}</span>
            </DetailLine>
          ) : null}
        </div>

        {b.tools.map((tool) => (
          <div key={tool.name} className="rounded-lg border p-3">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-mono text-xs font-medium">
                <Badge variant="secondary" className="role-data-sm mr-2">
                  {tool.method}
                </Badge>
                {tool.path}
              </span>
              <span className="text-muted-foreground font-mono text-xs">{tool.name}</span>
            </div>
            <p className="text-muted-foreground mt-1 text-xs">
              {tool.description ?? t('apiTools.toolNoDesc')}
            </p>
            {tool.params.length > 0 ? (
              <Table className="mt-2">
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('apiTools.paramColumn')}</TableHead>
                    <TableHead>{t('apiTools.inColumn')}</TableHead>
                    <TableHead>{t('apiTools.typeColumn')}</TableHead>
                    <TableHead>{t('apiTools.requiredColumn')}</TableHead>
                    <TableHead>{t('apiTools.descColumn')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {tool.params.map((p) => (
                    <TableRow key={p.name}>
                      <TableCell className="font-mono text-xs">{p.name}</TableCell>
                      <TableCell className="font-mono text-xs">{p.in}</TableCell>
                      <TableCell className="font-mono text-xs">{p.type}</TableCell>
                      <TableCell className="text-xs">
                        {p.required ? t('apiTools.requiredYes') : t('apiTools.requiredNo')}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-xs">
                        {p.description ?? '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : null}
            <div className="text-muted-foreground role-data-sm mt-2 flex flex-wrap gap-x-4 gap-y-1">
              {tool.bodyType !== undefined ? <span>bodyType: {tool.bodyType}</span> : null}
              {tool.timeoutMs !== undefined ? <span>timeoutMs: {tool.timeoutMs}</span> : null}
              {tool.maxResultChars !== undefined ? (
                <span>maxResultChars: {tool.maxResultChars}</span>
              ) : null}
              {tool.treatBodyOnNon2xx === true ? <span>treatBodyOnNon2xx</span> : null}
            </div>
            <p className="text-muted-foreground mt-1 text-xs">
              <span className="font-medium">{t('apiTools.envelopeLabel')}: </span>
              {tool.envelope === undefined ? (
                t('apiTools.envelopeNone')
              ) : (
                <span className="font-mono text-xs">
                  {[
                    tool.envelope.codeField !== undefined
                      ? `code=${tool.envelope.codeField}`
                      : null,
                    `success=${tool.envelope.success.join(' | ')}`,
                    tool.envelope.payloadField !== undefined
                      ? `payload=${tool.envelope.payloadField}`
                      : null,
                    tool.envelope.errorFields !== undefined
                      ? `errors=${tool.envelope.errorFields.join(' | ')}`
                      : null,
                  ]
                    .filter((x) => x !== null)
                    .join(' · ')}
                </span>
              )}
            </p>
          </div>
        ))}
      </div>
    </FormDialog>
  );
}

function DetailLine({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.ReactNode {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-muted-foreground shrink-0 text-xs">{label}</span>
      <span className="min-w-0 truncate">{children}</span>
    </div>
  );
}

// ---- probe (parameter form generated from the tool definition) ----

function ProbeDialog({
  service,
  onClose,
}: {
  service: ApiToolServiceView;
  onClose: () => void;
}): React.ReactNode {
  const { t } = useI18n();
  const { logout } = useAuth();
  const [toolName, setToolName] = useState(service.bundle.tools[0]?.name ?? '');
  const tool = useMemo(
    () => service.bundle.tools.find((x) => x.name === toolName),
    [service.bundle.tools, toolName],
  );
  // string params ride text inputs, booleans ride checkboxes.
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [result, setResult] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    setValues({});
    setResult(null);
  }, [toolName]);

  const run = async (): Promise<void> => {
    if (tool === undefined) return;
    const args: Record<string, unknown> = {};
    const missing: string[] = [];
    for (const p of tool.params) {
      const raw = values[p.name];
      if (p.type === 'boolean') {
        args[p.name] = raw === true;
        continue;
      }
      const s = typeof raw === 'string' ? raw.trim() : '';
      if (s === '') {
        if (p.required) missing.push(p.name);
        continue;
      }
      if (p.type === 'number') {
        const n = Number(s);
        if (Number.isNaN(n)) {
          toast.error(t('apiTools.probeNotNumber', { name: p.name }));
          return;
        }
        args[p.name] = n;
      } else {
        args[p.name] = s;
      }
    }
    if (missing.length > 0) {
      toast.error(t('apiTools.probeMissing', { names: missing.join(', ') }));
      return;
    }
    setRunning(true);
    setResult(t('apiTools.probeRunning'));
    try {
      const res = await withAuthGuard(
        () => api.probeApiToolService(service.id, toolName, args),
        logout,
      );
      setResult(res.result.output);
    } catch (e) {
      setResult(errText(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('apiTools.probeTitle', { name: service.bundle.name })}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
        className="flex flex-col gap-4"
      >
        <Field label={t('apiTools.probeTool')}>
          <Select value={toolName} onValueChange={setToolName}>
            <SelectTrigger className="w-full" aria-label={t('apiTools.probeTool')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {service.bundle.tools.map((x) => (
                <SelectItem key={x.name} value={x.name}>
                  {x.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {tool !== undefined && tool.description !== undefined ? (
          <p className="text-muted-foreground text-xs">{tool.description}</p>
        ) : null}
        {tool === undefined || tool.params.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t('apiTools.probeNoParams')}</p>
        ) : (
          tool.params.map((p) => (
            <Field
              key={p.name}
              label={p.name}
              required={p.required}
              hint={
                p.description ??
                `${p.in} · ${p.type}${p.required ? '' : ` · ${t('apiTools.requiredNo')}`}`
              }
            >
              {p.type === 'boolean' ? (
                <Checkbox
                  checked={values[p.name] === true}
                  onCheckedChange={(v) => setValues((prev) => ({ ...prev, [p.name]: v === true }))}
                  aria-label={p.name}
                  className="mt-1"
                />
              ) : (
                <Input
                  type={p.type === 'number' ? 'number' : 'text'}
                  value={typeof values[p.name] === 'string' ? (values[p.name] as string) : ''}
                  onChange={(e) => setValues((prev) => ({ ...prev, [p.name]: e.target.value }))}
                  inputMode={p.type === 'number' ? 'decimal' : 'text'}
                  spellCheck={false}
                  autoComplete="off"
                  className="font-mono text-xs"
                />
              )}
            </Field>
          ))
        )}
        {result !== null ? (
          <pre className="bg-muted/50 max-h-72 overflow-auto rounded-md border p-3 font-mono text-xs whitespace-pre-wrap">
            {result}
          </pre>
        ) : null}
        <Button type="submit" disabled={running}>
          {t('apiTools.probeRun')}
        </Button>
      </form>
    </FormDialog>
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
