// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useRef, useState, type ReactNode, type TouchEvent } from 'react';
import { TrashIcon } from 'lucide-react';

/**
 * #55 — the phone's list-row delete: swipe the row left to reveal a
 * destructive button pinned under its right edge. Hand-written on purpose
 * (the repo carries no gesture library): translateX driven by touch deltas,
 * a slop-locked axis so vertical scrolls never fight it, and a half-width
 * snap. Desktop never renders this — the same rows offer a hover trash
 * there (`session-row.tsx`).
 */
const REVEAL_PX = 72;
const SLOP_PX = 6;

export function SwipeRow({
  onDelete,
  deleteLabel,
  children,
}: {
  onDelete: () => void;
  /** The trash's aria/title — the same words as the confirm dialog's action. */
  deleteLabel: string;
  children: ReactNode;
}) {
  /** Live drag delta in px; null while not dragging. */
  const [drag, setDrag] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const startX = useRef(0);
  const startY = useRef(0);
  const axis = useRef<'x' | 'y' | null>(null);

  const base = open ? -REVEAL_PX : 0;
  // Rubber-band past the reveal width; never past the row's left edge.
  const offset = drag === null ? base : Math.min(0, Math.max(base + drag, -REVEAL_PX - 24));

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
    if (axis.current === 'x' && drag !== null) setOpen(offset < -REVEAL_PX / 2);
    setDrag(null);
    axis.current = null;
  };

  return (
    <div className="relative overflow-hidden">
      {/* The revealed layer under the row's right edge. Inset 2px VERTICALLY
          on purpose: rows carry fractional heights (font metrics), and WebKit
          rounds an absolutely-positioned `inset-y-0` layer and the in-flow
          cover differently — on iOS the red underlay peeked a 1px sliver
          below some rows (only the fractionally-unlucky ones). An inset
          larger than any rounding error keeps the underlay strictly inside
          the cover's painted box. */}
      <div className="absolute inset-y-[2px] right-0 flex w-[72px] items-stretch">
        <button
          type="button"
          className="bg-destructive text-destructive-foreground hover:bg-destructive/90 flex w-full items-center justify-center"
          aria-label={deleteLabel}
          title={deleteLabel}
          onClick={() => {
            setOpen(false);
            onDelete();
          }}
        >
          <TrashIcon className="size-4" />
        </button>
      </div>
      {/* The moving row: opaque, so the reveal is hidden until swiped; the
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
