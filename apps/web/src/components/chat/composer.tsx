// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowUpIcon,
  BotIcon,
  BoxIcon,
  BrainIcon,
  ChevronDownIcon,
  CircleStopIcon,
  ImageIcon,
  PaperclipIcon,
  PlusIcon,
  ShieldCheckIcon,
  SquareSlashIcon,
} from 'lucide-react';
import { useI18n } from '@/i18n';
import { ConfirmDialog } from '@/components/kit';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import type { DraftAttachment } from './image-attach.js';
import { ContextMeter, type ComposerUsage } from './context-meter.js';
import type {
  ChatConfigSetPayload,
  CommandView,
  PromptBlock,
  SessionConfigOption,
} from '@/realtime';

/**
 * #92 — the permissions popover: the agent's OWN modes on top (behavior
 * unchanged — DANGEROUS_MODES still confirms via the composer's held-pick),
 * the delegated-approvals switch below a divider. One control for one
 * concept ("everything about permissions lives under the shield"); the
 * Sender gains no new control. The trigger rides the bare ConfigSelect
 * contract — same `--control-h-sm` geometry, icon at every size, on phone
 * the icon-only square (the delegated state rides a dot on the shield) —
 * so the row of dropdowns stays one device in every skin.
 */
function PermissionsControl({
  modeValue,
  modeChoices,
  approvals,
  disabled,
  hint,
  onPickMode,
  onApprovalsToggle,
}: {
  modeValue: string | undefined;
  modeChoices: SelectChoice[];
  approvals: NonNullable<ComposerConfig['approvals']>;
  disabled: boolean;
  hint?: string;
  onPickMode: (modeId: string) => void;
  /** The composer-owned switch handler: enabling goes through the confirm. */
  onApprovalsToggle: (on: boolean) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const delegated = approvals.responder === 'delegated';
  // #95 — the axis is advertised even when no decision model resolves; the
  // switch is then disabled and points at the provider defaults instead of
  // hiding the capability entirely.
  const delegateReady = approvals.modelId !== undefined;
  const modeName = modeChoices.find((c) => c.value === modeValue)?.name ?? modeValue;
  // Modes that rarely surface a permission request make delegated moot —
  // say so instead of enforcing anything (the axes stay orthogonal).
  const quietMode = modeValue !== undefined && DANGEROUS_MODES.has(modeValue) ? true : false;
  const label =
    modeChoices.length > 0 ? (modeName ?? t('chat.modeLabel')) : t('chat.approvalsLabelShort');
  const pickMode = (modeId: string): void => {
    setOpen(false);
    onPickMode(modeId);
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="select-trigger"
          data-size="sm"
          data-variant="bare"
          aria-label={t('chat.permissionsControlLabel')}
          title={hint ?? t('chat.permissionsControlLabel')}
          disabled={disabled}
          className={cn(
            'text-muted-foreground hover:text-foreground',
            'inline-flex h-(--control-h-sm) items-center gap-1 rounded-md px-1.5 text-xs font-normal',
            'disabled:cursor-not-allowed disabled:opacity-50',
            // Narrow CONTAINER (#122): the same icon-only square as every
            // ConfigSelect — the label and chevron drop out, the dot keeps
            // the delegated state.
            '@max-2xl:min-w-(--control-h-sm) @max-2xl:justify-center @max-2xl:gap-0 @max-2xl:px-0',
          )}
        >
          <span className="relative shrink-0">
            <ShieldCheckIcon className="size-4" />
            {delegated ? (
              <span
                data-slot="approvals-dot"
                data-state={delegated ? 'delegated' : 'manual'}
                className="bg-primary absolute -right-0.5 -top-0.5 size-1.5 rounded-full"
                aria-hidden="true"
              />
            ) : null}
          </span>
          <span className="max-w-32 truncate @max-2xl:hidden">
            {label}
            {delegated ? (
              <span className="text-muted-foreground/80"> · {t('chat.approvalsBadge')}</span>
            ) : null}
          </span>
          <ChevronDownIcon
            aria-hidden="true"
            className="size-4 shrink-0 opacity-50 @max-2xl:hidden"
          />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        {modeChoices.length > 0 ? (
          <div className="border-b p-2">
            <p className="text-muted-foreground px-2 pb-1 text-[11px] font-medium">
              {t('chat.modeLabel')}
            </p>
            <div className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
              {modeChoices.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  onClick={() => pickMode(c.value)}
                  title={c.description}
                  className={cn(
                    'focus-visible:ring-ring/50 flex min-w-0 items-start gap-2 rounded-sm px-2 py-1.5 text-left text-xs',
                    'hover:bg-muted focus-visible:ring-[3px] focus-visible:outline-none',
                    c.value === modeValue && 'bg-muted font-medium',
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      'mt-0.5 size-2 shrink-0 rounded-full border',
                      c.value === modeValue
                        ? 'border-primary bg-primary'
                        : 'border-muted-foreground/40',
                    )}
                  />
                  <span className="min-w-0">
                    <span className="block truncate">{c.name}</span>
                    {c.description !== undefined ? (
                      <span className="text-muted-foreground block truncate text-[11px] font-normal">
                        {c.description}
                      </span>
                    ) : null}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <div className="flex items-start justify-between gap-3 p-3">
          <div className="min-w-0">
            <p className="text-xs font-medium">{t('chat.approvalsSwitchTitle')}</p>
            <p className="text-muted-foreground mt-0.5 text-[11px] leading-snug">
              {t('chat.approvalsSwitchDesc')}
            </p>
            {delegated && approvals.providerName !== undefined ? (
              <p className="text-muted-foreground/80 mt-1 truncate font-mono text-[10px]">
                {approvals.providerName}
                {approvals.modelId !== undefined ? `/${approvals.modelId}` : ''}
              </p>
            ) : null}
            {quietMode && !delegated ? (
              <p className="text-muted-foreground/80 mt-1 text-[10px]">
                {t('chat.approvalsQuietModeHint')}
              </p>
            ) : null}
          </div>
          <Switch
            aria-label={t('chat.approvalsSwitchTitle')}
            disabled={disabled || !delegateReady}
            checked={delegated}
            onCheckedChange={onApprovalsToggle}
          />
        </div>
        {!delegateReady ? (
          <p className="text-muted-foreground border-t px-3 pb-2.5 pt-2 text-[11px] leading-snug">
            {t('chat.approvalsNoModel')}{' '}
            <Link to="/llm-providers" className="text-signal underline underline-offset-2">
              {t('chat.approvalsConfigure')}
            </Link>
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/**
 * The chat Sender (Phase 9 W8; controls added 9 W9). One card: the attachment
 * preview row, the auto-growing textarea, and a toolbar carrying — left to
 * right — the "+" menu (image attach / file reference), the data-driven
 * session-config selects (permission mode / model / reasoning effort, each
 * rendered ONLY when the adapter advertised it), and right-aligned the
 * context meter + circular send/stop toggle. Presentational: the page owns
 * the draft, the attachments, and every action. The send control stays the
 * page's PRIMARY action; `--signal` stays reserved for the live-turn dot.
 */

/** The fold's config slice — see fold.ts (patch-merged from session_config). */
export interface ComposerConfig {
  currentModeId?: string;
  availableModes?: { id: string; name: string; description?: string }[];
  configOptions?: SessionConfigOption[];
  /** #92 — present when the machine has a decision provider configured. */
  approvals?: { responder: 'manual' | 'delegated'; providerName?: string; modelId?: string };
}

/** A pending file reference chip (`resource_link` once sent). */
export interface DraftFileRef {
  name: string;
  uri: string;
}

interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  phase: 'idle' | 'connecting' | 'ready' | 'closed';
  turnActive: boolean;
  usage: ComposerUsage | null;
  /**
   * #124 — an optional band UNDER the card's top edge (the session HUD on the
   * agent page): the Sender keeps its own rounded top, and the band peeks out
   * from behind it like a slider phone's upper body. The caller's band renders
   * its own in-flow spacer (the HUD does) and extends behind the card, so the
   * card's own background cuts the band's bottom into the requested concave
   * corners; the card's border and the assembly's shadow fall on the band at
   * the seam.
   */
  header?: ReactNode;
  /**
   * #124 — the agent session page's HUD owns the context reading, so the
   * toolbar meter is off there (one reading per composer, not two). The
   * assistant page keeps the meter (default true).
   */
  showContextMeter?: boolean;
  onSend: () => void;
  onCancel: () => void;
  // ---- 9 W9 ----
  attachments: DraftAttachment[];
  fileRefs: DraftFileRef[];
  onRemoveAttachment: (id: string) => void;
  onRemoveFileRef: (uri: string) => void;
  /** Images picked/pasted/dropped — the page compresses and appends. */
  onPickImages: (files: File[]) => void;
  onOpenFilePicker: () => void;
  /**
   * The assistant 端 has no workspace, so its + menu offers images only —
   * false hides the file-reference item. Defaults to true (machine ends).
   */
  filePickerAvailable?: boolean;
  /** From the ready push's promptCapabilities — gates the image attach item. */
  imageSupported: boolean;
  config: ComposerConfig;
  onConfigSet: (set: ChatConfigSetPayload) => void;
  /** #92 — switch the approvals responder (next-request effect). Optional —
   *  the assistant 端 has no approvals axis and omits it. */
  onApprovalsSet?: (responder: 'manual' | 'delegated') => void;
  /** 9 W15 — the agent's advertised slash commands (fold slice). */
  commands: CommandView[];
  /**
   * #108 — the assistant 端's decision-model availability (the #100
   * capabilities view). `undefined` = ungated (the machine 端, whose approvals
   * switch carries its own gating); `false` = the 模型代审 write policy
   * renders disabled with its reason instead of selectable-then-refused.
   */
  decisionReady?: boolean;
}

/** Mode ids that WEAKEN the permission gate — confirm before switching. */
const DANGEROUS_MODES = new Set(['bypassPermissions', 'full-access', 'auto']);

/** #10 — one-line preview of the parked queue chip's blocks. */
export function queuedPreview(blocks: PromptBlock[]): string {
  const parts: string[] = [];
  const text = blocks
    .filter((b): b is Extract<PromptBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text.trim())
    .filter((txt) => txt !== '')
    .join(' ');
  if (text !== '') parts.push(text);
  const files = blocks.filter((b) => b.type === 'resource_link').length;
  const images = blocks.filter((b) => b.type === 'image').length;
  if (files > 0) parts.push(`+${String(files)}📎`);
  if (images > 0) parts.push(`+${String(images)}🖼`);
  return parts.join(' ');
}

interface SelectChoice {
  value: string;
  name: string;
  description?: string;
  group?: string;
  /** #108 — the choice exists but cannot be picked (its reason rides `description`). */
  disabled?: boolean;
}

/**
 * One borderless config select (the SessionConfigBar pattern). Values are
 * OPAQUE adapter keys — never parsed; `group` becomes a labeled group
 * (dsh's per-provider model lists).
 *
 * Two shapes, because the phone has no room for three opaque values plus a
 * meter plus Send: the control's ICON rides at every size (one glyph per
 * dropdown, so the row reads as controls, not words); from `sm` up the value
 * and chevron join it, below it the icon is the whole square (the picker is
 * where the current value is read — the selected
 * row carries the check) at the compact control's size, with the fingertip
 * supplied by an overlay hit area rather than a bigger box. Naming the three
 * with a label above each was tried and rejected in review: it made an
 * already-tight strip taller, which is the opposite of the point. The trigger
 * rides `--control-h-sm`, so BAY's 25px hardware scale applies.
 *
 * It is `variant="bare"`: the value or the icon, no field around it. That is
 * the whole control in BOTH skins — the report was "无论主题，都只显示文字或图标，
 * 不要底色和边框了" — so the exemption has to be a variant the skin can read,
 * not utilities the skin out-votes (ui/select.tsx, skins/bay/skin.css).
 */
function ConfigSelect({
  label,
  icon,
  value,
  choices,
  disabled,
  hint,
  onPick,
}: {
  label: string;
  /** The adapter's control as an icon — always visible, the phone's whole trigger. */
  icon: ReactNode;
  value: string | undefined;
  choices: SelectChoice[];
  disabled: boolean;
  /** Overrides the trigger title (e.g. the mid-turn "applies next turn" note). */
  hint?: string;
  onPick: (value: string) => void;
}) {
  if (choices.length === 0) return null;
  const groups = new Map<string, SelectChoice[]>();
  for (const c of choices) {
    const key = c.group ?? '';
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [c]);
    else list.push(c);
  }
  return (
    <Select
      value={value === undefined ? undefined : value}
      onValueChange={onPick}
      disabled={disabled}
    >
      <SelectTrigger
        size="sm"
        variant="bare"
        aria-label={label}
        title={
          hint ??
          (value === undefined
            ? label
            : (choices.find((c) => c.value === value)?.description ?? label))
        }
        className={cn(
          'text-muted-foreground hover:text-foreground min-w-0 max-w-40 gap-1 px-1.5 text-xs font-normal',
          // Narrow CONTAINER: one compact square per control (#122 moved this
          // from the viewport to the composer's own @container — a 900px
          // window with rail+plate visible is phone-narrow HERE). The trigger
          // keeps the compact control height and drops the chevron (the icon
          // IS the affordance) and the value (the picker states it, check
          // included). Its fingertip comes from the hit-area rule in
          // index.css, so the visual stays as dense as the reference row.
          '@max-2xl:min-w-(--control-h-sm) @max-2xl:max-w-none @max-2xl:justify-center @max-2xl:gap-0 @max-2xl:px-0',
          // The base rules for these two slots are `*:` selectors (more
          // specific than a bare utility), so the compact hiding has to name
          // them too.
          '@max-2xl:[&_[data-slot=select-value]]:hidden @max-2xl:[&_[data-slot=select-chevron]]:hidden',
        )}
      >
        <span className="shrink-0" aria-hidden="true">
          {icon}
        </span>
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        {[...groups.entries()].map(([group, list]) =>
          group === '' ? (
            list.map((c) => (
              <SelectItem key={c.value} value={c.value} title={c.description} disabled={c.disabled}>
                {c.name}
              </SelectItem>
            ))
          ) : (
            <SelectGroup key={group}>
              <SelectLabel>{group}</SelectLabel>
              {list.map((c) => (
                <SelectItem
                  key={c.value}
                  value={c.value}
                  title={c.description}
                  disabled={c.disabled}
                >
                  {c.name}
                </SelectItem>
              ))}
            </SelectGroup>
          ),
        )}
      </SelectContent>
    </Select>
  );
}

/**
 * 9 W15 — the `/`-prefix slash-command palette (portal-reference shape).
 * Opens while the draft starts with `/` and the agent advertised commands;
 * the FIRST word filters (name OR description). Keyboard: ↑/↓ cycle, Esc
 * dismisses, bare Enter and Tab SELECT (fill `/name `, dismiss the palette —
 * the user reviews the filled text, then a second Enter sends), Enter with
 * args falls through to the normal send. NO fallback table: an agent that
 * never pushed commands shows no palette.
 */
function CommandPalette({
  commands,
  activeIdx,
  onPick,
  onHover,
}: {
  commands: CommandView[];
  activeIdx: number;
  onPick: (c: CommandView) => void;
  onHover: (idx: number) => void;
}) {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${activeIdx}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);
  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={t('chat.commandsAria')}
      className="bg-background absolute bottom-full left-0 right-0 z-20 mb-2 max-h-64 overflow-y-auto rounded-xl border shadow-lg"
    >
      {commands.length === 0 ? (
        <p className="text-muted-foreground px-3 py-2.5 text-xs">{t('chat.commandsNone')}</p>
      ) : (
        commands.map((c, i) => (
          <button
            key={c.name}
            type="button"
            role="option"
            data-idx={i}
            aria-selected={i === activeIdx}
            onClick={() => onPick(c)}
            onMouseEnter={() => onHover(i)}
            className={cn(
              'flex w-full items-start gap-2.5 px-3 py-2 text-left text-xs',
              i === activeIdx ? 'bg-accent' : 'hover:bg-accent/50',
            )}
          >
            <SquareSlashIcon className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="font-mono font-medium">/{c.name}</span>
              {c.hint !== undefined && c.hint !== '' ? (
                <span className="text-muted-foreground/70 font-mono"> {c.hint}</span>
              ) : null}
              {c.description !== '' ? (
                <span className="text-muted-foreground block truncate" title={c.description}>
                  {c.description}
                </span>
              ) : null}
            </span>
          </button>
        ))
      )}
    </div>
  );
}

export function Composer({
  value,
  onChange,
  phase,
  turnActive,
  usage,
  header,
  showContextMeter = true,
  onSend,
  onCancel,
  attachments,
  fileRefs,
  onRemoveAttachment,
  onRemoveFileRef,
  onPickImages,
  onOpenFilePicker,
  filePickerAvailable = true,
  imageSupported,
  config,
  onConfigSet,
  onApprovalsSet = () => {},
  commands,
  decisionReady,
}: ComposerProps) {
  const { t } = useI18n();
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const disabled = phase !== 'ready';
  // #10 — the selects stay WRITABLE mid-turn: every target accepts the write
  // (server+daemon forward config.set unconditionally); the running turn
  // keeps its pinned config, so the honest contract is "applies from the
  // next turn" — surfaced as the trigger hint below.
  const controlsDisabled = disabled;
  const canSend =
    !disabled && (value.trim() !== '' || attachments.length > 0 || fileRefs.length > 0);

  // 9 W15 — the `/` palette: open while the draft starts with '/', the agent
  // advertised commands, the channel is usable, and the user hasn't dismissed
  // it for this draft. The first word after '/' filters (portal-reference).
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  // #9 — the keyword a commit just filled. The keyword effect reopens the
  // palette on every NEW keyword; a commit must not be undone by the very
  // keyword it produced, so it marks the filled keyword here.
  const pickedKeywordRef = useRef<string | null>(null);
  const slashDraft = value.startsWith('/') && !controlsDisabled && commands.length > 0;
  const keyword = useMemo(() => value.slice(1).split(/\s/)[0]?.toLowerCase() ?? '', [value]);
  const filteredCommands = useMemo(() => {
    if (!slashDraft) return [];
    if (keyword === '') return commands;
    return commands.filter(
      (c) =>
        c.name.toLowerCase().includes(keyword) || c.description.toLowerCase().includes(keyword),
    );
  }, [commands, keyword, slashDraft]);
  const paletteOpen = slashDraft && !paletteDismissed;
  const hasArg = /\s/.test(value.slice(1));
  useEffect(() => {
    if (pickedKeywordRef.current === keyword) {
      pickedKeywordRef.current = null;
      return;
    }
    setPaletteDismissed(false);
  }, [keyword]);
  useEffect(() => {
    if (activeIdx >= filteredCommands.length) setActiveIdx(0);
  }, [filteredCommands.length, activeIdx]);
  const pickCommand = (c: CommandView): void => {
    onChange(`/${c.name} `);
    pickedKeywordRef.current = c.name.toLowerCase();
    // #9 — every commit (Tab/Enter/click) dismisses; the filled text in the
    // Sender is the review affordance, the lingering list is noise.
    setPaletteDismissed(true);
    textRef.current?.focus();
  };

  // Autogrow: 1 row resting, ~10 rows max, then scroll internally.
  useEffect(() => {
    const el = textRef.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  const placeholder =
    phase === 'connecting'
      ? t('chat.connecting')
      : phase === 'closed'
        ? t('chat.closed')
        : t('chat.placeholderReady');

  // ---- the three data-driven selects (render nothing when absent) ----
  const modeFromOptions = config.configOptions?.find((o) => o.category === 'mode');
  const modelOption = config.configOptions?.find((o) => o.category === 'model');
  const effortOption = config.configOptions?.find((o) => o.category === 'thought_level');
  // #52 — the assistant 端 rides the same option surface with OPAQUE extra
  // selects (e.g. configId 'agent'): every option in no known category
  // renders as a generic labeled select, values compared by equality only.
  // #79's permissionMode is special-cased below (localized labels + a
  // designed confirm on the weakening pick), so it leaves this pool.
  const extraOptions = (config.configOptions ?? []).filter(
    (o) => o.category === undefined && o.id !== 'model' && o.id !== 'permissionMode',
  );
  // #79 — the assistant session's write-policy switch (the config's value is
  // only the default). Choice names localize by VALUE — the two declared
  // modes — while the wire stays opaque.
  const permOption = config.configOptions?.find((o) => o.id === 'permissionMode');
  const permName = (value: string, wire: string): string =>
    value === 'prompt'
      ? t('assistants.permPrompt')
      : value === 'autoWrite'
        ? t('assistants.permAutoWrite')
        : value === 'delegated'
          ? t('assistants.permDelegated')
          : wire;
  const permChoices: SelectChoice[] =
    permOption?.options?.map((o) => ({
      value: o.value,
      name: permName(o.value, o.name),
      description: o.description,
      // #108 — an unavailable delegation must not present as pickable: the
      // choice stays listed (discoverability) but disabled with its reason,
      // mirroring the machine 端's approvals switch. The server's
      // ASSISTANT_APPROVALS_NO_PROVIDER refusal remains the backstop for the
      // render→pick race.
      ...(decisionReady === false && o.value === 'delegated'
        ? {
            disabled: true,
            description: t('assistants.permNoModel'),
          }
        : {}),
    })) ?? [];
  const modeChoices: SelectChoice[] =
    modeFromOptions?.options?.map((o) => ({
      value: o.value,
      name: o.name,
      description: o.description,
    })) ??
    config.availableModes?.map((m) => ({
      value: m.id,
      name: m.name,
      description: m.description,
    })) ??
    [];
  const modeValue = modeFromOptions?.currentValue ?? config.currentModeId;

  // P6 — a mode that weakens the permission gate is confirmed in a designed
  // dialog instead of a native prompt: the pick is held here, and only
  // `confirmMode` writes it through. #79 — the assistant's `autoWrite` policy
  // weakens the same gate, so it rides the same held-pick confirm.
  const [pendingMode, setPendingMode] = useState<{
    kind: 'mode' | 'permission' | 'approvals' | 'perm-delegated';
    value: string;
    name: string;
  } | null>(null);
  const pickMode = (modeId: string): void => {
    const name = modeChoices.find((c) => c.value === modeId)?.name ?? modeId;
    if (DANGEROUS_MODES.has(modeId)) {
      setPendingMode({ kind: 'mode', value: modeId, name });
      return;
    }
    onConfigSet({ kind: 'mode', modeId });
  };
  const pickPermission = (value: string): void => {
    if (permOption === undefined) return;
    if (value === 'autoWrite' && permOption.currentValue !== 'autoWrite') {
      setPendingMode({ kind: 'permission', value, name: permName(value, value) });
      return;
    }
    // #95 follow-up — handing answers to a decision model delegates the
    // owner's authority; same designed confirm as the chat switch.
    if (value === 'delegated' && permOption.currentValue !== 'delegated') {
      setPendingMode({ kind: 'perm-delegated', value, name: permName(value, value) });
      return;
    }
    onConfigSet({ kind: 'option', configId: permOption.id, value });
  };
  const confirmMode = (): void => {
    const next = pendingMode;
    if (next === null) return;
    setPendingMode(null);
    if (next.kind === 'mode') {
      onConfigSet({ kind: 'mode', modeId: next.value });
    } else if (next.kind === 'approvals') {
      // #92 — enabling delegated approvals delegates the owner's answering
      // authority; the same designed confirm as a weakening mode pick.
      onApprovalsSet('delegated');
    } else if (next.kind === 'perm-delegated') {
      // #95 follow-up — the assistant's third write policy: same authority
      // hand-off, expressed on the sender's permissionMode option.
      onConfigSet({ kind: 'option', configId: 'permissionMode', value: next.value });
    } else {
      onConfigSet({ kind: 'option', configId: 'permissionMode', value: next.value });
    }
  };

  return (
    <div
      data-slot="composer-shell"
      className={cn(
        // #124 — ONE device shadow and ONE focus ring for the assembly. The
        // shell's border box IS the union silhouette (the band's rounded top
        // joined to the card's rounded bottom at the same width), so a single
        // shadow-sm / ring here covers the band and the Sender together; the
        // card keeps only its border (which carves the concave seam).
        'relative rounded-xl shadow-sm transition-[box-shadow] focus-within:ring-ring/50 focus-within:ring-[3px]',
        disabled && 'opacity-60',
      )}
    >
      {/* #124 — the band behind the Sender's top edge. It is an in-flow sibling
          BEFORE the card (the HUD carries its own 26px spacer), so the card's
          opaque background + border-radius cut the band into the concave
          corners: the Sender stays a full rounded rectangle on top, the band
          slides out from under it. */}
      {header !== undefined ? <div>{header}</div> : null}

      <div
        data-slot="composer"
        className={cn(
          // #122 — the composer is its own container: what fits the toolbar
          // tracks THIS element's width, not the viewport (at 900px the rail
          // and the plate both eat width, so the viewport said "desktop" while
          // the toolbar was phone-narrow and wrapped). The config controls and
          // Send key their compact shape off @max-* container queries below.
          '@container bg-background focus-within:border-ring relative rounded-xl border transition-[border-color]',
          dragOver && 'border-ring',
        )}
        onDragOver={(e) => {
          if (disabled || !imageSupported) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          setDragOver(false);
          if (disabled || !imageSupported) return;
          e.preventDefault();
          const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
          if (files.length > 0) onPickImages(files);
        }}
      >
        {/* Hidden input behind the "+" menu's image item. */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          className="hidden"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (files.length > 0) onPickImages(files);
          }}
        />

        {attachments.length > 0 || fileRefs.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 px-3.5 pt-3">
            {fileRefs.map((f) => (
              <span
                key={f.uri}
                className="bg-muted inline-flex max-w-56 items-center gap-1 rounded-md px-2 py-1 font-mono text-xs"
                title={f.uri}
              >
                <PaperclipIcon className="size-3 shrink-0" />
                <span className="truncate">@{f.name}</span>
                <button
                  type="button"
                  onClick={() => onRemoveFileRef(f.uri)}
                  className="text-muted-foreground hover:text-foreground ml-0.5 shrink-0"
                  aria-label={t('chat.removeAttachment', { name: f.name })}
                >
                  ×
                </button>
              </span>
            ))}
            {attachments.map((a) => (
              <span
                key={a.id}
                className="bg-muted relative inline-flex items-center gap-1 rounded-md p-1"
                title={a.name}
              >
                <img
                  src={`data:${a.mimeType};base64,${a.data}`}
                  alt={a.name}
                  className="size-12 rounded object-cover"
                />
                <button
                  type="button"
                  onClick={() => onRemoveAttachment(a.id)}
                  className="bg-background/90 text-foreground absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full border text-[10px] leading-none"
                  aria-label={t('chat.removeAttachment', { name: a.name })}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}

        {paletteOpen ? (
          <CommandPalette
            commands={filteredCommands}
            activeIdx={activeIdx}
            onPick={pickCommand}
            onHover={setActiveIdx}
          />
        ) : null}

        <textarea
          ref={textRef}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // 9 W15 — the palette owns the keys first while open (portal
            // reference): arrows cycle, Esc dismisses, a bare Enter SELECTS;
            // Enter WITH args (space after the first word) falls through to
            // the ordinary send. IME composition guards as everywhere else.
            if (paletteOpen && filteredCommands.length > 0 && !e.nativeEvent.isComposing) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveIdx((i) => (i + 1) % filteredCommands.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveIdx((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setPaletteDismissed(true);
                return;
              }
              // #9 — Tab commits the active command into the Sender (fills
              // `/name `, focus stays) and dismisses the palette.
              if (e.key === 'Tab' && !e.shiftKey) {
                e.preventDefault();
                const cmd = filteredCommands[activeIdx];
                if (cmd !== undefined) pickCommand(cmd);
                return;
              }
              if (e.key === 'Enter' && !e.shiftKey && !hasArg) {
                e.preventDefault();
                const cmd = filteredCommands[activeIdx];
                if (cmd !== undefined) pickCommand(cmd);
                return;
              }
            } else if (paletteOpen && e.key === 'Escape' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              setPaletteDismissed(true);
              return;
            }
            // Enter sends, Shift+Enter breaks the line; a composing Enter (IME
            // candidate confirm) must never send.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              onSend();
            }
          }}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files).filter((f) =>
              f.type.startsWith('image/'),
            );
            if (files.length > 0 && imageSupported && !disabled) {
              e.preventDefault();
              onPickImages(files);
            }
          }}
          placeholder={placeholder}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          className="placeholder:text-muted-foreground max-h-56 w-full resize-none overflow-y-auto bg-transparent px-3.5 pb-1 pt-3 text-sm leading-relaxed outline-none disabled:cursor-not-allowed"
        />
        {/* The toolbar is ONE row, on the baseline of its TALLEST control.
          #122 — wrapping is gone: the row's width is the composer's own
          @container, and below ~672px of it the config controls collapse to
          their icon squares and the meter is the ring plus its percentage
          (#123), which is how four controls plus a meter plus Send fit one
          line on a 390px phone — and,
          identically, on a browser-zoomed desktop whose rail and plate have
          eaten the width (the viewport said "desktop" while this toolbar was
          phone-narrow; at 900px the old row wrapped Send onto its own line).
          `items-end` because the row is not a line of text: the config words
          sit ON the Send's baseline, and centring them against a taller button
          floated them a few pixels above the card's bottom edge ("下拉菜单离
          下边距特别远", #23). */}
        <div data-slot="composer-tools" className="flex items-end gap-2 px-3 pb-2.5 pt-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                data-tool="attach"
                className="text-muted-foreground hover:text-foreground size-(--control-h-sm) shrink-0"
                disabled={disabled}
                title={t('chat.addMenuAria')}
                aria-label={t('chat.addMenuAria')}
              >
                <PlusIcon className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuItem
                disabled={!imageSupported}
                title={imageSupported ? undefined : t('chat.imageUnsupported')}
                onClick={() => fileInputRef.current?.click()}
              >
                <ImageIcon className="size-4" />
                {t('chat.attachImage')}
              </DropdownMenuItem>
              {filePickerAvailable ? (
                <DropdownMenuItem disabled={disabled} onClick={onOpenFilePicker}>
                  <PaperclipIcon className="size-4" />
                  {t('chat.attachFile')}
                </DropdownMenuItem>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>

          {config.approvals === undefined ? (
            <ConfigSelect
              label={t('chat.modeLabel')}
              icon={<ShieldCheckIcon className="size-4" />}
              value={modeValue}
              choices={modeChoices}
              disabled={controlsDisabled}
              hint={turnActive ? t('chat.appliesNextTurn') : undefined}
              onPick={pickMode}
            />
          ) : (
            <PermissionsControl
              modeValue={modeValue}
              modeChoices={modeChoices}
              approvals={config.approvals}
              disabled={controlsDisabled}
              hint={turnActive ? t('chat.appliesNextTurn') : undefined}
              onPickMode={pickMode}
              onApprovalsToggle={(on) => {
                if (on) {
                  setPendingMode({
                    kind: 'approvals',
                    value: 'delegated',
                    name: t('chat.approvalsSwitchTitle'),
                  });
                } else {
                  onApprovalsSet('manual');
                }
              }}
            />
          )}
          {permOption === undefined ? null : (
            <ConfigSelect
              label={t('chat.permModeLabel')}
              icon={<ShieldCheckIcon className="size-4" />}
              value={permOption.currentValue}
              choices={permChoices}
              disabled={controlsDisabled}
              hint={turnActive ? t('chat.appliesNextTurn') : undefined}
              onPick={pickPermission}
            />
          )}
          {modelOption === undefined ? null : (
            <ConfigSelect
              label={t('chat.modelLabel')}
              icon={<BoxIcon className="size-4" />}
              value={modelOption.currentValue}
              choices={
                modelOption.options?.map((o) => ({
                  value: o.value,
                  name: o.name,
                  description: o.description,
                  group: o.group,
                })) ?? []
              }
              disabled={controlsDisabled}
              hint={turnActive ? t('chat.appliesNextTurn') : undefined}
              onPick={(v) => onConfigSet({ kind: 'option', configId: modelOption.id, value: v })}
            />
          )}
          {effortOption === undefined ? null : (
            <ConfigSelect
              label={t('chat.effortLabel')}
              icon={<BrainIcon className="size-4" />}
              value={effortOption.currentValue}
              choices={
                effortOption.options?.map((o) => ({
                  value: o.value,
                  name: o.name,
                  description: o.description,
                })) ?? []
              }
              disabled={controlsDisabled}
              hint={turnActive ? t('chat.appliesNextTurn') : undefined}
              onPick={(v) => onConfigSet({ kind: 'option', configId: effortOption.id, value: v })}
            />
          )}

          {extraOptions.map((opt) => (
            <ConfigSelect
              key={opt.id}
              label={opt.name}
              icon={<BotIcon className="size-4" />}
              value={opt.currentValue}
              choices={
                opt.options?.map((o) => ({
                  value: o.value,
                  name: o.name,
                  description: o.description,
                  group: o.group,
                })) ?? []
              }
              disabled={controlsDisabled}
              hint={turnActive ? t('chat.appliesNextTurn') : undefined}
              onPick={(v) => onConfigSet({ kind: 'option', configId: opt.id, value: v })}
            />
          ))}

          <span className="min-w-0 flex-1" />
          {showContextMeter ? <ContextMeter usage={usage} /> : null}
          {turnActive ? (
            <>
              {/* #10 — a non-empty draft mid-turn offers Send (the message
                queues server-side) ALONGSIDE Stop; an empty draft is Stop
                only. Send keeps the primary look; Stop stays the outlined
                danger-leaning outline. Both are the SAME shape as the config
                controls they sit beside — a rounded square on the control
                height, not the comp's 40px circle: the circle was a head taller
                than its own toolbar (#23), and on a phone the fingertip is
                served by `--touch` without the desktop row growing with it. */}
              {canSend ? (
                <Button
                  type="button"
                  size="icon"
                  className="@max-2xl:size-(--touch) size-(--control-h) shrink-0 rounded-md"
                  onClick={onSend}
                  title={t('chat.queueSendAria')}
                  aria-label={t('chat.queueSendAria')}
                >
                  <ArrowUpIcon className="size-4" />
                </Button>
              ) : null}
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="hover:border-destructive/40 hover:text-destructive @max-2xl:size-(--touch) size-(--control-h) shrink-0 rounded-md"
                onClick={onCancel}
                title={t('chat.stopAria')}
                aria-label={t('chat.stopAria')}
              >
                <CircleStopIcon className="size-4" />
              </Button>
            </>
          ) : (
            <Button
              type="button"
              size="icon"
              className="@max-2xl:size-(--touch) size-(--control-h) shrink-0 rounded-md"
              onClick={onSend}
              disabled={!canSend}
              title={t('chat.sendAria')}
              aria-label={t('chat.sendAria')}
            >
              <ArrowUpIcon className="size-4" />
            </Button>
          )}
        </div>

        {pendingMode !== null ? (
          <ConfirmDialog
            open
            onOpenChange={(o) => {
              if (!o) setPendingMode(null);
            }}
            title={t('chat.modeSwitchAction')}
            consequence={
              pendingMode.kind === 'mode'
                ? t('chat.modeConsequence', { name: pendingMode.name })
                : pendingMode.kind === 'approvals'
                  ? t('chat.approvalsConsequence')
                  : pendingMode.kind === 'perm-delegated'
                    ? t('chat.permDelegatedConsequence')
                    : t('chat.permConsequence', { name: pendingMode.name })
            }
            impact={[
              {
                label:
                  pendingMode.kind === 'mode'
                    ? 'mode'
                    : pendingMode.kind === 'approvals'
                      ? 'approvals'
                      : 'write policy',
                value: pendingMode.value,
              },
            ]}
            actionLabel={t('chat.modeSwitchAction')}
            // Danger edge without the irreversible line: flipping the mode back
            // restores the gate, so claiming "cannot be undone" would be false.
            tone="danger"
            irreversible={false}
            onConfirm={confirmMode}
          />
        ) : null}
      </div>
    </div>
  );
}
