// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  ChevronDownIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
  Wand2Icon,
} from 'lucide-react';
import { DEFAULT_ASSISTANT_SYSTEM_PROMPT } from '@harness-nexus/sdk';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';
import { useI18n } from '@/i18n';
import { DataTable, Note, PageIntro, Well } from '@/components/kit';
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
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PageSlot } from '@/components/shell/page-slots.js';
import { PageAction } from '@/components/shell/page-action.js';
import {
  HarnessNexusError,
  type AssistantConfigView,
  type LlmProviderView,
} from '@harness-nexus/sdk';
/** The tool groups (kept in sync with shared's ASSISTANT_TOOL_GROUPS). */
const ASSISTANT_TOOL_GROUPS = [
  'resources',
  'profiles',
  'mcp',
  'skills-hub',
  'machines',
  'agent-dispatch',
  'system',
] as const;
import { Checkbox } from '@/components/ui/checkbox';

/**
 * The assistant config page (#52 §8) — the standard list + create/edit
 * FormDialog pattern. Sections: basic (name/description), model (provider +
 * registry models — the #51 pick-only rule: no re-discovery here), prompt
 * (empty override = the platform default), tool groups (checkbox row set).
 */

interface Draft {
  name: string;
  description: string;
  providerId: string;
  defaultModel: string;
  systemPromptOverride: string;
  enabledToolGroups: string[];
  mcpServerIds: string[];
  skillResourceIds: string[];
  /** '' = unlimited (null on the wire). */
  dailyTokenBudget: string;
}

const EMPTY_DRAFT: Draft = {
  name: '',
  description: '',
  providerId: '',
  defaultModel: '',
  systemPromptOverride: '',
  enabledToolGroups: [...ASSISTANT_TOOL_GROUPS],
  mcpServerIds: [],
  skillResourceIds: [],
  dailyTokenBudget: '',
};

/**
 * #69 — the platform default the override replaces, on demand. The field's
 * hint says "empty = the platform default"; an informed override (or a
 * deliberate choice to keep the default) needs to see what that default
 * says — same constant the server builds turns from.
 */
function DefaultPromptDisclosure() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
      >
        <ChevronDownIcon
          className={`size-3 transition-transform${open ? ' rotate-180' : ''}`}
          aria-hidden
        />
        {t(open ? 'assistants.defaultPromptHide' : 'assistants.defaultPromptShow')}
      </button>
      {open ? (
        // block geometry, not text: wells' inline variants CENTER their
        // value, which clips a scrollable document's head above the
        // scrollport (ui-visual P0) — block wells are top-aligned flow.
        <Well variant="block" truncate={false} className="mt-1 max-h-64 overflow-auto">
          <pre className="text-muted-foreground break-normal whitespace-pre-wrap font-mono text-xs">
            {DEFAULT_ASSISTANT_SYSTEM_PROMPT}
          </pre>
        </Well>
      ) : null}
    </div>
  );
}

export function AssistantsPage() {
  const { logout } = useAuth();
  const { t } = useI18n();
  const [items, setItems] = useState<AssistantConfigView[] | null>(null);
  const [providers, setProviders] = useState<LlmProviderView[]>([]);
  const [mcpServers, setMcpServers] = useState<{ id: string; name: string; dialSite: string }[]>(
    [],
  );
  const [skillResources, setSkillResources] = useState<
    { id: string; name: string; source: { type: string } }[]
  >([]);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<AssistantConfigView | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<AssistantConfigView | null>(null);

  async function refresh() {
    try {
      const [list, provs, servers, skills] = await Promise.all([
        withAuthGuard(() => api.listAssistants(), logout),
        withAuthGuard(() => api.listLlmProviders(), logout),
        // Picker sources — failures degrade to empty lists (the dialog stays
        // usable; the sections say 暂无可用项).
        withAuthGuard(() => api.listMcpServers(), logout).catch(() => []),
        withAuthGuard(() => api.listResources({ kind: 'skill' }), logout).catch(() => []),
      ]);
      setItems(list);
      setProviders(provs);
      setMcpServers(servers);
      setSkillResources(skills);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  const providerById = useMemo(() => new Map(providers.map((p) => [p.id, p])), [providers]);
  /** The draft provider's chat models (the #51 registry — pick only). */
  const draftModels = useMemo(
    () => (providerById.get(draft.providerId)?.models ?? []).filter((m) => m.type === 'chat'),
    [providerById, draft.providerId],
  );

  function openCreate(): void {
    const first = providers[0];
    setDraft({
      ...EMPTY_DRAFT,
      providerId: first?.id ?? '',
      defaultModel: first?.models.find((m) => m.type === 'chat')?.id ?? '',
    });
    setEditing(null);
    setCreating(true);
  }

  function openEdit(a: AssistantConfigView): void {
    setDraft({
      name: a.name,
      description: a.description ?? '',
      providerId: a.providerId,
      defaultModel: a.defaultModel,
      systemPromptOverride: a.systemPromptOverride ?? '',
      enabledToolGroups: [...a.enabledToolGroups],
      mcpServerIds: [...(a.mcpServerIds ?? [])],
      skillResourceIds: [...(a.skillResourceIds ?? [])],
      dailyTokenBudget: a.dailyTokenBudget !== null ? String(a.dailyTokenBudget) : '',
    });
    setEditing(a);
    setCreating(true);
  }

  async function save(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const base = {
        name: draft.name.trim(),
        ...(draft.description.trim() !== '' ? { description: draft.description.trim() } : {}),
        providerId: draft.providerId,
        defaultModel: draft.defaultModel,
        ...(draft.systemPromptOverride.trim() !== ''
          ? { systemPromptOverride: draft.systemPromptOverride }
          : {}),
        enabledToolGroups: draft.enabledToolGroups as (typeof ASSISTANT_TOOL_GROUPS)[number][],
        mcpServerIds: draft.mcpServerIds,
        skillResourceIds: draft.skillResourceIds,
        ...(draft.dailyTokenBudget.trim() !== ''
          ? { dailyTokenBudget: Number(draft.dailyTokenBudget) }
          : {}),
      };
      // No JS budget guard here: the native min/step validation on
      // #asst-budget rejects invalid input at submit (localized browser
      // bubble) BEFORE onSubmit can run — a duplicate check would be dead.
      if (editing !== null) {
        await withAuthGuard(
          () =>
            api.updateAssistant(editing.id, {
              ...base,
              ...(draft.description.trim() === '' ? { description: null } : {}),
              ...(draft.systemPromptOverride.trim() === '' ? { systemPromptOverride: null } : {}),
              // clearing the field clears the budget (null = unlimited)
              ...(draft.dailyTokenBudget.trim() === '' ? { dailyTokenBudget: null } : {}),
            }),
          logout,
        );
        toast.success(t('assistants.savedToast'));
      } else {
        await withAuthGuard(() => api.createAssistant(base), logout);
        toast.success(t('assistants.createdToast'));
      }
      setCreating(false);
      await refresh();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete(): Promise<void> {
    if (pendingDelete === null) return;
    setBusy(true);
    try {
      await withAuthGuard(() => api.deleteAssistant(pendingDelete.id), logout);
      toast.success(t('assistants.deletedToast'));
      setPendingDelete(null);
      await refresh();
    } catch (e) {
      toast.error(e instanceof HarnessNexusError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const canSave =
    draft.name.trim() !== '' &&
    draft.providerId !== '' &&
    draft.defaultModel !== '' &&
    draft.enabledToolGroups.length > 0;

  return (
    <>
      <PageSlot slot="actions">
        <PageAction
          label={t('assistants.createButton')}
          disabled={providers.length === 0}
          onClick={openCreate}
        />
      </PageSlot>

      <PageIntro sub={t('assistants.subtitle')} />

      {providers.length === 0 && items !== null ? (
        <Note tone="warn">{t('llmProviders.empty')}</Note>
      ) : null}

      <DataTable
        columns={4}
        label={t('assistants.listTitle')}
        icon={<Wand2Icon />}
        state={tableState({
          error,
          loading: items === null,
          count: items?.length ?? 0,
        })}
        error={error}
        onRetry={() => void refresh()}
        empty={{
          title: t('assistants.empty'),
          hint: t('assistants.emptyHint'),
          action:
            providers.length > 0 ? (
              <Button onClick={openCreate} className="gap-1.5">
                <PlusIcon className="size-4" />
                {t('assistants.createButton')}
              </Button>
            ) : undefined,
        }}
      >
        <TableHeader>
          <TableRow>
            <TableHead>{t('common.name')}</TableHead>
            <TableHead>{t('assistants.colModel')}</TableHead>
            <TableHead>{t('assistants.colGroups')}</TableHead>
            <TableHead className="text-right">{t('common.actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items?.map((a) => {
            const provider = providerById.get(a.providerId);
            return (
              <TableRow key={a.id}>
                <TableCell>
                  <span className="font-medium">{a.name}</span>
                  {a.description !== undefined ? (
                    <span className="text-muted-foreground block truncate text-xs">
                      {a.description}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell>
                  <span className="text-muted-foreground block text-xs">
                    {provider?.name ?? '—'}
                  </span>
                  <span className="block font-mono text-xs">{a.defaultModel}</span>
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {a.enabledToolGroups.map((g) => (
                      <Badge key={g} variant="secondary" className="font-mono text-[10px]">
                        {g}
                      </Badge>
                    ))}
                  </div>
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
                      <DropdownMenuItem onClick={() => openEdit(a)}>
                        <PencilIcon /> {t('common.edit')}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onClick={() => setPendingDelete(a)}>
                        <TrashIcon /> {t('assistants.deleteButton')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </DataTable>

      <FormDialog
        open={creating}
        onClose={() => setCreating(false)}
        title={editing !== null ? t('assistants.editTitle') : t('assistants.createTitle')}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          className="flex flex-col gap-4"
        >
          <Field label={t('assistants.sectionBasic')} htmlFor="asst-name" required>
            <Input
              id="asst-name"
              value={draft.name}
              autoComplete="off"
              spellCheck={false}
              placeholder={t('assistants.namePlaceholder')}
              required
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            />
            <Input
              id="asst-desc"
              value={draft.description}
              placeholder={t('assistants.descriptionPlaceholder')}
              aria-label={t('assistants.descriptionLabel')}
              autoComplete="off"
              onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
            />
          </Field>
          <Field
            label={t('assistants.sectionModel')}
            htmlFor="asst-provider"
            hint={
              draft.providerId !== '' && draftModels.length === 0
                ? t('machineDetail.noModelsOnProvider')
                : undefined
            }
          >
            <div className="grid grid-cols-2 gap-2">
              <Select
                value={draft.providerId === '' ? undefined : draft.providerId}
                onValueChange={(v) => {
                  const prov = providerById.get(v);
                  setDraft((d) => ({
                    ...d,
                    providerId: v,
                    defaultModel: prov?.models.find((m) => m.type === 'chat')?.id ?? '',
                  }));
                }}
              >
                <SelectTrigger
                  id="asst-provider"
                  aria-label={t('assistants.providerLabel')}
                  className="w-full"
                >
                  <SelectValue placeholder={t('assistants.providerLabel')} />
                </SelectTrigger>
                <SelectContent>
                  {providers.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select
                // Remount per provider: inside a <form> Radix's hidden native
                // mirror echoes `''` back through onValueChange when the item
                // list empties and refills (provider switch), clobbering the
                // auto-picked model — a fresh mount starts with no echo.
                key={draft.providerId}
                value={draft.defaultModel === '' ? undefined : draft.defaultModel}
                onValueChange={(v) => setDraft((d) => ({ ...d, defaultModel: v }))}
                disabled={draftModels.length === 0}
              >
                <SelectTrigger
                  id="asst-model"
                  aria-label={t('assistants.modelLabel')}
                  className="w-full"
                >
                  <SelectValue placeholder={t('assistants.modelLabel')} />
                </SelectTrigger>
                <SelectContent>
                  {draftModels.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.displayName ?? m.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </Field>
          <Field label={t('assistants.groupsLabel')}>
            <div className="grid grid-cols-2 gap-1.5">
              {ASSISTANT_TOOL_GROUPS.map((g) => (
                <label key={g} className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={draft.enabledToolGroups.includes(g)}
                    onCheckedChange={(checked) =>
                      setDraft((d) => ({
                        ...d,
                        enabledToolGroups:
                          checked === true
                            ? [...d.enabledToolGroups, g]
                            : d.enabledToolGroups.filter((x) => x !== g),
                      }))
                    }
                  />
                  <span className="font-mono text-xs">{g}</span>
                </label>
              ))}
            </div>
          </Field>
          <Field label={t('assistants.mcpLabel')} hint={t('assistants.mcpHint')}>
            {mcpServers.length === 0 ? (
              <span className="text-muted-foreground text-xs">{t('assistants.noneAvailable')}</span>
            ) : (
              <div className="grid grid-cols-2 gap-1.5">
                {mcpServers.map((s) => {
                  const clientDialed = s.dialSite === 'client';
                  return (
                    <label
                      key={s.id}
                      className={
                        'flex items-center gap-2 text-sm' + (clientDialed ? ' opacity-50' : '')
                      }
                      title={clientDialed ? t('assistants.mcpHint') : undefined}
                    >
                      <Checkbox
                        disabled={clientDialed}
                        checked={draft.mcpServerIds.includes(s.id)}
                        onCheckedChange={(checked) =>
                          setDraft((d) => ({
                            ...d,
                            mcpServerIds:
                              checked === true
                                ? [...d.mcpServerIds, s.id]
                                : d.mcpServerIds.filter((x) => x !== s.id),
                          }))
                        }
                      />
                      <span className="truncate">{s.name}</span>
                      {clientDialed ? (
                        <span className="text-muted-foreground shrink-0 text-[10px]">
                          {t('assistants.mcpClientDial')}
                        </span>
                      ) : null}
                    </label>
                  );
                })}
              </div>
            )}
          </Field>
          <Field label={t('assistants.skillsLabel')} hint={t('assistants.skillsHint')}>
            {skillResources.length === 0 ? (
              <span className="text-muted-foreground text-xs">{t('assistants.noneAvailable')}</span>
            ) : (
              <div className="grid grid-cols-2 gap-1.5">
                {skillResources.map((r) => {
                  const external = r.source.type !== 'inline' && r.source.type !== 'inline-bundle';
                  return (
                    <label
                      key={r.id}
                      className={
                        'flex items-center gap-2 text-sm' + (external ? ' opacity-50' : '')
                      }
                      title={external ? t('assistants.skillsHint') : undefined}
                    >
                      <Checkbox
                        disabled={external}
                        checked={draft.skillResourceIds.includes(r.id)}
                        onCheckedChange={(checked) =>
                          setDraft((d) => ({
                            ...d,
                            skillResourceIds:
                              checked === true
                                ? [...d.skillResourceIds, r.id]
                                : d.skillResourceIds.filter((x) => x !== r.id),
                          }))
                        }
                      />
                      <span className="truncate">{r.name}</span>
                      {external ? (
                        <span className="text-muted-foreground shrink-0 text-[10px]">
                          {t('assistants.skillsExternal')}
                        </span>
                      ) : null}
                    </label>
                  );
                })}
              </div>
            )}
          </Field>
          <Field
            label={t('assistants.budgetLabel')}
            hint={t('assistants.budgetHint')}
            htmlFor="asst-budget"
          >
            <Input
              id="asst-budget"
              type="number"
              min={1}
              step={1}
              value={draft.dailyTokenBudget}
              autoComplete="off"
              inputMode="numeric"
              placeholder={t('assistants.budgetPlaceholder')}
              onChange={(e) => setDraft((d) => ({ ...d, dailyTokenBudget: e.target.value }))}
              className="max-w-48"
            />
          </Field>
          <Field
            label={t('assistants.sectionPrompt')}
            hint={t('assistants.promptHint')}
            htmlFor="asst-prompt"
          >
            <Textarea
              id="asst-prompt"
              value={draft.systemPromptOverride}
              rows={6}
              spellCheck={false}
              placeholder={t('assistants.promptLabel')}
              onChange={(e) => setDraft((d) => ({ ...d, systemPromptOverride: e.target.value }))}
              className="font-mono text-xs"
            />
            <DefaultPromptDisclosure />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setCreating(false)}>
              {t('assistants.cancel')}
            </Button>
            <Button type="submit" disabled={!canSave || busy}>
              {t('assistants.save')}
            </Button>
          </div>
        </form>
      </FormDialog>

      {pendingDelete !== null ? (
        <ConfirmDialog
          open
          title={t('assistants.deleteTitle')}
          consequence={t('assistants.deleteBody')}
          impact={[{ label: 'assistant', value: pendingDelete.name }]}
          actionLabel={t('assistants.deleteButton')}
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
