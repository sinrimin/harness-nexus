import { useEffect, useState } from 'react';
import { ChevronDownIcon, CircleXIcon, EraserIcon, Loader2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.js';
import { useI18n } from '@/i18n';
import { ConfirmDialog } from '@/components/kit';
import { StateSignal } from '@/components/state-signal';
import { cn } from '@/lib/utils.js';
import type { ChatChannelView } from '@/realtime.js';

/**
 * 9 W11 B — the live-channel tab strip. Rendered at the top of both chat
 * pages; hidden entirely when the user has no live channels (the common
 * case costs nothing). Data comes from the `chat:channels` snapshot pushes
 * (see use-chat-channels.ts) — never polled, always current.
 *
 * Tab semantics: click ACTIVATES (same agent → in-page channel switch that
 * keeps the previous channel alive; other agent → route + `?ch=` rejoin);
 * × closes that one channel; the broom menu closes everything (busy ones
 * defer) or just the idle ones (9 W11 D6).
 */

/** 9 W11 D6 — tabs idle for shorter than this show no age label (noise). */
const IDLE_LABEL_THRESHOLD_MS = 30 * 60 * 1000;

/** Short per-target badge text — the mono protocol string, never localized. */
function targetBadge(target: string): string {
  if (target === 'claude-code') return 'CC';
  if (target === 'deepseek') return 'DSH';
  if (target === 'opencode') return 'OC';
  return target.slice(0, 4).toUpperCase();
}

function tabLabel(channel: ChatChannelView): string {
  return channel.nativeSessionId?.slice(0, 8) ?? channel.sessionId.slice(0, 8);
}

/** Narrow relative age ("32m" / "2h") — compact enough for a tab. */
function idleAgeLabel(lastActiveAt: number | undefined, now: number, locale: string): string {
  const minutes = Math.max(0, Math.round((now - (lastActiveAt ?? 0)) / 60000));
  const rtf = new Intl.RelativeTimeFormat(locale, { style: 'narrow', numeric: 'auto' });
  if (minutes < 60) return rtf.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 24) return rtf.format(-hours, 'hour');
  return rtf.format(-Math.round(hours / 24), 'day');
}

interface ChannelTabsProps {
  channels: ChatChannelView[];
  activeSessionId: string;
  onActivate: (channel: ChatChannelView) => void;
  onClose: (channel: ChatChannelView) => void;
  /** Runs only after the confirm dialog is answered — return the ack's promise
   *  so the dialog can hold its confirm button busy while it runs. */
  onCleanup: (idleOnly: boolean) => Promise<void> | void;
}

export function ChannelTabs({
  channels,
  activeSessionId,
  onActivate,
  onClose,
  onCleanup,
}: ChannelTabsProps) {
  const { t, lang } = useI18n();
  // Idle-age labels advance with wall time; snapshot pushes only fire on
  // table changes. One slow tick while tabs are shown is plenty.
  const [now, setNow] = useState(() => Date.now());
  // P6 — the confirm lives HERE, next to the menu that opens it: both chat
  // pages render this component, so one dialog replaced two native prompts.
  const [cleanup, setCleanup] = useState<{ idleOnly: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (channels.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [channels.length]);
  if (channels.length === 0) return null;

  const busyCount = channels.filter((ch) => ch.busy).length;
  async function runCleanup(): Promise<void> {
    const pending = cleanup;
    if (pending === null) return;
    setBusy(true);
    try {
      await onCleanup(pending.idleOnly);
    } finally {
      setBusy(false);
      setCleanup(null);
    }
  }

  return (
    <div className="bg-sidebar/30 flex h-9 shrink-0 items-center gap-1 border-b px-2">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {channels.map((ch) => {
          const active = ch.sessionId === activeSessionId;
          const idleMs = now - (ch.lastActiveAt ?? ch.openedAt);
          const showIdleAge =
            ch.phase === 'ready' && !ch.busy && !ch.deferred && idleMs >= IDLE_LABEL_THRESHOLD_MS;
          return (
            <div
              key={ch.sessionId}
              className={cn(
                'group/tab flex max-w-52 shrink-0 items-center gap-1.5 rounded-md border px-2 py-1',
                active ? 'bg-background shadow-sm' : 'hover:bg-background/60 border-transparent',
              )}
            >
              <button
                type="button"
                className="flex min-w-0 items-center gap-1.5"
                onClick={() => onActivate(ch)}
                title={`${ch.target}${ch.nativeSessionId ? ' · ' + ch.nativeSessionId : ''}`}
              >
                <span className="bg-muted text-muted-foreground rounded px-1 font-mono text-[10px] leading-4">
                  {targetBadge(ch.target)}
                </span>
                {ch.phase === 'starting' ? (
                  <Loader2Icon className="text-muted-foreground size-3 shrink-0 animate-spin" />
                ) : null}
                <span
                  className={cn(
                    'truncate font-mono text-xs',
                    active ? 'text-foreground' : 'text-muted-foreground',
                    ch.deferred && 'opacity-70',
                  )}
                >
                  {tabLabel(ch)}
                </span>
                {ch.busy ? (
                  // #12 — running = a static green dot (ZCode-style); the
                  // accent-colored pulse stays on the page header, the tab
                  // keeps it quiet.
                  <StateSignal state="busy" aria-hidden className="size-1.5" />
                ) : null}
                {ch.deferred ? (
                  <span className="text-muted-foreground shrink-0 text-[10px]">
                    {t('chat.tabDeferred')}
                  </span>
                ) : null}
                {showIdleAge ? (
                  <span
                    className="text-muted-foreground nums shrink-0 text-[10px] opacity-70"
                    title={t('chat.tabIdleTitle')}
                  >
                    {idleAgeLabel(ch.lastActiveAt ?? ch.openedAt, now, lang)}
                  </span>
                ) : null}
              </button>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground shrink-0"
                onClick={() => onClose(ch)}
                title={t('chat.tabCloseAria', { id: tabLabel(ch) })}
                aria-label={t('chat.tabCloseAria', { id: tabLabel(ch) })}
              >
                <CircleXIcon className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground h-7 shrink-0 gap-1 px-2 text-xs"
            title={t('chat.tabsCleanupTitle')}
          >
            <EraserIcon className="size-3.5" />
            {t('chat.tabsCleanup')}
            <ChevronDownIcon className="size-3 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setCleanup({ idleOnly: false })}>
            {t('chat.tabsCleanupAll')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setCleanup({ idleOnly: true })}>
            {t('chat.tabsCleanupIdle')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {cleanup !== null ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => {
            if (!o) setCleanup(null);
          }}
          title={
            cleanup.idleOnly ? t('chat.tabsCleanupIdleAction') : t('chat.tabsCleanupAllAction')
          }
          consequence={
            cleanup.idleOnly
              ? t('chat.tabsCleanupIdleConsequence')
              : t('chat.tabsCleanupConsequence')
          }
          impact={[
            { label: 'channels', value: String(channels.length) },
            { label: 'busy', value: String(busyCount) },
          ]}
          actionLabel={
            cleanup.idleOnly ? t('chat.tabsCleanupIdleAction') : t('chat.tabsCleanupAllAction')
          }
          // Closing a channel is recoverable — reopening the conversation is one
          // click — so this is the ordinary tier: no danger edge, no claim of
          // irreversibility.
          tone="default"
          irreversible={false}
          busy={busy}
          onConfirm={() => void runCleanup()}
        />
      ) : null}
    </div>
  );
}
