import { useEffect, useState, type HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import { TableCell, TableRow } from '@/components/ui/table';

/**
 * Skeleton — how a list loads (02-content.md §3.10).
 *
 * Not a centred "Loading…" line: a skeleton has the shape of the answer, so the
 * page does not jump when the data lands. It appears only after 300ms — a fast
 * response should show nothing at all rather than flash a grey bar — and
 * reduced motion pins it static (the global rule).
 */

type SkeletonProps = HTMLAttributes<HTMLSpanElement>;

export function Skeleton({ className, ...props }: SkeletonProps) {
  const visible = useDelayedVisible();
  if (!visible) return null;
  return (
    <span
      data-slot="skeleton"
      aria-hidden="true"
      className={cn('bg-muted block h-3 animate-pulse rounded-sm', className)}
      {...props}
    />
  );
}

/** True once `delayMs` has passed since mount — the "give the data a chance" gate. */
function useDelayedVisible(delayMs = 300): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs]);
  return visible;
}

/** Bar widths vary per column so the block reads as a table, not a grid of blocks. */
const BAR_WIDTH = ['w-24', 'w-16', 'w-28', 'w-12', 'w-20', 'w-14', 'w-16'];

type SkeletonRowsProps = {
  rows?: number;
  cols: number;
  className?: string;
};

export function SkeletonRows({ rows = 4, cols, className }: SkeletonRowsProps) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <TableRow key={r} className={cn('hover:bg-transparent', className)}>
          {Array.from({ length: cols }, (__, c) => (
            <TableCell key={c}>
              <Skeleton className={BAR_WIDTH[c % BAR_WIDTH.length]} />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}
