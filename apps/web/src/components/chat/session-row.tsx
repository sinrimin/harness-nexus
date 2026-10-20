// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { ReactNode } from 'react';
import { TrashIcon } from 'lucide-react';
import { SwipeRow } from './swipe-row';

/**
 * #55 — the shared delete affordance for session-rail rows. Desktop: a
 * trash that fades in on row hover. Phone: the same row wrapped in a
 * swipe-left reveal. `onDelete` undefined = no affordance at all (a live
 * channel holds the row — the server would refuse the delete, so the row
 * must not offer it).
 */
export function SessionRow({
  onDelete,
  deleteLabel,
  children,
}: {
  onDelete?: () => void;
  /** The trash's aria/title — the same words as the confirm dialog's action. */
  deleteLabel: string;
  /** The rail's row button, verbatim — this shell never restructures it. */
  children: ReactNode;
}) {
  if (onDelete === undefined) return <>{children}</>;
  return (
    <div className="group/row relative">
      {/* Desktop hover trash (the phone's is the swipe reveal). */}
      <button
        type="button"
        className="text-muted-foreground hover:text-destructive absolute right-1.5 top-2 z-10 hidden opacity-0 transition-opacity group-hover/row:opacity-100 focus-visible:opacity-100 md:flex"
        aria-label={deleteLabel}
        title={deleteLabel}
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
      >
        <TrashIcon className="size-3.5" />
      </button>
      <div className="md:hidden">
        <SwipeRow onDelete={onDelete} deleteLabel={deleteLabel}>
          {children}
        </SwipeRow>
      </div>
      <div className="hidden md:block">{children}</div>
    </div>
  );
}
