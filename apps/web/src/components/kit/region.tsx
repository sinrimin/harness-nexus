import type { ReactNode } from 'react';

/**
 * Region — a named slot a skin may fill (04-contract.md §3, "skeleton
 * flexibility").
 *
 * NIGHTWATCH wants a bottom watch bar and LEDGER wants a folio margin column.
 * Neither may add DOM, and neither may exist as an empty gutter today, so the
 * slot renders nothing at all when it has no content — its width/height is
 * zero, and the layout is unchanged for skins that never fill it.
 */
export function Region({
  region,
  side,
  className,
  children,
}: {
  region: string;
  side?: 'start' | 'end';
  className?: string;
  children?: ReactNode;
}) {
  if (children === undefined || children === null) return null;
  return (
    <div data-region={region} data-side={side} className={className}>
      {children}
    </div>
  );
}
