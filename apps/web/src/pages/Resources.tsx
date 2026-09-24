import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  BoxesIcon,
  PlusIcon,
  TrashIcon,
  PencilIcon,
  GlobeIcon,
  UserIcon,
  MoreHorizontalIcon,
} from 'lucide-react';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n, dateLocale, type TranslationKey } from '@/i18n';
import {
  ConfirmDialog,
  DataTable,
  FilterBar,
  FilterSelect,
  PageIntro,
  Readout,
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
import { PageSlot } from '@/components/shell/page-slots';
import type { ResourcePageKind } from '@/nav';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { FormDialog } from '@/components/ui/form-dialog';
import {
  HarnessNexusError,
  HOOK_EVENTS,
  HOOK_SUPPORT,
  type Resource,
  type ResourceKind,
  type AgentTarget,
  type HookEvent,
} from '@harness-nexus/sdk';

type Scope = 'global' | 'personal';

/**
 * Kinds currently shipped (4.2/4.3/4.4/4.5). 4.6 adds skill here when it lands.
 * Strings are held as TranslationKeys and resolved with t() at render time —
 * never at module scope.
 */
const KINDS: {
  value: ResourceKind;
  labelKey: TranslationKey;
  bodyLabelKey: TranslationKey;
  bodyPlaceholderKey: TranslationKey;
}[] = [
  {
    value: 'sub_agent',
    labelKey: 'resources.kindSubAgent',
    bodyLabelKey: 'resources.bodySystemPrompt',
    bodyPlaceholderKey: 'resources.phSubAgent',
  },
  {
    value: 'rule',
    labelKey: 'resources.kindRule',
    bodyLabelKey: 'resources.bodyPolicy',
    bodyPlaceholderKey: 'resources.phRule',
  },
  {
    value: 'command',
    labelKey: 'resources.kindCommand',
    bodyLabelKey: 'resources.bodyCommand',
    bodyPlaceholderKey: 'resources.phCommand',
  },
  {
    value: 'hook',
    labelKey: 'resources.kindHook',
    bodyLabelKey: 'resources.bodyHooks',
    bodyPlaceholderKey: 'resources.phHook', // hooks use a structured editor, not a textarea
  },
  {
    value: 'skill',
    labelKey: 'resources.kindSkill',
    bodyLabelKey: 'resources.bodySkillMd',
    bodyPlaceholderKey: 'resources.phSkill',
  },
];

const TARGETS: AgentTarget[] = ['claude-code', 'zcode', 'hermes', 'pi', 'generic'];

/**
 * The list's vocabulary (07-p3-list-pages.md §5). No `kind` filter: every route
 * that renders this page fixes one (`/skills`, `/sub-agents`, …), so the kind is
 * a route fact — the nav is where a kind is chosen. Module scope: it is a
 * constant, and `useListQuery` holds onto it.
 */
const RESOURCE_SPEC: ListQuerySpec = {
  filters: { scope: ['personal', 'global'] },
  sort: ['-updated', 'name'],
};

/** The kind's label key for the page intro; the all-kinds case never renders it. */
function kindLabelKey(kind: ResourcePageKind): TranslationKey {
  return KINDS.find((k) => k.value === kind)?.labelKey ?? 'resources.title';
}

/**
 * One kind per page (#23 P2, README §5.3). The route is the address, so the
 * kind is not a per-visit decision: `/resources` itself redirects to `/skills`.
 * P4 gives each kind its own columns and editor; until then every kind page is
 * the same table with its kind nailed down.
 *
 * Filtering, search and sort live in the URL and are applied in memory over one
 * fetch (07-p3-list-pages.md §3.7) — the pre-P3 version refetched the list on
 * every filter change and pushed nothing into the URL, so a filtered view could
 * not be shared, reloaded or gone back to.
 */
export function ResourcesPage({ fixedKind }: { fixedKind: ResourcePageKind }) {
  const { logout, user } = useAuth();
  const { t, lang } = useI18n();
  const isAdmin = user?.role === 'admin';
  const spec = RESOURCE_SPEC;
  const query = useListQuery(spec);
  const [items, setItems] = useState<Resource[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  // The resource being edited, or 'new' to open the create dialog, or null.
  const [editing, setEditing] = useState<Resource | 'new' | null>(null);
  // The resource pending deletion — the ConfirmDialog's subject.
  const [pending, setPending] = useState<Resource | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      setItems(await withAuthGuard(() => api.listResources(), logout));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const visible = useMemo(() => {
    if (items === null) return null;
    const rows = items.filter(
      (r) =>
        r.kind === fixedKind &&
        matchesQuery(query.q, [r.name, r.key, r.description]) &&
        (query.filters['scope'] === null || r.scope === query.filters['scope']),
    );
    return sortRows(rows, effectiveSort(spec, query), (r, key) =>
      key === 'name' ? r.name : r.updatedAt,
    );
  }, [items, fixedKind, spec, query.q, query.filters, query.sort]);

  // Label maps are built from `t` at render time (module scope holds keys only).
  const scopeLabels = useMemo(
    () => ({ personal: t('common.scopePersonal'), global: t('common.scopeGlobal') }),
    [t],
  );
  const sortLabels = useMemo(
    () => ({ '-updated': t('common.sortUpdated'), name: t('common.sortName') }),
    [t],
  );

  async function confirmRemove() {
    const r = pending;
    if (r === null) return;
    setBusy(true);
    try {
      const res = await withAuthGuard(() => api.deleteResource(r.id), logout);
      toast.success(res.mode === 'soft' ? t('resources.deletedSoft') : t('resources.deletedHard'));
      setPending(null);
      await refresh();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.deleteFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageSlot slot="actions">
        <Button onClick={() => setEditing('new')} className="gap-1.5">
          <PlusIcon className="size-4" />
          <span className="hidden sm:inline">
            {fixedKind === 'skill' ? t('resources.newSkill') : t('resources.newResource')}
          </span>
        </Button>
      </PageSlot>

      <PageIntro
        sub={
          <>
            {t('resources.subtitleKind', { kind: t(kindLabelKey(fixedKind)) })}{' '}
            <Well variant="chip" copy="kind:key">
              kind:key
            </Well>
            {t('resources.subtitleAfter')}
          </>
        }
      />

      <DataTable
        columns={6}
        label={t('resources.storedTitle')}
        icon={<BoxesIcon />}
        meta={
          <Readout
            layout="inline"
            size="sm"
            value={items?.length ?? 0}
            label={t('resources.total')}
            loading={items === null}
          />
        }
        toolbar={
          <FilterBar query={query} shown={visible?.length} total={items?.length}>
            <TableSearch query={query} placeholder={t('resources.searchPlaceholder')} />
            <FilterSelect
              query={query}
              spec={spec}
              name="scope"
              allLabel={t('common.allScopes')}
              labels={scopeLabels}
            />
            <SortSelect
              query={query}
              spec={spec}
              label={t('common.sortLabel')}
              labels={sortLabels}
            />
          </FilterBar>
        }
        state={tableState({
          error,
          loading: items === null,
          count: visible?.length ?? 0,
          filtered: query.active,
        })}
        error={error}
        onRetry={() => void refresh()}
        onClearFilters={query.clear}
        empty={{
          title: t('resources.empty'),
          hint: t('resources.emptyHint'),
          action: (
            <Button onClick={() => setEditing('new')} className="gap-1.5">
              <PlusIcon className="size-4" />
              {fixedKind === 'skill' ? t('resources.newSkill') : t('resources.newResource')}
            </Button>
          ),
        }}
      >
        <TableHeader>
          <TableRow>
            <TableHead>{t('common.name')}</TableHead>
            <TableHead>{t('resources.kind')}</TableHead>
            <TableHead>{t('resources.key')}</TableHead>
            <TableHead>{t('common.scope')}</TableHead>
            <TableHead>{t('resources.updated')}</TableHead>
            <TableHead className="text-right">{t('common.actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible?.map((r) => (
            <TableRow key={r.id}>
              <TableCell className="font-medium">{r.name}</TableCell>
              <TableCell>
                <Badge variant="outline" className="font-mono text-[10px]">
                  {r.kind}
                </Badge>
              </TableCell>
              <TableCell className="font-mono text-xs tabular-nums">{r.key}</TableCell>
              <TableCell>
                <Badge variant={r.scope === 'global' ? 'default' : 'secondary'} className="gap-1">
                  {r.scope === 'global' ? (
                    <GlobeIcon className="size-3" />
                  ) : (
                    <UserIcon className="size-3" />
                  )}
                  {r.scope === 'global' ? t('common.scopeGlobal') : t('common.scopePersonal')}
                </Badge>
              </TableCell>
              <TableCell className="text-muted-foreground tabular-nums">
                {new Date(r.updatedAt).toLocaleDateString(dateLocale(lang), {
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
                    <DropdownMenuItem
                      disabled={r.scope === 'global' && !isAdmin}
                      onClick={() => setEditing(r)}
                    >
                      <PencilIcon /> {t('common.edit')}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={r.scope === 'global' && !isAdmin}
                      onClick={() => setPending(r)}
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

      {editing !== null ? (
        <ResourceEditor
          existing={editing === 'new' ? null : editing}
          lockedKind={fixedKind}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      ) : null}

      {pending !== null ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) setPending(null);
          }}
          title={t('resources.deleteAction')}
          consequence={t('resources.deleteConsequence')}
          impact={[
            { label: 'key', value: pending.key },
            { label: 'kind', value: pending.kind },
            { label: 'scope', value: pending.scope },
          ]}
          actionLabel={t('resources.deleteAction')}
          // Two-stage delete: the first one only hides it (see the consequence),
          // so the kit's generic "cannot be undone" line would be a lie.
          irreversible={false}
          busy={busy}
          onConfirm={() => void confirmRemove()}
        />
      ) : null}
    </>
  );
}

/** Create/edit Dialog shared by all kinds. 4.2/4.3 produce inline-markdown bodies. */
function ResourceEditor({
  existing,
  lockedKind,
  onClose,
  onSaved,
}: {
  existing: Resource | null;
  /** The page's kind — the editor opens on it and shows it as a fact. */
  lockedKind: ResourceKind;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { logout, user } = useAuth();
  const { t } = useI18n();
  const isAdmin = user?.role === 'admin';
  const isCreate = existing === null;

  const kind = existing?.kind ?? lockedKind;
  const [key, setKey] = useState(existing?.key ?? '');
  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [version, setVersion] = useState(existing?.version ?? '1.0.0');
  const [scope, setScope] = useState<Scope>(existing?.scope ?? 'personal');
  const [targets, setTargets] = useState<AgentTarget[]>(existing?.targets ?? []);
  const [body, setBody] = useState(
    existing?.source.type === 'inline' ? existing.source.content : '',
  );
  // For multi-file skills (inline-bundle): a path→content map.
  const [bundleFiles, setBundleFiles] = useState<Record<string, string>>(
    existing?.source.type === 'inline-bundle' ? existing.source.files : {},
  );
  const [busy, setBusy] = useState(false);

  const kindMeta = KINDS.find((k) => k.value === kind)!;

  // The source emitted on save. Skills switch between single-file `inline` and
  // multi-file `inline-bundle` based on whether extra files exist; everything
  // else is always `inline`.
  const computedSource: Resource['source'] =
    kind === 'skill' && Object.keys(bundleFiles).length > 0
      ? { type: 'inline-bundle', files: { 'SKILL.md': body, ...bundleFiles } }
      : { type: 'inline', content: body };

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const shared = {
        key,
        name,
        description: description.trim() === '' ? undefined : description,
        version,
        source: computedSource,
        targets,
      };
      if (isCreate) {
        await withAuthGuard(() => api.createResource({ ...shared, kind, scope }), logout);
        toast.success(t('resources.created'));
      } else {
        await withAuthGuard(() => api.updateResource(existing!.id, shared), logout);
        toast.success(t('resources.saved'));
      }
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : t('common.saveFailed'));
    } finally {
      setBusy(false);
    }
  }

  function toggleTarget(target: AgentTarget) {
    setTargets((prev) =>
      prev.includes(target) ? prev.filter((x) => x !== target) : [...prev, target],
    );
  }

  return (
    <>
      <FormDialog
        open
        onClose={onClose}
        size={kind === 'skill' ? 'xl' : 'lg'}
        title={
          isCreate ? t('resources.newResource') : t('resources.editTitle', { name: existing!.name })
        }
        description={
          <>
            {t('resources.editorDesc', { body: t(kindMeta.bodyLabelKey).toLowerCase() })}{' '}
            <code className="font-mono">{`${kind}:${key || '…'}`}</code>
            {t('resources.editorDescAfter')}
          </>
        }
        footer={
          <>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="button" disabled={busy} onClick={onSubmit}>
              {busy
                ? t('common.saving')
                : isCreate
                  ? t('resources.createResource')
                  : t('resources.saveChanges')}
            </Button>
          </>
        }
      >
        <form onSubmit={onSubmit} className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="res-kind">{t('resources.kind')}</Label>
              {/* The page owns the kind; the editor states it rather than asking. */}
              <div>
                <Badge variant="secondary">{t(kindMeta.labelKey)}</Badge>
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="res-scope">{t('common.scope')}</Label>
              <Select
                value={scope}
                onValueChange={(v) => setScope(v as Scope)}
                disabled={!isCreate || !isAdmin}
              >
                <SelectTrigger id="res-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="personal">{t('common.scopePersonal')}</SelectItem>
                  <SelectItem value="global" disabled={!isAdmin}>
                    {t('common.scopeGlobal')}
                    {!isAdmin && t('resources.adminSuffix')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="res-key">{t('resources.key')}</Label>
              <Input
                id="res-key"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={`${kind}:my-asset`}
                autoComplete="off"
                spellCheck={false}
                required
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="res-name">{t('common.name')}</Label>
              <Input
                id="res-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('resources.phName')}
                autoComplete="off"
                required
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="res-version">{t('resources.version')}</Label>
              <Input
                id="res-version"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                placeholder="1.0.0"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="res-desc">{t('common.description')}</Label>
              <Input
                id="res-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('resources.phDescription')}
                autoComplete="off"
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label>{t('resources.targets')}</Label>
            <div className="flex flex-wrap gap-2">
              {TARGETS.map((target) => (
                <label
                  key={target}
                  className="flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs"
                >
                  <input
                    type="checkbox"
                    checked={targets.includes(target)}
                    onChange={() => toggleTarget(target)}
                    className="size-3.5"
                  />
                  <span className="font-mono">{target}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="grid gap-2">
            {kind === 'hook' ? (
              <HookBodyEditor body={body} setBody={setBody} targets={targets} />
            ) : (
              <>
                <Label htmlFor="res-body">{t(kindMeta.bodyLabelKey)}</Label>
                <Textarea
                  id="res-body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder={t(kindMeta.bodyPlaceholderKey)}
                  spellCheck={false}
                  className="min-h-48 font-mono text-xs"
                />
              </>
            )}
          </div>

          {kind === 'skill' ? (
            <SkillBundleEditor files={bundleFiles} setFiles={setBundleFiles} />
          ) : null}
        </form>
      </FormDialog>
    </>
  );
}

/**
 * Structured editor for a hooks.json document. Manages a list of
 * { event, matcher?, command } entries and serializes them to the
 * `{ hooks: { <Event>: [{ matcher?, hooks: [{ type:'command', command }] }] } }`
 * shape stored in `source.inline.content`.
 *
 * Only events supported by at least one declared target are offered. Hermes is
 * excluded entirely (no declarative hooks model). See
 * `wiki research-phase-4.5-hooks.md`.
 */
interface HookEntry {
  event: HookEvent;
  matcher: string;
  command: string;
}

function HookBodyEditor({
  body,
  setBody,
  targets,
}: {
  body: string;
  setBody: (v: string) => void;
  targets: AgentTarget[];
}) {
  // Parse the stored JSON once into entries; fall back to empty.
  const { t } = useI18n();
  const [entries, setEntries] = useState<HookEntry[]>(() => parseHooksJson(body));

  // Events available for the declared targets (union; Hermes contributes none).
  const availableEvents = useMemo(() => {
    const set = new Set<HookEvent>();
    for (const target of targets) {
      const supported = HOOK_SUPPORT[target];
      if (supported) for (const e of supported) set.add(e);
    }
    return HOOK_EVENTS.filter((e) => set.has(e));
  }, [targets]);

  // Sync entries → JSON whenever they change.
  useEffect(() => {
    setBody(serializeHooksJson(entries));
  }, [entries, setBody]);

  function addEntry() {
    setEntries((prev) => [
      ...prev,
      { event: availableEvents[0] ?? 'PreToolUse', matcher: '', command: '' },
    ]);
  }

  function updateEntry(i: number, patch: Partial<HookEntry>) {
    setEntries((prev) => prev.map((e, idx) => (idx === i ? { ...e, ...patch } : e)));
  }

  function removeEntry(i: number) {
    setEntries((prev) => prev.filter((_, idx) => idx !== i));
  }

  return (
    <>
      <div className="flex items-center justify-between">
        <Label>{t('resources.hookBindings')}</Label>
        <Button type="button" variant="outline" size="sm" className="gap-1.5" onClick={addEntry}>
          <PlusIcon className="size-4" />
          {t('resources.addBinding')}
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">
        {t('resources.hooksDesc')} <code className="font-mono">hooks.json</code>
        {t('resources.hooksDescAfter')}
      </p>
      <div className="flex flex-col gap-3">
        {entries.length === 0 ? (
          <p className="text-muted-foreground rounded-md border border-dashed py-6 text-center text-sm">
            {t('resources.hooksEmpty')}
          </p>
        ) : (
          entries.map((e, i) => (
            <div key={i} className="bg-muted/40 flex flex-col gap-2 rounded-md border p-3">
              <div className="flex items-center gap-2">
                <Select
                  value={e.event}
                  onValueChange={(v) => updateEntry(i, { event: v as HookEvent })}
                >
                  <SelectTrigger className="w-[180px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {availableEvents.map((ev) => (
                      <SelectItem key={ev} value={ev}>
                        {ev}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  value={e.matcher}
                  onChange={(ev) => updateEntry(i, { matcher: ev.target.value })}
                  placeholder={t('resources.phMatcher')}
                  spellCheck={false}
                  className="flex-1 font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0"
                  onClick={() => removeEntry(i)}
                >
                  <TrashIcon className="size-4" />
                  <span className="sr-only">{t('resources.removeBinding')}</span>
                </Button>
              </div>
              <Input
                value={e.command}
                onChange={(ev) => updateEntry(i, { command: ev.target.value })}
                placeholder={t('resources.phHookCommand')}
                spellCheck={false}
                className="font-mono text-xs"
              />
            </div>
          ))
        )}
      </div>
    </>
  );
}

type HooksJsonDoc = {
  hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>>;
};

/** Parse stored hooks.json into flat { event, matcher, command } entries. */
function parseHooksJson(content: string): HookEntry[] {
  if (!content.trim()) return [];
  try {
    const doc = JSON.parse(content) as HooksJsonDoc;
    const out: HookEntry[] = [];
    for (const [event, groups] of Object.entries(doc.hooks ?? {})) {
      for (const g of groups) {
        for (const h of g.hooks ?? []) {
          out.push({
            event: event as HookEvent,
            matcher: g.matcher ?? '',
            command: h.command ?? '',
          });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Serialize entries back into the hooks.json document shape. */
function serializeHooksJson(entries: HookEntry[]): string {
  const hooks: Record<
    string,
    Array<{ matcher?: string; hooks: Array<{ type: 'command'; command: string }> }>
  > = {};
  for (const e of entries) {
    if (!e.command.trim()) continue; // skip empty commands
    (hooks[e.event] ??= []).push({
      ...(e.matcher.trim() ? { matcher: e.matcher.trim() } : {}),
      hooks: [{ type: 'command', command: e.command }],
    });
  }
  return JSON.stringify({ hooks }, null, 2);
}

/**
 * Manages the extra files of a multi-file skill (everything besides the main
 * SKILL.md, which lives in the primary body textarea). Each entry is a
 * relative path → content pair. When any extra file exists, the editor emits
 * `source.inline-bundle` instead of `source.inline`. See Phase 4.6 / the 4.4
 * skill research (~42% of real skills are multi-file).
 */
function SkillBundleEditor({
  files,
  setFiles,
}: {
  files: Record<string, string>;
  setFiles: (f: Record<string, string>) => void;
}) {
  const { t } = useI18n();
  const [newPath, setNewPath] = useState('');
  const [activePath, setActivePath] = useState<string | null>(null);
  const paths = Object.keys(files).sort();

  function addFile() {
    const p = newPath.trim();
    if (!p) return;
    if (p === 'SKILL.md' || p.startsWith('/') || p.includes('..') || p.includes('\\')) {
      toast.error(t('resources.invalidPath'));
      return;
    }
    if (files[p] !== undefined) {
      toast.error(t('resources.pathExists', { path: p }));
      return;
    }
    setFiles({ ...files, [p]: '' });
    setActivePath(p);
    setNewPath('');
  }

  function removeFile(p: string) {
    const next = { ...files };
    delete next[p];
    setFiles(next);
    if (activePath === p) setActivePath(null);
  }

  function updateContent(p: string, content: string) {
    setFiles({ ...files, [p]: content });
  }

  return (
    <>
      <div className="grid gap-2">
        <div className="flex items-center justify-between">
          <Label>{t('resources.extraFiles')}</Label>
          <span className="text-muted-foreground text-xs">
            {paths.length === 0
              ? t('resources.singleFile')
              : t('resources.extraCount', { count: paths.length })}
          </span>
        </div>
        <p className="text-muted-foreground text-xs">
          {t('resources.bundleDescA')} <code className="font-mono">references/foo.md</code>{' '}
          {t('resources.bundleDescB')} <code className="font-mono">scripts/run.sh</code>
          {t('resources.bundleDescC')}
        </p>

        {paths.length > 0 ? (
          <div className="flex flex-col gap-3 sm:flex-row">
            {/* File list */}
            <div className="bg-muted/40 flex flex-col rounded-md border p-2 sm:w-56 sm:shrink-0">
              {paths.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setActivePath(p)}
                  className={cn(
                    'flex items-center justify-between rounded px-2 py-1.5 text-left font-mono text-xs transition-colors',
                    activePath === p ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60',
                  )}
                >
                  <span className="truncate">{p}</span>
                  <TrashIcon
                    className="text-muted-foreground hover:text-destructive size-3.5 shrink-0"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeFile(p);
                    }}
                  />
                </button>
              ))}
            </div>
            {/* Active file editor */}
            {activePath ? (
              <Textarea
                key={activePath}
                value={files[activePath]}
                onChange={(e) => updateContent(activePath, e.target.value)}
                placeholder={t('resources.fileContent', { path: activePath })}
                spellCheck={false}
                className="min-h-48 flex-1 font-mono text-xs"
              />
            ) : (
              <div className="text-muted-foreground flex flex-1 items-center justify-center rounded-md border border-dashed py-8 text-sm">
                {t('resources.selectFile')}
              </div>
            )}
          </div>
        ) : null}

        <div className="flex items-center gap-2">
          <Input
            value={newPath}
            onChange={(e) => setNewPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addFile();
              }
            }}
            placeholder="references/notes.md"
            spellCheck={false}
            className="font-mono text-xs"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5 shrink-0"
            onClick={addFile}
          >
            <PlusIcon className="size-4" />
            {t('resources.addFile')}
          </Button>
        </div>
      </div>
    </>
  );
}
