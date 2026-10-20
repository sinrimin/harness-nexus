// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { PlusIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * #54 — the rich welcome both chat pages render while NO session is open:
 * a big greeting, the new-session action, and the most recent sessions as a
 * vertical card list (title / workspace for client agents / relative time).
 * The sender stays HIDDEN in this state — the button and the cards are the
 * only entry points. Desktop keeps ~5 cards, phones ~3 (excess cards are
 * hidden below md, not sliced away, so one list serves both widths).
 */

export interface WelcomeCard {
  id: string;
  title: string;
  /** Client-agent sessions show their workspace cwd; assistants none. */
  workspace?: string;
  /** Preformatted relative label ("1 天前") — the caller owns the locale. */
  timeLabel: string;
  onClick: () => void;
}

export function WelcomePane({
  greeting,
  sub,
  actionLabel,
  onAction,
  cards,
  desktopCount = 5,
  mobileCount = 3,
}: {
  greeting: string;
  sub?: string;
  actionLabel: string;
  onAction: () => void;
  cards: WelcomeCard[];
  desktopCount?: number;
  mobileCount?: number;
}) {
  const shown = cards.slice(0, desktopCount);
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
      <div className="flex w-full max-w-xl flex-col items-center gap-6 py-8">
        <div className="flex flex-col items-center gap-2 text-center">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">{greeting}</h2>
          {sub !== undefined ? <p className="text-muted-foreground text-sm">{sub}</p> : null}
        </div>
        <Button size="lg" className="gap-1.5" onClick={onAction}>
          <PlusIcon className="size-4" />
          {actionLabel}
        </Button>
        {shown.length > 0 ? (
          <div className="flex w-full flex-col gap-2">
            {shown.map((c, i) => (
              <button
                key={c.id}
                type="button"
                onClick={c.onClick}
                // Phones keep only the top mobileCount cards — height is the
                // constraint there; desktop shows the full slice.
                className={cn(
                  'hover:bg-tray/60 flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left',
                  i >= mobileCount && 'max-md:hidden',
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{c.title}</span>
                  {c.workspace !== undefined && c.workspace !== '' ? (
                    <span className="text-muted-foreground block truncate font-mono text-xs">
                      {c.workspace}
                    </span>
                  ) : null}
                </span>
                <span className="text-muted-foreground nums shrink-0 text-xs">{c.timeLabel}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
