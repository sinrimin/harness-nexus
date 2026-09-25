import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Table, TableCell, TableRow } from '@/components/ui/table';
import { EmptyState } from './empty-state';
import { Note, errorParts } from './note';
import { Panel } from './panel';
import { SkeletonRows } from './skeleton';

/**
 * DataTable — the list shell, once (04-contract.md §2).
 *
 * Ten pages each rebuilt `Card > CardHeader > CardContent px-0 > Table` and
 * then hand-wrote `pl-6` on the first column and `pr-6 text-right` on the last;
 * two of them built a second, incompatible shell out of `div.rounded-md.border`
 * inside the card, double-framing the table.
 *
 * The shell here owns: the panel and its nameplate, the toolbar strip, the
 * scroll container, the row/head geometry (see `[data-surface='table']` in
 * index.css) and the four state rows. The page owns the columns and the cells.
 *
 * Rows render only when the state is `ready`; the state row is the body
 * otherwise. That is what removes the 23 inline `colSpan` cells.
 */

type TableState = 'ready' | 'loading' | 'empty' | 'filtered' | 'error';

/**
 * Derive the state from what the page knows. Kept a free function so it is
 * unit-testable and so every page asks the same question in the same order:
 * an error outranks loading (a failed fetch leaves `items` null in most pages),
 * and "no rows because of a filter" is not the same as "no rows at all".
 */
export function tableState(input: {
  error?: unknown;
  loading?: boolean;
  count?: number;
  filtered?: boolean;
}): TableState {
  if (input.error !== undefined && input.error !== null) return 'error';
  if (input.loading === true) return 'loading';
  if ((input.count ?? 0) > 0) return 'ready';
  return input.filtered === true ? 'filtered' : 'empty';
}

type EmptyProps = {
  title?: ReactNode;
  hint?: ReactNode;
  code?: ReactNode;
  action?: ReactNode;
};

type TableStateRowProps = {
  state: Exclude<TableState, 'ready'>;
  /** For the colSpan — the shell knows it, a direct caller passes it. */
  columns: number;
  error?: unknown;
  empty?: EmptyProps;
  onRetry?: () => void;
  onClearFilters?: () => void;
  loadingRows?: number;
};

/** The four non-ready states, as table rows. */
export function TableStateRow({
  state,
  columns,
  error,
  empty,
  onRetry,
  onClearFilters,
  loadingRows,
}: TableStateRowProps) {
  const { t } = useI18n();

  if (state === 'loading') return <SkeletonRows rows={loadingRows ?? 4} cols={columns} />;

  const wrap = (children: ReactNode) => (
    <TableRow className="hover:bg-transparent">
      <TableCell colSpan={columns} className="p-0">
        {children}
      </TableCell>
    </TableRow>
  );

  if (state === 'empty') {
    return wrap(
      <EmptyState
        title={empty?.title ?? t('kit.emptyTitle')}
        hint={empty?.hint}
        code={empty?.code}
        action={empty?.action}
      />,
    );
  }

  if (state === 'filtered') {
    return wrap(
      <div className="text-muted-foreground flex flex-wrap items-center justify-center gap-3 px-6 py-6 text-xs">
        {t('kit.filteredEmpty')}
        {onClearFilters !== undefined ? (
          <Button size="sm" variant="outline" onClick={onClearFilters}>
            {t('kit.clearFilters')}
          </Button>
        ) : null}
      </div>,
    );
  }

  const { code, message } = errorParts(error);
  return wrap(
    <div className="p-(--gap-tight)">
      <Note
        tone="fail"
        title={message ?? t('kit.loadFailed')}
        code={code ?? undefined}
        action={
          onRetry !== undefined ? (
            <Button size="sm" variant="outline" onClick={onRetry}>
              {t('kit.retry')}
            </Button>
          ) : undefined
        }
      />
    </div>,
  );
}

type DataTableProps = {
  /** Column count, for the state row's colSpan. */
  columns: number;
  state?: TableState;
  error?: unknown;
  empty?: EmptyProps;
  onRetry?: () => void;
  onClearFilters?: () => void;
  loadingRows?: number;
  /** Panel chrome. */
  label?: ReactNode;
  icon?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  tone?: 'default' | 'live';
  density?: 'default' | 'compact';
  /** A filter/search/sort strip above the head (wired to the URL in P3). */
  toolbar?: ReactNode;
  stickyHead?: boolean;
  className?: string;
  /** `<TableHeader>` + `<TableBody>`, or body rows for a headerless table. */
  children: ReactNode;
};

export function DataTable({
  columns,
  state = 'ready',
  error,
  empty,
  onRetry,
  onClearFilters,
  loadingRows,
  label,
  icon,
  meta,
  actions,
  tone,
  density,
  toolbar,
  stickyHead,
  className,
  children,
}: DataTableProps) {
  return (
    <Panel
      label={label}
      icon={icon}
      meta={meta}
      actions={actions}
      {...(tone !== undefined ? { tone } : {})}
      {...(density !== undefined ? { density } : {})}
      className={className}
    >
      {toolbar !== undefined ? (
        <div
          data-slot="table-toolbar"
          className="flex flex-wrap items-center gap-2 border-b px-(--panel-pad) py-2"
        >
          {toolbar}
        </div>
      ) : null}
      <div
        data-surface="table"
        {...(stickyHead === true ? { 'data-sticky-head': '' } : {})}
        className={cn('min-w-0 flex-1')}
      >
        <Table>
          {children}
          {state !== 'ready' ? (
            <tbody>
              <TableStateRow
                state={state}
                columns={columns}
                error={error}
                empty={empty}
                onRetry={onRetry}
                onClearFilters={onClearFilters}
                loadingRows={loadingRows}
              />
            </tbody>
          ) : null}
        </Table>
      </div>
    </Panel>
  );
}
