import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  StoreIcon,
  SearchIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
  ExternalLinkIcon,
} from 'lucide-react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { StateSignal } from '@/components/state-signal';
import { DataTable, Note, PageIntro, tableState } from '@/components/kit';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  HarnessNexusError,
  marketplacePluginToResourceSource,
  skillMetaToResourceSource,
  resolveTrustTier,
  type AgentTarget,
  type MarketplacePlugin,
  type PluginResourceSource,
  type SkillMeta,
  type TrustTier,
} from '@harness-nexus/sdk';

type Scope = 'global' | 'personal';

const TARGETS: AgentTarget[] = ['claude-code', 'zcode', 'hermes', 'generic'];

/**
 * A unified row for the hub table. Both the browse path (MarketplacePlugin)
 * and the multi-source search path (SkillMeta) project into this shape so the
 * table renders one way. `pluginSource` is precomputed by the backend adapters
 * (or projected from a MarketplacePlugin here) — the save dialog stores it
 * verbatim.
 */
interface HubRow {
  key: string;
  name: string;
  description: string;
  /** Where this result came from: marketplace | github | well-known | url. */
  sourceKind: string;
  category?: string;
  homepage?: string;
  tier: TrustTier;
  /**
   * The `plugin`-source shape to store when the user hits "save". Null for
   * entries that have no faithful plugin-source representation (archive zips,
   * e.g. our own 3.5 emitter output) — those rows can't be saved as skills.
   */
  pluginSource: PluginResourceSource | null;
  /** True if the source has a pin (sha/version) — drives the warn callout. */
  hasPin: boolean;
}

/**
 * Skill hub (Phase 7.3 + 7.4) — browse a marketplace's catalog AND search
 * across multiple sources. When the search box is empty, the page browses the
 * selected marketplace (category filter). When the search box has text, it
 * dispatches a multi-source search (`/api/skills/search`) — marketplace +
 * github + well-known + url — and shows merged, deduped, trust-ranked results
 * with a per-row source badge.
 *
 * Trust is computed client-side (`resolveTrustTier`); the server recomputes
 * authoritatively at save time. The badge uses neutral variants — `--signal`
 * is reserved for liveness per the Signal design system.
 *
 * A PANEL since #23 P2: it renders as the Skill hub tab of the Skills page and
 * owns no page chrome — the tab row above it and the shell's topbar carry the
 * identity.
 */
export function SkillHubPanel({ onSavedSkill }: { onSavedSkill?: (key: string) => void } = {}) {
  const { logout } = useAuth();
  const { t } = useI18n();
  const [marketplaces, setMarketplaces] = useState<{ id: string }[] | null>(null);
  const [selectedMkt, setSelectedMkt] = useState<string>('');
  const [category, setCategory] = useState<string>('all');
  const [q, setQ] = useState<string>('');
  const [rows, setRows] = useState<HubRow[] | null>(null);
  const [timedOut, setTimedOut] = useState<string[]>([]);
  const [saving, setSaving] = useState<HubRow | null>(null);
  // P6 — a failed fetch is an ERROR face with a Retry, not an empty list: the
  // marketplace fetch reaches the network, so it fails for real, and "no rows
  // match the filter" would have been a lie about why the table is empty.
  const [loadError, setLoadError] = useState<unknown>(null);
  const [reloads, setReloads] = useState(0);

  const searching = q.trim().length > 0;

  // Load the allowlist once; auto-select the first marketplace.
  useEffect(() => {
    void (async () => {
      try {
        const list = await withAuthGuard(() => api.listMarketplaces(), logout);
        setMarketplaces(list.marketplaces);
        if (list.marketplaces.length > 0 && !selectedMkt) {
          const first = list.marketplaces[0];
          if (first) setSelectedMkt(first.id);
        }
      } catch (e) {
        toast.error(
          e instanceof HarnessNexusError ? e.message : t('skillHub.loadMarketplacesFailed'),
        );
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logout]);

  // Fetch: search path (q non-empty) or browse path (marketplace + category).
  useEffect(() => {
    if (!searching && !selectedMkt) return;
    void (async () => {
      setRows(null);
      setTimedOut([]);
      setLoadError(null);
      try {
        if (searching) {
          const res = await withAuthGuard(() => api.searchSkills(q.trim()), logout);
          setRows(res.results.map(metaToRow));
          setTimedOut(res.timedOut);
        } else {
          const filter: { category?: string } = {};
          if (category !== 'all') filter.category = category;
          const res = await withAuthGuard(
            () => api.listMarketplacePlugins(selectedMkt, filter),
            logout,
          );
          setRows(res.plugins.map((p) => pluginToRow(p)));
        }
      } catch (e) {
        setLoadError(e);
        setRows([]);
      }
    })();
  }, [selectedMkt, category, q, logout, searching, reloads]);

  // Categories are derived from the currently-loaded set (browse mode only).
  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows ?? []) if (r.category) set.add(r.category);
    return [...set].sort();
  }, [rows]);

  return (
    <>
      {/* The hub tab owns no page chrome (the tab row + topbar carry the
          identity), so the panel IS the page: subtitle as the intro prose the
          sibling tab also renders, the filters as the table's toolbar strip. */}
      <PageIntro sub={<>{t('skillHub.subtitle')}</>} />

      <DataTable
        columns={5}
        label={t('skillHub.title')}
        icon={<StoreIcon />}
        state={tableState({
          error: loadError,
          loading: rows === null,
          count: rows?.length ?? 0,
          filtered: searching || category !== 'all',
        })}
        error={loadError}
        onRetry={() => setReloads((n) => n + 1)}
        {...(searching || category !== 'all'
          ? {
              onClearFilters: () => {
                if (searching) setQ('');
                else setCategory('all');
              },
            }
          : {})}
        toolbar={
          <>
            {!searching ? (
              <>
                <Select
                  value={selectedMkt}
                  onValueChange={(v) => setSelectedMkt(v)}
                  disabled={!marketplaces || marketplaces.length === 0}
                >
                  <SelectTrigger id="filter-marketplace" className="w-[220px]">
                    <SelectValue placeholder={t('skillHub.marketplacePlaceholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    {(marketplaces ?? []).map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        <span className="font-mono">{m.id}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={category}
                  onValueChange={(v) => setCategory(v)}
                  disabled={!selectedMkt}
                >
                  <SelectTrigger id="filter-category" className="w-[150px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t('skillHub.allCategories')}</SelectItem>
                    {categories.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            ) : null}
            <div className="relative">
              <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t('skillHub.searchPlaceholder')}
                spellCheck={false}
                className="w-[260px] pl-8"
                aria-label={t('skillHub.searchAriaLabel')}
              />
            </div>
          </>
        }
      >
        <TableHeader>
          <TableRow>
            <TableHead className="pl-6">{t('common.name')}</TableHead>
            <TableHead>{t('skillHub.category')}</TableHead>
            <TableHead>{t('skillHub.source')}</TableHead>
            <TableHead>{t('skillHub.trust')}</TableHead>
            <TableHead className="pr-6 text-right">{t('common.actions')}</TableHead>
          </TableRow>
        </TableHeader>
        {rows !== null && rows.length > 0 ? (
          <TableBody>
            {rows.map((r) => (
              <HubRowView key={`${r.sourceKind}:${r.key}`} row={r} onSave={() => setSaving(r)} />
            ))}
          </TableBody>
        ) : null}
      </DataTable>

      {/* Partial results are a degradation, not a failure: the data above is
          real, some source just did not answer in time — the design's warn
          note (03-interaction.md §1), never a silent truncation. */}
      {searching && timedOut.length > 0 ? (
        <div className="mt-(--gap-tight)">
          <Note tone="warn">{t('skillHub.timedOut', { sources: timedOut.join(', ') })}</Note>
        </div>
      ) : null}

      {saving ? (
        <SavePluginDialog
          row={saving}
          onClose={() => setSaving(null)}
          onSaved={(key) => {
            setSaving(null);
            // The hub produces skills; the list is where they land. Hand the new
            // key up so the page can switch tabs and point at it (09 §5).
            onSavedSkill?.(key);
          }}
        />
      ) : null}
    </>
  );
}

/** Project a multi-source search result into a unified row. */
function metaToRow(m: SkillMeta): HubRow {
  const pluginSource = skillMetaToResourceSource(m);
  // An adapter always attaches pluginSource; if a future one doesn't, fall back
  // to a url-shaped source so the row is still saveable.
  const source: PluginResourceSource = pluginSource ?? {
    type: 'plugin',
    source: { source: 'url', url: m.identifier },
    plugin: m.name,
  };
  const extra = (m.extra ?? {}) as { category?: string; homepage?: string };
  const hasPin = ('sha' in source.source && Boolean(source.source.sha)) || Boolean(source.version);
  return {
    key: m.identifier,
    name: m.name,
    description: m.description,
    sourceKind: m.source,
    category: extra.category,
    homepage: extra.homepage,
    tier: m.trustLevel,
    pluginSource: source,
    hasPin,
  };
}

/** Project a marketplace browse entry into a unified row. */
function pluginToRow(p: MarketplacePlugin): HubRow {
  return {
    key: p.name,
    name: p.displayName ?? p.name,
    description: p.description,
    sourceKind: 'marketplace',
    category: p.category,
    homepage: p.homepage,
    tier: resolveTrustTier(p.source),
    pluginSource: marketplacePluginToResourceSource(p),
    hasPin: ('sha' in p.source && Boolean(p.source.sha)) || Boolean(p.version),
  };
}

function HubRowView({ row, onSave }: { row: HubRow; onSave: () => void }) {
  const { t } = useI18n();
  return (
    <>
      <TableRow>
        <TableCell className="pl-6">
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5 font-medium">{row.name}</div>
            <div className="text-muted-foreground line-clamp-2 max-w-xl text-xs">
              {row.description}
            </div>
          </div>
        </TableCell>
        <TableCell>
          {row.category ? (
            <Badge variant="outline" className="font-mono text-[10px]">
              {row.category}
            </Badge>
          ) : (
            <span className="text-muted-foreground text-xs">—</span>
          )}
        </TableCell>
        <TableCell>
          <span className="text-muted-foreground font-mono text-[11px]">{row.sourceKind}</span>
        </TableCell>
        <TableCell>
          <TrustBadge tier={row.tier} />
        </TableCell>
        <TableCell className="pr-6 text-right">
          {row.pluginSource ? (
            <Button variant="outline" size="sm" onClick={onSave} className="gap-1.5">
              {t('skillHub.saveAsSkill')}
            </Button>
          ) : (
            <span className="text-muted-foreground text-xs" title={t('skillHub.archiveTooltip')}>
              —
            </span>
          )}
        </TableCell>
      </TableRow>
    </>
  );
}

/**
 * Neutral trust badge — `default` (ink) for trusted, `secondary` for community.
 * Deliberately does NOT use `--signal`; that accent is reserved for liveness
 * per the Signal design system.
 */
function TrustBadge({ tier }: { tier: TrustTier }) {
  const { t } = useI18n();
  if (tier === 'trusted') {
    return (
      <>
        <Badge variant="default" className="gap-1 text-[10px]">
          <ShieldCheckIcon className="size-3" />
          {t('skillHub.trusted')}
        </Badge>
      </>
    );
  }
  return (
    <>
      <Badge variant="secondary" className="gap-1 text-[10px]">
        <StateSignal state="neutral" aria-hidden className="size-1.5" />
        {t('skillHub.community')}
      </Badge>
    </>
  );
}

/**
 * "Save this as a skill resource" dialog. The source shape is precomputed on
 * the row (from either a marketplace entry or a search result's
 * `extra.pluginSource`); the dialog just collects key/scope/targets. A warn
 * callout appears for community sources without a pin (supply-chain drift
 * risk — the install-warning UX from the PRD).
 */
function SavePluginDialog({
  row,
  onClose,
  onSaved,
}: {
  row: HubRow;
  onClose: () => void;
  /** The saved resource's key, so the page can reveal it in the list. */
  onSaved: (key: string) => void;
}) {
  const { logout, user } = useAuth();
  const { t } = useI18n();
  const isAdmin = user?.role === 'admin';
  const [key, setKey] = useState<string>(`skill:${row.name}`);
  const [scope, setScope] = useState<Scope>('personal');
  const [targets, setTargets] = useState<AgentTarget[]>(['claude-code']);
  const [busy, setBusy] = useState(false);

  const showWarn = row.tier === 'community' && !row.hasPin;

  function toggleTarget(t: AgentTarget) {
    setTargets((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  }

  async function onSubmit() {
    if (scope === 'global' && !isAdmin) return;
    setBusy(true);
    try {
      const source = row.pluginSource as Parameters<typeof api.createResource>[0]['source'];
      const { resource } = await withAuthGuard(
        () =>
          api.createResource({
            key,
            kind: 'skill',
            name: row.name,
            ...(row.description ? { description: row.description } : {}),
            source,
            scope,
            targets,
          }),
        logout,
      );
      onSaved(resource.key);
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('skillHub.saveFailedToast'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('skillHub.dialogTitle')}</DialogTitle>
            <DialogDescription>
              {t('skillHub.dialogDescLead')}{' '}
              <span className="font-mono">{`skill:${row.name}`}</span>
              {t('skillHub.dialogDescTail')}
            </DialogDescription>
          </DialogHeader>

          {showWarn ? (
            <div className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 p-2.5 text-xs">
              <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warn" />
              <div>
                <span className="font-medium text-warn">{t('skillHub.warnLead')}</span>{' '}
                <span className="text-muted-foreground">{t('skillHub.warnBody')}</span>
              </div>
            </div>
          ) : null}

          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="skill-key">{t('skillHub.key')}</Label>
              <Input
                id="skill-key"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                spellCheck={false}
                className="font-mono"
              />
            </div>

            <div className="grid gap-2">
              <Label>{t('common.scope')}</Label>
              <Select value={scope} onValueChange={(v) => setScope(v as Scope)}>
                <SelectTrigger id="skill-scope" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="personal">{t('common.scopePersonal')}</SelectItem>
                  <SelectItem value="global" disabled={!isAdmin}>
                    {t('common.scopeGlobal')}
                    {isAdmin ? '' : t('skillHub.adminOnly')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-2">
              <Label>{t('skillHub.targets')}</Label>
              <div className="flex flex-wrap gap-2">
                {TARGETS.map((t) => (
                  <label
                    key={t}
                    className="flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs"
                  >
                    <input
                      type="checkbox"
                      checked={targets.includes(t)}
                      onChange={() => toggleTarget(t)}
                      className="size-3.5"
                    />
                    <span className="font-mono">{t}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          <DialogFooter>
            {/* Third-party catalog data — scheme-check before it reaches an href
              (React already blocks javascript:, this is defense in depth). */}
            {row.homepage && /^https?:\/\//i.test(row.homepage) ? (
              <a
                href={row.homepage}
                target="_blank"
                rel="noreferrer"
                className="text-muted-foreground hover:text-foreground mr-auto inline-flex items-center gap-1 text-xs"
              >
                <ExternalLinkIcon className="size-3" />
                {t('skillHub.homepage')}
              </a>
            ) : null}
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              disabled={busy || (scope === 'global' && !isAdmin)}
              onClick={onSubmit}
            >
              {busy ? t('common.saving') : t('skillHub.saveSkill')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
