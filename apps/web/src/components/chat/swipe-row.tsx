// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useRef, useState, type ReactNode, type TouchEvent } from 'react';
import { PinIcon, TrashIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * #55 — the phone's list-row delete: swipe the row left to reveal a
 * destructive button pinned under its right edge. #110 — direction-aware:
 * swiping RIGHT reveals a leading PIN action (neutral background — pinning
 * is not a destructive act). Hand-written on purpose (the repo carries no
 * gesture library): translateX driven by touch deltas, a slop-locked axis so
 * vertical scrolls never fight it, and a half-width snap per direction.
 * Desktop never renders this — the same rows offer a hover pin/trash there
 * (`session-row.tsx`).
 */
const REVEAL_PX = 72;
const SLOP_PX = 6;

export function SwipeRow({
  onDelete,
  deleteLabel,
  onPin,
  pinLabel,
  pinned = false,
  children,
}: {
  onDelete?: () => void;
  /** The trash's aria/title — the same words as the confirm dialog's action. */
  deleteLabel: string;
  onPin?: () => void;
  /** The pin's aria/title — pin or unpin, the caller's word. */
  pinLabel?: string;
  pinned?: boolean;
  children: ReactNode;
}) {
  /** Live drag delta in px; null while not dragging. */
  const [drag, setDrag] = useState<number | null>(null);
  /** Which reveal is snapped open; null = closed. */
  const [open, setOpen] = useState<'delete' | 'pin' | null>(null);
  const startX = useRef(0);
  const startY = useRef(0);
  const axis = useRef<'x' | 'y' | null>(null);

  const base = open === 'delete' ? -REVEAL_PX : open === 'pin' ? REVEAL_PX : 0;
  // Rubber-band 24px past each reveal; a direction with no action rubber-bands
  // immediately (the row never opens toward a dead end).
  const lo = onDelete !== undefined ? -(REVEAL_PX + 24) : -24;
  const hi = onPin !== undefined ? REVEAL_PX + 24 : 24;
  const offset = drag === null ? base : Math.min(hi, Math.max(base + drag, lo));

  const onTouchStart = (e: TouchEvent): void => {
    const touch = e.touches[0];
    if (touch === undefined) return;
    startX.current = touch.clientX;
    startY.current = touch.clientY;
    axis.current = null;
  };
  const onTouchMove = (e: TouchEvent): void => {
    const touch = e.touches[0];
    if (touch === undefined) return;
    const dx = touch.clientX - startX.current;
    const dy = touch.clientY - startY.current;
    // Axis lock: undecided until the gesture passes the slop, then fixed for
    // the whole touch — a vertical scroll never sees a horizontal wobble and
    // vice versa.
    if (axis.current === null) {
      if (Math.abs(dx) < SLOP_PX && Math.abs(dy) < SLOP_PX) return;
      axis.current = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
    }
    if (axis.current !== 'x') return;
    setDrag(dx);
  };
  const onTouchEnd = (): void => {
    if (axis.current === 'x' && drag !== null) {
      setOpen(offset < -REVEAL_PX / 2 ? 'delete' : offset > REVEAL_PX / 2 ? 'pin' : null);
    }
    setDrag(null);
    axis.current = null;
  };

  return (
    <div className="relative overflow-hidden">
      {/* The revealed layers under the row's edges. Inset 2px VERTICALLY on
          purpose: rows carry fractional heights (font metrics), and WebKit
          rounds an absolutely-positioned `inset-y-0` layer and the in-flow
          cover differently — on iOS the red underlay peeked a 1px sliver
          below some rows (only the fractionally-unlucky ones). An inset
          larger than any rounding error keeps the underlay strictly inside
          the cover's painted box. */}
      {onPin !== undefined && pinLabel !== undefined ? (
        <div className="bg-tray absolute inset-y-[2px] left-0 flex w-[72px] items-stretch">
          <button
            type="button"
            className="text-foreground hover:bg-tray/70 flex w-full items-center justify-center"
            aria-label={pinLabel}
            title={pinLabel}
            onClick={() => {
              setOpen(null);
              onPin();
            }}
          >
            <PinIcon className={cn('size-4', pinned && 'fill-current')} />
          </button>
        </div>
      ) : null}
      {onDelete !== undefined ? (
        <div className="absolute inset-y-[2px] right-0 flex w-[72px] items-stretch">
          <button
            type="button"
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90 flex w-full items-center justify-center"
            aria-label={deleteLabel}
            title={deleteLabel}
            onClick={() => {
              setOpen(null);
              onDelete();
            }}
          >
            <TrashIcon className="size-4" />
          </button>
        </div>
      ) : null}
      {/* The moving row: opaque, so the reveals are hidden until swiped; the
          snap animation only runs between touches. */}
      <div
        className="bg-background relative transition-transform duration-150"
        style={{
          transform: `translateX(${offset}px)`,
          ...(drag !== null ? { transitionDuration: '0ms' } : {}),
        }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      >
        {children}
      </div>
    </div>
  );
}
