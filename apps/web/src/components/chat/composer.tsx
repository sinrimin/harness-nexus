import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpIcon,
  CircleStopIcon,
  ImageIcon,
  PaperclipIcon,
  PlusIcon,
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { DraftAttachment } from './image-attach.js';
import type {
  ChatConfigSetPayload,
  CommandView,
  PromptBlock,
  SessionConfigOption,
} from '@/realtime';

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

interface ComposerUsage {
  contextUsed?: number;
  contextSize?: number;
}

/** The fold's config slice — see fold.ts (patch-merged from session_config). */
export interface ComposerConfig {
  currentModeId?: string;
  availableModes?: { id: string; name: string; description?: string }[];
  configOptions?: SessionConfigOption[];
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
  /** From the ready push's promptCapabilities — gates the image attach item. */
  imageSupported: boolean;
  config: ComposerConfig;
  onConfigSet: (set: ChatConfigSetPayload) => void;
  /** 9 W15 — the agent's advertised slash commands (fold slice). */
  commands: CommandView[];
}

/** Mode ids that WEAKEN the permission gate — confirm before switching. */
const DANGEROUS_MODES = new Set(['bypassPermissions', 'full-access', 'auto']);

/** 1234 → "1.2k" · 64000 → "64k" · 130000 → "130k" · 1500000 → "1.5M". */
function formatTokens(n: number): string {
  const compact = (div: number): string => {
    const s = (n / div).toFixed(1);
    return `${s.endsWith('.0') ? s.slice(0, -2) : s}`;
  };
  if (n >= 1_000_000) return `${compact(1_000_000)}M`;
  if (n >= 1_000) return `${compact(1_000)}k`;
  return String(n);
}

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

/** Context pressure from the fold's usage slice — hidden when the target's
 *  adapter reports no occupancy. */
function ContextMeter({ usage }: { usage: ComposerUsage | null }) {
  const { t } = useI18n();
  const used = usage?.contextUsed;
  const size = usage?.contextSize;
  if (used === undefined || size === undefined || size <= 0) return null;
  const pct = Math.min(100, Math.max(0, (used / size) * 100));
  const tone = pct > 95 ? 'danger' : pct > 80 ? 'warn' : 'neutral';
  return (
    <span
      className="flex shrink-0 items-center gap-2 max-sm:order-9 max-sm:w-full"
      title={t('chat.contextUsed', { used: formatTokens(used), size: formatTokens(size) })}
    >
      <span
        className={cn(
          'text-muted-foreground font-mono text-[11px] tabular-nums',
          tone === 'warn' && 'text-warn',
          tone === 'danger' && 'text-danger',
        )}
      >
        {formatTokens(used)} / {formatTokens(size)}
      </span>
      {/* Slots + tone are data: the comp's meter is 62x7 with a steel fill,
          and a skin has to reach both without parsing utilities. */}
      <span
        data-slot="meter"
        data-tone={tone}
        className="bg-muted relative h-1 w-16 overflow-hidden rounded-full"
      >
        <span
          data-slot="meter-fill"
          data-tone={tone}
          className={cn(
            'absolute inset-y-0 left-0 rounded-full transition-[width] duration-300',
            tone === 'danger' ? 'bg-danger' : tone === 'warn' ? 'bg-warn' : 'bg-primary',
          )}
          style={{ width: `${pct}%` }}
        />
      </span>
    </span>
  );
}

interface SelectChoice {
  value: string;
  name: string;
  description?: string;
  group?: string;
}

/**
 * One borderless config select (the SessionConfigBar pattern). Values are
 * OPAQUE adapter keys — never parsed; `group` becomes a labeled group
 * (dsh's per-provider model lists).
 *
 * It is a labeled COLUMN, not a bare trigger: the comp's `.ctl` puts the
 * control's name above it (`Permission` / `Model` / `Effort` at 9.5px), which
 * is what makes three adjacent select windows readable when their values are
 * opaque words. The trigger itself rides `--control-h-sm`, so BAY's 25px
 * hardware scale applies (it was a hard 32px — "the dropdowns are almost half
 * the Sender", reported from a phone).
 */
function ConfigSelect({
  label,
  value,
  choices,
  disabled,
  hint,
  onPick,
}: {
  label: string;
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
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="role-label-sm text-muted-foreground">{label}</span>
      <Select
        value={value === undefined ? undefined : value}
        onValueChange={onPick}
        disabled={disabled}
      >
        <SelectTrigger
          size="sm"
          aria-label={label}
          title={
            hint ??
            (value === undefined
              ? label
              : (choices.find((c) => c.value === value)?.description ?? label))
          }
          className="text-muted-foreground hover:text-foreground min-w-0 max-w-40 gap-1 border-none px-1.5 text-xs font-normal shadow-none focus:ring-0 dark:hover:bg-accent/50"
        >
          <SelectValue placeholder={label} />
        </SelectTrigger>
        <SelectContent>
          {[...groups.entries()].map(([group, list]) =>
            group === '' ? (
              list.map((c) => (
                <SelectItem key={c.value} value={c.value} title={c.description}>
                  {c.name}
                </SelectItem>
              ))
            ) : (
              <SelectGroup key={group}>
                <SelectLabel>{group}</SelectLabel>
                {list.map((c) => (
                  <SelectItem key={c.value} value={c.value} title={c.description}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            ),
          )}
        </SelectContent>
      </Select>
    </span>
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
  onSend,
  onCancel,
  attachments,
  fileRefs,
  onRemoveAttachment,
  onRemoveFileRef,
  onPickImages,
  onOpenFilePicker,
  imageSupported,
  config,
  onConfigSet,
  commands,
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
  // `confirmMode` writes it through.
  const [pendingMode, setPendingMode] = useState<{ id: string; name: string } | null>(null);
  const pickMode = (modeId: string): void => {
    const name = modeChoices.find((c) => c.value === modeId)?.name ?? modeId;
    if (DANGEROUS_MODES.has(modeId)) {
      setPendingMode({ id: modeId, name });
      return;
    }
    onConfigSet({ kind: 'mode', modeId });
  };
  const confirmMode = (): void => {
    const next = pendingMode;
    if (next === null) return;
    setPendingMode(null);
    onConfigSet({ kind: 'mode', modeId: next.id });
  };

  return (
    <div
      className={cn(
        'bg-background focus-within:border-ring focus-within:ring-ring/50 relative rounded-xl border shadow-sm transition-[border-color,box-shadow] focus-within:ring-[3px]',
        disabled && 'opacity-60',
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
      {/* The toolbar WRAPS (comp `mobile.html` frame C: "the composer toolbar
          wraps"). Three opaque config values plus a meter plus Send do not fit
          a 390px phone, and a non-shrinkable row pushed the Send control off
          the screen — reported from a phone. Wrapping keeps every control
          reachable; the meter moves to its own row below the controls
          (comp `.ctools .ctx { width:100%; order:9 }`) and Send keeps the
          right edge of the row it lands on (`.round { margin-left:auto }`). */}
      <div className="flex flex-wrap items-end gap-x-2 gap-y-1.5 px-3 pb-2.5 pt-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-foreground size-7 shrink-0"
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
            <DropdownMenuItem disabled={disabled} onClick={onOpenFilePicker}>
              <PaperclipIcon className="size-4" />
              {t('chat.attachFile')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <ConfigSelect
          label={t('chat.modeLabel')}
          value={modeValue}
          choices={modeChoices}
          disabled={controlsDisabled}
          hint={turnActive ? t('chat.appliesNextTurn') : undefined}
          onPick={pickMode}
        />
        {modelOption === undefined ? null : (
          <ConfigSelect
            label={t('chat.modelLabel')}
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

        <span className="min-w-0 flex-1" />
        <ContextMeter usage={usage} />
        {turnActive ? (
          <>
            {/* #10 — a non-empty draft mid-turn offers Send (the message
                queues server-side) ALONGSIDE Stop; an empty draft is Stop
                only. Send keeps the primary look; Stop stays the outlined
                danger-leaning outline. */}
            {canSend ? (
              <Button
                type="button"
                size="icon"
                className="size-9 shrink-0 rounded-full max-sm:ml-auto max-sm:size-(--touch)"
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
              className="hover:border-destructive/40 hover:text-destructive size-9 shrink-0 rounded-full max-sm:size-(--touch)"
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
            className="size-9 shrink-0 rounded-full max-sm:ml-auto max-sm:size-(--touch)"
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
          consequence={t('chat.modeConsequence', { name: pendingMode.name })}
          impact={[{ label: 'mode', value: pendingMode.id }]}
          actionLabel={t('chat.modeSwitchAction')}
          // Danger edge without the irreversible line: flipping the mode back
          // restores the gate, so claiming "cannot be undone" would be false.
          tone="danger"
          irreversible={false}
          onConfirm={confirmMode}
        />
      ) : null}
    </div>
  );
}
