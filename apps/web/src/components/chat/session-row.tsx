// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { ReactNode } from 'react';
import { PinIcon, TrashIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { SwipeRow } from './swipe-row';

/**
 * #55 — the shared row affordances for session-rail rows. Desktop: a trash
 * that fades in on row hover. Phone: the same row wrapped in a swipe reveal.
 * `onDelete` undefined = no delete affordance at all (a live channel holds
 * the row — the server would refuse the delete, so the row must not offer
 * it).
 *
 * #110 — a leading PIN slot, symmetric with the trash: pinned rows carry a
 * persistent solid pin, unpinned rows show a faint one on hover. The row's
 * 30px left inset reserves the space, so the title never shifts (the trash
 * reserve's no-shift discipline). Pinning is not a connection state: muted
 * ink, never the semantic palette. `trailing` (assistant rows) puts a menu
 * in the right slot INSTEAD of the trash — delete lives inside it there.
 * The phone's pin is the right-swipe reveal.
 */
export function SessionRow({
  onDelete,
  deleteLabel,
  pinned = false,
  pinLabel,
  onTogglePin,
  trailing,
  children,
}: {
  onDelete?: () => void;
  /** The trash's aria/title — the same words as the confirm dialog's action. */
  deleteLabel: string;
  pinned?: boolean;
  /** The pin's aria/title — pin or unpin, the caller's word. */
  pinLabel?: string;
  onTogglePin?: () => void;
  /** The desktop right-slot menu; replaces the hover trash. */
  trailing?: ReactNode;
  /** The rail's row button, verbatim — this shell never restructures it. */
  children: ReactNode;
}) {
  const canPin = onTogglePin !== undefined && pinLabel !== undefined;
  if (onDelete === undefined && !canPin && trailing === undefined) return <>{children}</>;
  return (
    <div className="group/row relative">
      {canPin ? (
        <button
          type="button"
          className={cn(
            'absolute top-1/2 left-[9px] z-10 hidden -translate-y-1/2 md:flex',
            pinned
              ? 'text-muted-foreground hover:text-foreground'
              : 'text-muted-foreground/60 hover:text-foreground opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100',
          )}
          aria-pressed={pinned}
          aria-label={pinLabel}
          title={pinLabel}
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin();
          }}
        >
          <PinIcon className={cn('size-3', pinned && 'fill-current')} />
        </button>
      ) : null}
      {/* Desktop right slot. #99 review — it rides the row's vertical center
      and keeps the SAME right margin as the folder header's `+` (12px),
      inside the slot the row's `md:pr-8` reserve holds for it. */}
      {trailing !== undefined ? (
        <div className="absolute top-1/2 right-3 z-10 hidden -translate-y-1/2 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100 md:block">
          {trailing}
        </div>
      ) : onDelete !== undefined ? (
        <button
          type="button"
          className="text-muted-foreground hover:text-destructive absolute top-1/2 right-3 z-10 hidden -translate-y-1/2 opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100 md:flex"
          aria-label={deleteLabel}
          title={deleteLabel}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          <TrashIcon className="size-3.5" />
        </button>
      ) : null}
      <div className="md:hidden">
        <SwipeRow
          onDelete={onDelete}
          deleteLabel={deleteLabel}
          {...(canPin ? { onPin: onTogglePin, pinLabel, pinned } : {})}
        >
          {children}
        </SwipeRow>
      </div>
      <div className="hidden md:block">{children}</div>
    </div>
  );
}
