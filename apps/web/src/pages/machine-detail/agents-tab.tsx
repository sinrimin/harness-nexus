// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useEffect, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { FileCogIcon, LaptopIcon, PlusIcon, XIcon } from 'lucide-react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n, dateLocale, type TranslationKey } from '@/i18n';
import { cn } from '@/lib/utils';
import {
  HarnessNexusError,
  PREWARM_ADAPTER_TARGETS,
  PROVIDER_API_SUPPORT,
  RUNTIME_API_SUPPORT,
  DEFAULT_CHAT_PREWARM_SETTINGS,
  providerApiToSpecApi,
  setClaudeOneMarker,
  stripClaudeOneMarker,
  type ChatPrewarmSettings,
  type CredentialView,
  type LlmProviderView,
  type MachineView,
  type RuntimeConfigSpec,
  type RuntimeTarget,
} from '@harness-nexus/sdk';
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
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from '@/components/ui/drawer';
import { ConfirmDialog, EmptyState, Panel, PanelBody, PanelHeader, Well } from '@/components/kit';
import {
  ClaudeCodePanel,
  ccDraftFromSpec,
  ccIssue,
  emptyCcDraft,
  serializeCcDraft,
  type CcDraft,
} from './claude-code-panel.js';
import {
  OpencodePanel,
  ocDraftFromSpec,
  ocIssue,
  emptyOcDraft,
  serializeOcDraft,
  type OcDraft,
} from './opencode-panel.js';
import {
  CodexPanel,
  cxDraftFromSpec,
  cxIssue,
  emptyCxDraft,
  serializeCxDraft,
  type CxDraft,
} from './codex-panel.js';
import {
  DeepseekPanel,
  dsDraftFromSpec,
  dsIssue,
  emptyDsDraft,
  serializeDsDraft,
  type DsDraft,
} from './deepseek-panel.js';
import {
  PiPanel,
  piDraftFromSpec,
  piIssue,
  emptyPiDraft,
  serializePiDraft,
  type PiDraft,
} from './pi-panel.js';
import type { InventoryEntry, RuntimeInfoView } from './types.js';

/**
 * 代理 tab — the per-Agent RUNTIME management surface: probe status,
 * install/upgrade/pin, redacted config viewing, and the W3/W10 provider
 * route. Deliberately item-free: the scanned artifacts live in the 清单
 * tab; this pane answers "which Agents, which versions, which model route".
 */
export function AgentsTab({
  inventory,
  machineId,
  machine,
  onChanged,
}: {
  inventory: InventoryEntry[] | null;
  machineId: string;
  machine: MachineView | null;
  onChanged: () => void;
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
        <Panel>
          <EmptyState title={t('machineDetail.emptyInventory')} />
        </Panel>
      </>
    );
  }
  return (
    <>
      <div className="flex flex-col gap-6">
        {inventory.map((entry) => (
          <AgentRuntimeCard
            key={entry.target}
            entry={entry}
            machineId={machineId}
            machine={machine}
            onChanged={onChanged}
          />
        ))}
      </div>
    </>
  );
}

/** One runtime-managed Agent: status line + manage controls + provider form. */
function AgentRuntimeCard({
  entry,
  machineId,
  machine,
  onChanged,
}: {
  entry: InventoryEntry;
  machineId: string;
  machine: MachineView | null;
  onChanged: () => void;
}) {
  const { t, lang } = useI18n();
  const agent = entry.agents[0];
  const items = entry.agents.flatMap((a) => a.items);
  const notInstalled = entry.runtime !== null && !entry.runtime.installed;
  return (
    <>
      {/* One panel per Agent: the nameplate carries the identity (target in
          mono — never the label role, which uppercases) plus the runtime
          verdict; the body is the pre-warm switch and the provider route. */}
      <Panel>
        <PanelHeader
          icon={<LaptopIcon />}
          meta={
            <>
              {notInstalled ? `${t('machineDetail.runtimeNotInstalled')} · ` : ''}
              {t('machineDetail.itemsReported', {
                count: items.length,
                time: new Date(entry.reportedAt).toLocaleString(dateLocale(lang)),
              })}
            </>
          }
          actions={
            <>
              <RuntimeStatus runtime={entry.runtime} />
              <ViewConfigButton
                machineId={machineId}
                target={entry.target}
                runtime={entry.runtime}
              />
              <RuntimeManage machineId={machineId} target={entry.target} runtime={entry.runtime} />
            </>
          }
        >
          <span className="role-data text-foreground truncate">{entry.target}</span>
          {agent?.profileApplied ? (
            <Badge variant="secondary" className="text-[10px]">
              {t('machineDetail.profileApplied')}
            </Badge>
          ) : null}
        </PanelHeader>
        <PanelBody variant="flush">
          <PrewarmToggle
            machineId={machineId}
            target={entry.target}
            machine={machine}
            onChanged={onChanged}
          />
          <ProviderConfigForm
            machineId={machineId}
            target={entry.target}
            runtime={entry.runtime}
            // #60 — the claude-code panel owns every model-shaped and
            // behavior-shaped control for that target; the #49 default
            // permission mode rides along as its behavior section's slot.
            defaultModeSlot={
              entry.target === 'claude-code' ? (
                <DefaultModeSelect machineId={machineId} machine={machine} onChanged={onChanged} />
              ) : undefined
            }
          />
        </PanelBody>
      </Panel>
    </>
  );
}

/**
 * Issue #3 — this Agent's pre-warm switch (machine-scoped: one idle adapter
 * process per target lives on THIS machine while a chat session page is
 * open). Rendered only for pool-served targets; pi/opencode cards stay plain.
 */
function PrewarmToggle({
  machineId,
  target,
  machine,
  onChanged,
}: {
  machineId: string;
  /** Inventory target label — only the PREWARM targets render this row. */
  target: string;
  machine: MachineView | null;
  onChanged: () => void;
}) {
  const { logout } = useAuth();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  if (!(PREWARM_ADAPTER_TARGETS as readonly string[]).includes(target)) return null;
  const prewarm = machine?.chatPrewarm ?? DEFAULT_CHAT_PREWARM_SETTINGS;
  const checked = prewarm[target as keyof ChatPrewarmSettings] === true;

  async function toggle(next: boolean): Promise<void> {
    if (machine === null || busy) return;
    // Normalize against the defaults: a row stored before #4 carries only
    // three keys, and the PATCH schema is strict replace-semantics.
    const previous = { ...DEFAULT_CHAT_PREWARM_SETTINGS, ...machine.chatPrewarm };
    setBusy(true);
    try {
      await withAuthGuard(
        () =>
          api.updateMachine(machineId, {
            chatPrewarm: {
              ...previous,
              [target as keyof ChatPrewarmSettings]: next,
            },
          }),
        logout,
      );
      onChanged();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.updateFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    // Same section idiom as the provider block below (title + muted desc,
    // px-6, no box): the card reads [prewarm row] ─ hairline ─ [provider],
    // not a stuck-on patch. The form's own border-t is the divider.
    <div className="flex items-center justify-between gap-4 px-6 pb-4 pt-1">
      <div>
        <p className="text-sm font-medium">{t('machineDetail.prewarm')}</p>
        <p className="text-muted-foreground text-xs">{t('machineDetail.prewarmDesc')}</p>
      </div>
      <Switch
        id={`prewarm-${target}`}
        aria-label={t('machineDetail.prewarm')}
        checked={checked}
        disabled={busy || machine === null}
        onCheckedChange={(v) => void toggle(v)}
      />
    </div>
  );
}

/**
 * Issue #49 — this Agent's DEFAULT chat permission mode (machine-scoped;
 * claude-code only — the only adapter whose ACP wrapper advertises permission
 * modes, and it always resolves an explicit one itself, so the platform
 * supplies the initial mode). Applied once at session establishment; the W9
 * mode dropdown remains the mid-session switch. Option names stay English —
 * they are the adapter's own wire names (same as the W9 dropdown).
 */
function DefaultModeSelect({
  machineId,
  machine,
  onChanged,
}: {
  machineId: string;
  machine: MachineView | null;
  onChanged: () => void;
}) {
  const { logout } = useAuth();
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const current = machine?.chatDefaultMode?.['claude-code'] ?? null;

  async function apply(next: string): Promise<void> {
    if (machine === null || busy) return;
    setBusy(true);
    try {
      await withAuthGuard(
        () =>
          api.updateMachine(machineId, {
            chatDefaultMode: { 'claude-code': next === 'none' ? null : next },
          }),
        logout,
      );
      onChanged();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.updateFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    // Rendered INSIDE the claude-code panel's behavior section (#60) — the
    // same three-line field idiom as 默认模型 above: label / select / hint.
    <div className="grid gap-2 pt-1">
      <Label htmlFor="default-mode">{t('machineDetail.defaultMode')}</Label>
      <Select
        value={current ?? 'none'}
        onValueChange={(v) => void apply(v)}
        disabled={busy || machine === null}
      >
        <SelectTrigger
          id="default-mode"
          aria-label={t('machineDetail.defaultMode')}
          className="w-full"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">{t('machineDetail.defaultModeNone')}</SelectItem>
          <SelectItem value="default">Manual</SelectItem>
          <SelectItem value="acceptEdits">Accept edits</SelectItem>
          <SelectItem value="plan">Plan</SelectItem>
          <SelectItem value="auto">Auto</SelectItem>
        </SelectContent>
      </Select>
      <p className="text-muted-foreground text-xs">{t('machineDetail.defaultModeDesc')}</p>
    </div>
  );
}

/** The Agent's runtime status line: version (mono) + method badge, or muted absence. */
function RuntimeStatus({ runtime }: { runtime: RuntimeInfoView | null }) {
  const { t } = useI18n();
  if (runtime === null) {
    return (
      <>
        <span className="text-muted-foreground text-xs">{t('machineDetail.runtimeNotProbed')}</span>
      </>
    );
  }
  if (!runtime.installed) {
    return (
      <>
        <span className="text-muted-foreground text-sm">
          {t('machineDetail.runtimeNotInstalled')}
        </span>
      </>
    );
  }
  return (
    <>
      <span className="flex flex-wrap items-center gap-2">
        {runtime.version ? (
          <span className="font-mono text-xs tabular-nums">{runtime.version}</span>
        ) : null}
        {runtime.installMethod ? (
          <Badge variant="outline" className="font-mono text-[10px]">
            {runtime.installMethod}
          </Badge>
        ) : null}
        {runtime.binPath ? (
          <span className="text-muted-foreground font-mono text-xs">{runtime.binPath}</span>
        ) : null}
      </span>
    </>
  );
}

/**
 * Install / Upgrade / pin control for a runtime-managed Agent (Phase 9 W2) —
 * confirm-first; an optional version turns the action into a pin/install-at.
 * Renders nothing when the daemon doesn't probe runtimes (hermes, old hnx).
 */
/** The three actions this control can take, as title/consequence key pairs
 *  resolved at render (module scope holds keys, never `t()`). */
const MANAGE_KEYS = {
  install: {
    action: 'machineDetail.manageActionInstall',
    consequence: 'machineDetail.manageConsequenceInstall',
  },
  upgrade: {
    action: 'machineDetail.manageActionUpgrade',
    consequence: 'machineDetail.manageConsequenceUpgrade',
  },
  pin: {
    action: 'machineDetail.manageActionPin',
    consequence: 'machineDetail.manageConsequencePin',
  },
} as const satisfies Record<string, { action: TranslationKey; consequence: TranslationKey }>;

type ManageAction = keyof typeof MANAGE_KEYS;

function RuntimeManage({
  machineId,
  target,
  runtime,
}: {
  machineId: string;
  target: string;
  runtime: RuntimeInfoView | null;
}) {
  const { logout } = useAuth();
  const { t } = useI18n();
  const [version, setVersion] = useState('');
  const [busy, setBusy] = useState(false);
  // P6 — the action is chosen first (typed version → pin), confirmed in a
  // designed dialog, and only then queued.
  const [pending, setPending] = useState<ManageAction | null>(null);
  if (runtime === null) return null;
  const installed = runtime.installed;
  const trimmed = version.trim();
  const params = { target, version: trimmed };

  async function run(): Promise<void> {
    const action = pending;
    if (action === null) return;
    setPending(null);
    setBusy(true);
    try {
      await withAuthGuard(
        () =>
          api.createHarnessJob(machineId, {
            action,
            target: target as Parameters<typeof api.createHarnessJob>[1]['target'],
            ...(action === 'pin' ? { version: trimmed } : {}),
          }),
        logout,
      );
      toast.success(t('machineDetail.manageToast'));
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('machineDetail.manageFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <span className="flex items-center gap-2">
        <Input
          aria-label={t('machineDetail.versionPlaceholder')}
          value={version}
          onChange={(e) => setVersion(e.target.value)}
          placeholder={t('machineDetail.versionPlaceholder')}
          className="h-(--control-h-sm) w-36 font-mono text-xs"
          autoComplete="off"
          spellCheck={false}
        />
        <Button
          size="sm"
          onClick={() => setPending(trimmed !== '' ? 'pin' : installed ? 'upgrade' : 'install')}
          disabled={busy}
        >
          {busy
            ? t('machineDetail.managing')
            : installed
              ? t('machineDetail.upgradeButton')
              : t('machineDetail.installButton')}
        </Button>
      </span>

      {pending !== null ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) setPending(null);
          }}
          title={t(MANAGE_KEYS[pending].action)}
          consequence={t(MANAGE_KEYS[pending].consequence, params)}
          impact={[
            { label: 'target', value: target },
            ...(pending === 'pin' ? [{ label: 'version', value: trimmed }] : []),
          ]}
          actionLabel={t(MANAGE_KEYS[pending].action)}
          // A harness job is re-runnable and a version can be pinned back, so
          // this is the ordinary tier — no danger edge, no irreversible claim.
          tone="default"
          irreversible={false}
          busy={busy}
          onConfirm={() => void run()}
        />
      ) : null}
    </>
  );
}

/**
 * Redacted effective-config viewer (Phase 9 W4) — a live round-trip to the
 * daemon; the drawer shows display-pathed files whose secret-ish values were
 * masked daemon-side before upload. `--signal` is not spent (data, not
 * liveness); masked values render as the literal `${redacted}`.
 */
function ViewConfigButton({
  machineId,
  target,
  runtime,
}: {
  machineId: string;
  target: string;
  runtime: RuntimeInfoView | null;
}) {
  const { logout } = useAuth();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<{
    files: { path: string; content: string }[];
    redacted: string[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (runtime === null) return null;

  async function load(): Promise<void> {
    setView(null);
    setError(null);
    try {
      const res = await withAuthGuard(
        () => api.getRuntimeConfigView(machineId, target as RuntimeTarget),
        logout,
      );
      setView({ files: res.files, redacted: res.redacted });
    } catch (e) {
      setError(e instanceof HarnessNexusError ? e.message : t('machineDetail.viewFailed'));
    }
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setOpen(true);
          void load();
        }}
      >
        <FileCogIcon className="size-4" />
        {t('machineDetail.viewConfigButton')}
      </Button>
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerContent>
          <DrawerHeader>
            <DrawerTitle className="font-mono">
              {t('machineDetail.viewConfigTitle', { target })}
            </DrawerTitle>
            <DrawerDescription>{t('machineDetail.viewConfigDesc')}</DrawerDescription>
          </DrawerHeader>
          <DrawerBody className="flex flex-col gap-4">
            {error !== null ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : view === null ? (
              <p className="text-muted-foreground py-8 text-center text-sm">
                {t('machineDetail.viewLoading')}
              </p>
            ) : (
              <>
                {view.redacted.length > 0 ? (
                  <p className="text-muted-foreground text-xs">
                    {t('machineDetail.viewRedacted', { count: view.redacted.length })}
                  </p>
                ) : null}
                {view.files.length === 0 ? (
                  <p className="text-muted-foreground py-8 text-center text-sm">
                    {t('machineDetail.viewNoFiles')}
                  </p>
                ) : (
                  view.files.map((f) => (
                    <div key={f.path} className="flex flex-col gap-1.5">
                      <p className="text-muted-foreground font-mono text-xs">{f.path}</p>
                      <pre className="bg-muted overflow-x-auto rounded-md p-3 font-mono text-xs whitespace-pre-wrap">
                        {f.content}
                      </pre>
                    </div>
                  ))
                )}
              </>
            )}
          </DrawerBody>
        </DrawerContent>
      </Drawer>
    </>
  );
}

/**
 * Provider config sub-form (Phase 9 W3 + W10 provider-first flow) — the
 * Agent's LLM route, applied into the harness's NATIVE config by an
 * `apply-config` job (confirm-first: the write ships the credential's
 * plaintext to the machine). W10: pick a stored LlmProvider (filtered to the
 * APIs this Agent speaks) and choose the model FROM the provider's curated
 * registry (#51) — no live discovery here anymore. A provider without chat
 * models and the manual arm keep free-text model inputs, so the form is
 * never a dead end. Renders nothing for targets the daemon doesn't
 * runtime-manage.
 */
const MANUAL_PROVIDER = '__manual__';

/**
 * A read-only fact cell shaped exactly like the editable cells around it —
 * label on top, a control-height body — so the preset-provider summary (api /
 * base URL / credential) aligns row-for-row with the manual arm and the other
 * form cells.
 *
 * The body is the kit's `Well`, not a hand-rolled box: these are protocol
 * values (a base URL, an api flavour, a credential NAME), i.e. exactly what the
 * well material exists for, and a hand-rolled `bg-muted/50` fixed-height box
 * was unreachable for skins — BAY painted its LCD inputs dark and left these
 * three light, with a 36px body next to 30px controls (reported from a phone,
 * P8). Height comes from the density token now.
 */
function ReadonlyField({
  label,
  title,
  className,
  children,
}: {
  label: string;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  const value = typeof children === 'string' ? children : undefined;
  return (
    <div className={cn('grid min-w-0 gap-2', className)}>
      <span className="text-sm leading-none font-medium select-none">{label}</span>
      <Well
        variant="text"
        copy={value}
        title={title}
        className="flex h-(--control-h) w-full items-center px-2.5"
      >
        <span className="truncate font-mono text-xs">{children}</span>
      </Well>
    </div>
  );
}

function ProviderConfigForm({
  machineId,
  target,
  runtime,
  defaultModeSlot,
}: {
  machineId: string;
  target: string;
  runtime: RuntimeInfoView | null;
  defaultModeSlot?: ReactNode;
}) {
  const { logout } = useAuth();
  const { t } = useI18n();
  const [providers, setProviders] = useState<LlmProviderView[] | null>(null);
  const [creds, setCreds] = useState<CredentialView[] | null>(null);
  const [providerId, setProviderId] = useState<string>(''); // '' | id | MANUAL_PROVIDER
  const [providerGone, setProviderGone] = useState(false);
  const [providerLabel, setProviderLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiFlavor, setApiFlavor] = useState<string>('');
  const [credentialName, setCredentialName] = useState('');
  const [extraModels, setExtraModels] = useState<string[]>([]);
  // #60 — claude-code's dedicated panel knobs (draft shape; serialized at apply).
  const [cc, setCc] = useState<CcDraft>(emptyCcDraft);
  // #62 — opencode's dedicated panel knobs.
  const [oc, setOc] = useState<OcDraft>(emptyOcDraft);
  // #63 — codex's dedicated panel knobs.
  const [cx, setCx] = useState<CxDraft>(emptyCxDraft);
  // #64 — dsh's dedicated panel knobs.
  const [ds, setDs] = useState<DsDraft>(emptyDsDraft);
  // #65 — pi's dedicated panel knobs.
  const [pi, setPi] = useState<PiDraft>(emptyPiDraft);
  const [busy, setBusy] = useState(false);
  // P6 — Apply config confirms first (the credential goes to the machine).
  const [asking, setAsking] = useState(false);

  const managedTarget = runtime !== null ? (target as RuntimeTarget) : null;
  const apiOptions = managedTarget !== null ? RUNTIME_API_SUPPORT[managedTarget] : [];
  const supportedKinds = managedTarget !== null ? PROVIDER_API_SUPPORT[managedTarget] : [];
  const usableProviders = (providers ?? []).filter((p) => supportedKinds.includes(p.api));
  const selectedProvider = usableProviders.find((p) => p.id === providerId) ?? null;
  const manual = selectedProvider === null;
  // #51 — the registry is the picker's world: only chat rows are selectable.
  // A provider with no chat models (and the manual arm) falls back to
  // free-text model inputs below.
  const chatModels =
    selectedProvider !== null ? selectedProvider.models.filter((m) => m.type === 'chat') : [];
  const useModelSelect = selectedProvider !== null && chatModels.length > 0;

  // Prefill: a stored providerId that still resolves selects that provider;
  // otherwise (no provider, or it was deleted) the manual arm carries the
  // stored spec fields.
  useEffect(() => {
    if (managedTarget === null) return;
    let cancelled = false;
    void (async () => {
      let existing: RuntimeConfigSpec | null = null;
      try {
        existing = await withAuthGuard(
          () => api.getRuntimeConfig(machineId, managedTarget),
          logout,
        );
      } catch {
        existing = null; // 404 (nothing stored yet) or transient — empty form
      }
      let allProviders: LlmProviderView[] = [];
      try {
        allProviders = await withAuthGuard(() => api.listLlmProviders(), logout);
      } catch {
        allProviders = [];
      }
      let distributable: CredentialView[] = [];
      try {
        distributable = (await withAuthGuard(() => api.listCredentials(), logout)).filter(
          (c) => c.distributable,
        );
      } catch {
        distributable = [];
      }
      if (cancelled) return;
      setProviders(allProviders);
      setCreds(distributable);
      const kinds = PROVIDER_API_SUPPORT[managedTarget];
      const match =
        existing?.providerId !== undefined
          ? allProviders.find((p) => p.id === existing?.providerId && kinds.includes(p.api))
          : undefined;
      setProviderGone(existing?.providerId !== undefined && match === undefined);
      setProviderId(match?.id ?? MANUAL_PROVIDER);
      setProviderLabel(existing?.providerLabel ?? '');
      setBaseUrl(existing?.baseUrl ?? '');
      // #60 — the `[1m]` marker never rides the model STATE: prefill strips it
      // into the panel's oneM checkbox, apply re-appends it (ccDraftFromSpec
      // read the same spec, so the two agree).
      setModel(existing?.model !== undefined ? stripClaudeOneMarker(existing.model) : '');
      setApiFlavor(existing?.api ?? apiOptions[0] ?? '');
      setCredentialName(existing?.credentialName ?? '');
      setExtraModels(
        (existing?.models ?? []).filter(
          (m) => m !== existing?.model && m !== stripClaudeOneMarker(existing?.model ?? ''),
        ),
      );
      setCc(ccDraftFromSpec(existing));
      setOc(ocDraftFromSpec(existing));
      setCx(cxDraftFromSpec(existing));
      setDs(dsDraftFromSpec(existing));
      setPi(piDraftFromSpec(existing));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machineId, managedTarget]);

  if (managedTarget === null) return null;

  /** The spec's effective base URL: the provider's, or the supplemental/manual input. */
  const effectiveBaseUrl =
    selectedProvider !== null ? (selectedProvider.baseUrl ?? baseUrl.trim()) : baseUrl.trim();
  /** The credential that will be written — worth naming in the confirm dialog. */
  const effectiveCredential = selectedProvider?.credentialName ?? credentialName;

  async function apply(): Promise<void> {
    setBusy(true);
    try {
      // Row inputs are free-typed: normalize before sending (trim, drop
      // empties and the default, dedupe — the PUT would reject them). The
      // claude-code 1M checkbox may have put a `[1m]` marker on the default
      // model — rows dedupe against BOTH spellings (#60).
      const wireModel = setClaudeOneMarker(model.trim(), cc.oneM);
      const baseModel = stripClaudeOneMarker(model.trim());
      const normalizedExtras = [
        ...new Set(
          extraModels
            .map((m) => m.trim())
            .filter((m) => m !== '' && m !== baseModel && m !== wireModel),
        ),
      ];
      // #60/#62/#63/#64 — each panel serializes to undefined when everything
      // is default, keeping untouched specs byte-identical to their old shape.
      const claudeCode = serializeCcDraft(cc);
      const opencode = serializeOcDraft(oc, [
        ...new Set([model, ...extraModels].map((x) => x.trim()).filter((x) => x !== '')),
      ]);
      const codex = serializeCxDraft(cx);
      const deepseek = serializeDsDraft(ds, [
        ...new Set([model, ...extraModels].map((x) => x.trim()).filter((x) => x !== '')),
      ]);
      const piCfg = serializePiDraft(pi, [
        ...new Set([model, ...extraModels].map((x) => x.trim()).filter((x) => x !== '')),
      ]);
      const spec: RuntimeConfigSpec = {
        providerLabel: (selectedProvider?.name ?? providerLabel).trim(),
        api: (selectedProvider !== null
          ? providerApiToSpecApi(selectedProvider.api)
          : apiFlavor || apiOptions[0]) as RuntimeConfigSpec['api'],
        model: wireModel,
        credentialName: selectedProvider?.credentialName ?? credentialName,
        ...(selectedProvider !== null ? { providerId: selectedProvider.id } : {}),
        ...(normalizedExtras.length > 0 ? { models: normalizedExtras } : {}),
        ...(effectiveBaseUrl !== '' ? { baseUrl: effectiveBaseUrl } : {}),
        ...(claudeCode !== undefined ? { claudeCode } : {}),
        ...(opencode !== undefined ? { opencode } : {}),
        ...(codex !== undefined ? { codex } : {}),
        ...(deepseek !== undefined ? { deepseek } : {}),
        ...(piCfg !== undefined ? { pi: piCfg } : {}),
      };
      await withAuthGuard(() => api.putRuntimeConfig(machineId, managedTarget!, spec), logout);
      toast.success(t('machineDetail.applyToast'));
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('machineDetail.applyFailed'));
    } finally {
      setBusy(false);
    }
  }

  const ready =
    model.trim() !== '' &&
    !busy &&
    ccIssue(cc) === null &&
    ocIssue(oc, [
      ...new Set([model, ...extraModels].map((x) => x.trim()).filter((x) => x !== '')),
    ]) === null &&
    cxIssue(cx) === null &&
    dsIssue(ds, [
      ...new Set([model, ...extraModels].map((x) => x.trim()).filter((x) => x !== '')),
    ]) === null &&
    piIssue(pi, [
      ...new Set([model, ...extraModels].map((x) => x.trim()).filter((x) => x !== '')),
    ]) === null &&
    (selectedProvider !== null || (providerLabel.trim() !== '' && credentialName !== ''));

  const needBaseUrlNote = selectedProvider !== null && selectedProvider.baseUrl === null;

  return (
    <>
      <div className="flex flex-col gap-3 border-t px-6 pt-4 pb-4">
        <div>
          <p className="text-sm font-medium">{t('machineDetail.providerTitle')}</p>
          <p className="text-muted-foreground text-xs">{t('machineDetail.providerDesc')}</p>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:flex sm:flex-wrap sm:items-end">
          <div className="grid min-w-52 gap-2">
            <Label htmlFor={`pc-provider-${target}`}>{t('machineDetail.providerPickLabel')}</Label>
            <Select
              value={providerId}
              onValueChange={(v) => {
                setProviderId(v);
                // Registry cutover (#51): model/extras survive the switch only
                // when the new provider's registry still lists them; the
                // manual arm and a registry-less provider keep free-text values.
                const next = usableProviders.find((p) => p.id === v) ?? null;
                const ids = new Set(
                  next !== null
                    ? next.models.filter((m) => m.type === 'chat').map((m) => m.id)
                    : [],
                );
                if (ids.size === 0) return;
                setModel((prev) => (ids.has(prev.trim()) ? prev : ''));
                setExtraModels((prev) => prev.filter((x) => ids.has(x.trim())));
              }}
            >
              <SelectTrigger id={`pc-provider-${target}`} className="w-full">
                <SelectValue placeholder={t('machineDetail.pickProvider')} />
              </SelectTrigger>
              <SelectContent>
                {usableProviders.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}
                  </SelectItem>
                ))}
                <SelectItem value={MANUAL_PROVIDER}>{t('machineDetail.manualOption')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {selectedProvider !== null ? (
            <>
              {selectedProvider.baseUrl !== null ? (
                <ReadonlyField
                  label={t('machineDetail.baseUrlLabel')}
                  className="min-w-52 max-w-full"
                  title={selectedProvider.baseUrl}
                >
                  {selectedProvider.baseUrl}
                </ReadonlyField>
              ) : (
                <div className="grid min-w-52 gap-2">
                  <Label htmlFor={`pc-url2-${target}`}>{t('machineDetail.baseUrlLabel')}</Label>
                  <Input
                    id={`pc-url2-${target}`}
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    placeholder={t('machineDetail.baseUrlPlaceholder')}
                    className="font-mono text-xs"
                    autoComplete="off"
                    spellCheck={false}
                    inputMode="url"
                  />
                </div>
              )}
              <ReadonlyField label={t('machineDetail.apiLabel')} className="min-w-36">
                {selectedProvider.api}
              </ReadonlyField>
              <ReadonlyField
                label={t('machineDetail.credentialLabel')}
                className="min-w-44"
                title={selectedProvider.credentialName}
              >
                {selectedProvider.credentialName}
              </ReadonlyField>
            </>
          ) : null}

          {manual ? (
            <>
              <div className="grid min-w-44 gap-2">
                <Label htmlFor={`pc-label-${target}`}>
                  {t('machineDetail.providerLabelLabel')}
                </Label>
                <Input
                  id={`pc-label-${target}`}
                  value={providerLabel}
                  onChange={(e) => setProviderLabel(e.target.value)}
                  placeholder={t('machineDetail.providerLabelPlaceholder')}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="grid min-w-52 gap-2">
                <Label htmlFor={`pc-url-${target}`}>{t('machineDetail.baseUrlLabel')}</Label>
                <Input
                  id={`pc-url-${target}`}
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder={t('machineDetail.baseUrlPlaceholder')}
                  className="font-mono text-xs"
                  autoComplete="off"
                  spellCheck={false}
                  inputMode="url"
                />
              </div>
              {apiOptions.length > 1 ? (
                <div className="grid min-w-24 gap-2">
                  <Label htmlFor={`pc-api-${target}`}>{t('machineDetail.apiLabel')}</Label>
                  <Select value={apiFlavor} onValueChange={setApiFlavor}>
                    <SelectTrigger id={`pc-api-${target}`} className="font-mono text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {apiOptions.map((a) => (
                        <SelectItem key={a} value={a} className="font-mono text-xs">
                          {a}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                // Single-flavor target — same read-only control-height cell as
                // the preset arm, so the row heights match (was a badge).
                <ReadonlyField label={t('machineDetail.apiLabel')} className="min-w-36">
                  {apiOptions[0]}
                </ReadonlyField>
              )}
              <div className="grid min-w-44 gap-2">
                <Label htmlFor={`pc-cred-${target}`}>{t('machineDetail.credentialLabel')}</Label>
                <Select value={credentialName} onValueChange={setCredentialName}>
                  <SelectTrigger id={`pc-cred-${target}`} className="font-mono text-xs">
                    <SelectValue placeholder={t('machineDetail.pickCredential')} />
                  </SelectTrigger>
                  <SelectContent>
                    {(creds ?? []).map((c) => (
                      <SelectItem key={c.id} value={c.name} className="font-mono text-xs">
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          ) : null}

          {/* #60/#62/#63/#64/#65 — for claude-code, opencode, codex, deepseek
            and pi the default-model picker lives inside the dedicated panel
            (one surface per knob); other targets keep the generic grid. */}
          {managedTarget !== 'claude-code' &&
          managedTarget !== 'opencode' &&
          managedTarget !== 'codex' &&
          managedTarget !== 'deepseek' &&
          managedTarget !== 'pi' ? (
            <div className="grid min-w-44 gap-2">
              <Label htmlFor={`pc-model-${target}`}>{t('machineDetail.modelDefaultLabel')}</Label>
              {useModelSelect ? (
                <Select value={model} onValueChange={setModel}>
                  <SelectTrigger id={`pc-model-${target}`} className="font-mono text-xs">
                    <SelectValue placeholder={t('machineDetail.pickModel')} />
                  </SelectTrigger>
                  <SelectContent>
                    {/* A stored id that predates the registry stays visible and
                      submittable — the cutover never silently drops a working
                      route (registry-less rows are reset on provider CHANGE,
                      not on open). */}
                    {model.trim() !== '' && !chatModels.some((m) => m.id === model.trim()) ? (
                      <SelectItem value={model.trim()} className="font-mono text-xs">
                        {model.trim()}
                      </SelectItem>
                    ) : null}
                    {chatModels.map((m) => (
                      <SelectItem key={m.id} value={m.id} className="font-mono text-xs">
                        {m.displayName ?? m.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id={`pc-model-${target}`}
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="font-mono text-xs"
                  autoComplete="off"
                  spellCheck={false}
                />
              )}
            </div>
          ) : null}
          <Button
            onClick={() => setAsking(true)}
            disabled={!ready}
            className="w-full sm:w-auto [@media(pointer:coarse)]:h-11"
          >
            {busy ? t('machineDetail.applying') : t('machineDetail.applyButton')}
          </Button>
        </div>

        {needBaseUrlNote && managedTarget === 'deepseek' ? (
          <p className="text-warn text-xs">{t('machineDetail.baseUrlNeeded')}</p>
        ) : null}
        {selectedProvider !== null && chatModels.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t('machineDetail.noModelsOnProvider')}</p>
        ) : null}
        {providers !== null && usableProviders.length === 0 && manual ? (
          <p className="text-muted-foreground text-xs">{t('machineDetail.noProviders')}</p>
        ) : null}
        {providerGone ? (
          <p className="text-warn text-xs">{t('machineDetail.providerGone')}</p>
        ) : null}
        {manual && creds !== null && creds.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t('machineDetail.noCredentials')}</p>
        ) : null}

        {/* 9 W13 — cc-switch-style extra models. With a provider picked the
          rows pick from its registry, minus ids already used elsewhere (the
          row's own id stays selectable); a registry-less provider and the
          manual arm keep free-text rows. Any row can still be promoted to
          the default (the old default swaps into the rows). #60/#62/#63/#64/#65:
          for claude-code, opencode, codex, deepseek and pi these rows moved
          into the dedicated panel. */}
        {managedTarget !== 'claude-code' &&
        managedTarget !== 'opencode' &&
        managedTarget !== 'codex' &&
        managedTarget !== 'deepseek' &&
        managedTarget !== 'pi' ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="text-sm leading-none font-medium">
                {t('machineDetail.extraModelsTitle')}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs [@media(pointer:coarse)]:h-9"
                onClick={() => setExtraModels((prev) => [...prev, ''])}
              >
                <PlusIcon className="size-3.5" />
                {t('machineDetail.extraModelsAdd')}
              </Button>
            </div>
            {extraModels.map((m, i) => {
              const used = new Set(
                [model, ...extraModels.filter((_, j) => j !== i)]
                  .map((x) => x.trim())
                  .filter((x) => x !== ''),
              );
              const rowOptions = chatModels.filter((mm) => mm.id === m.trim() || !used.has(mm.id));
              return (
                <div key={i} className="flex max-w-2xl flex-wrap items-center gap-2">
                  {useModelSelect ? (
                    <Select
                      value={m}
                      onValueChange={(v) =>
                        setExtraModels((prev) => prev.map((x, j) => (j === i ? v : x)))
                      }
                    >
                      <SelectTrigger
                        aria-label={t('machineDetail.pickModel')}
                        className="min-w-0 flex-1 font-mono text-xs"
                      >
                        <SelectValue placeholder={t('machineDetail.pickModel')} />
                      </SelectTrigger>
                      <SelectContent>
                        {m.trim() !== '' && !chatModels.some((mm) => mm.id === m.trim()) ? (
                          <SelectItem value={m.trim()} className="font-mono text-xs">
                            {m.trim()}
                          </SelectItem>
                        ) : null}
                        {rowOptions.map((mm) => (
                          <SelectItem key={mm.id} value={mm.id} className="font-mono text-xs">
                            {mm.displayName ?? mm.id}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <Input
                      value={m}
                      onChange={(e) =>
                        setExtraModels((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))
                      }
                      placeholder={t('machineDetail.extraModelsPlaceholder')}
                      className="font-mono text-xs"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground h-(--control-h) shrink-0 px-2 text-xs hover:text-foreground"
                    disabled={m.trim() === '' || m.trim() === model.trim()}
                    onClick={() => {
                      const id = m.trim();
                      const old = model.trim();
                      setModel(id);
                      setExtraModels((prev) => {
                        const kept = prev.filter((_, j) => j !== i);
                        if (old !== '' && old !== id && !kept.some((x) => x.trim() === old)) {
                          kept.push(old);
                        }
                        return kept;
                      });
                    }}
                  >
                    {t('machineDetail.extraModelsMakeDefault')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground size-8 shrink-0 hover:text-danger"
                    onClick={() => setExtraModels((prev) => prev.filter((_, j) => j !== i))}
                    aria-label={t('machineDetail.extraModelsRemove', { model: m === '' ? '…' : m })}
                  >
                    <XIcon className="size-3.5" />
                  </Button>
                </div>
              );
            })}
            <p className="text-muted-foreground text-xs">{t('machineDetail.extraModelsHint')}</p>
          </div>
        ) : null}

        {/* #60 — claude-code's own knob panel: the agent's whole model +
          behavior surface (the provider row above keeps only the connection).
          The `[1m]` marker checkbox rides the draft, not the model string. */}
        {managedTarget === 'claude-code' ? (
          <ClaudeCodePanel
            draft={cc}
            onChange={setCc}
            defaultModel={model}
            onDefaultModelChange={setModel}
            extraModels={extraModels}
            onExtraModelsChange={setExtraModels}
            chatModels={chatModels}
            behaviorSlot={defaultModeSlot}
          />
        ) : null}
        {managedTarget === 'opencode' ? (
          <OpencodePanel
            draft={oc}
            onChange={setOc}
            defaultModel={model}
            onDefaultModelChange={setModel}
            extraModels={extraModels}
            onExtraModelsChange={setExtraModels}
            chatModels={chatModels}
          />
        ) : null}
        {/* #63 — codex's own knob panel (the provider row keeps the
          connection). */}
        {managedTarget === 'codex' ? (
          <CodexPanel
            draft={cx}
            onChange={setCx}
            defaultModel={model}
            onDefaultModelChange={setModel}
            extraModels={extraModels}
            onExtraModelsChange={setExtraModels}
            chatModels={chatModels}
          />
        ) : null}
        {/* #64 — dsh's own knob panel (the provider row keeps the
          connection). */}
        {managedTarget === 'deepseek' ? (
          <DeepseekPanel
            draft={ds}
            onChange={setDs}
            defaultModel={model}
            onDefaultModelChange={setModel}
            extraModels={extraModels}
            onExtraModelsChange={setExtraModels}
            chatModels={chatModels}
          />
        ) : null}
        {/* #65 — pi's own knob panel (the provider row keeps the
          connection). */}
        {managedTarget === 'pi' ? (
          <PiPanel
            draft={pi}
            onChange={setPi}
            defaultModel={model}
            onDefaultModelChange={setModel}
            extraModels={extraModels}
            onExtraModelsChange={setExtraModels}
            chatModels={chatModels}
          />
        ) : null}
      </div>

      {asking ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) setAsking(false);
          }}
          title={t('machineDetail.applyButton')}
          consequence={t('machineDetail.applyConsequence', { target })}
          impact={[
            { label: 'target', value: target },
            { label: 'credential', value: effectiveCredential },
            ...(model.trim() !== '' ? [{ label: 'model', value: model.trim() }] : []),
          ]}
          actionLabel={t('machineDetail.applyButton')}
          // The credential goes down to the machine in clear text — a danger
          // edge, but not the irreversible line: the writer is merge-preserving
          // and a re-apply restores any value (design 9 W3).
          tone="danger"
          irreversible={false}
          busy={busy}
          onConfirm={() => {
            setAsking(false);
            void apply();
          }}
        />
      ) : null}
    </>
  );
}
