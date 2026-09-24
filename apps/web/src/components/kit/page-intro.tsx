import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { LabelText } from './text';

/**
 * PageHeader — the page's identity, once (01-skeleton.md §4).
 *
 * Twelve files re-wrote the same `<h1 class="text-2xl font-semibold
 * tracking-tight">` + subtitle + right-aligned action, and one page had no
 * title at all. The header is declared here so that P2 can move the same
 * declaration into the top bar (where the page identity belongs) without
 * touching a single page: pages already only say `title / sub / actions`.
 */

export type CrumbItem = { label: ReactNode; to?: string };

type PageHeaderProps = {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  /** `▸ GROUP / PAGE` — every segment is navigable. */
  crumbs?: CrumbItem[];
  className?: string;
};

export function PageHeader({ title, sub, actions, crumbs, className }: PageHeaderProps) {
  return (
    <header
      data-slot="page-header"
      className={cn('mb-8 flex items-start justify-between gap-4', className)}
    >
      <div className="min-w-0">
        {crumbs !== undefined && crumbs.length > 0 ? <Breadcrumb items={crumbs} /> : null}
        <h1 data-slot="page-title" className="font-display text-2xl font-semibold tracking-tight">
          {title}
        </h1>
        {sub !== undefined ? (
          <p className="text-muted-foreground mt-1 max-w-[68ch] text-sm">{sub}</p>
        ) : null}
      </div>
      {actions !== undefined ? (
        <div data-slot="page-actions" className="flex shrink-0 items-center gap-2">
          {actions}
        </div>
      ) : null}
    </header>
  );
}

/** One breadcrumb row. The `▸` is the accent's one permitted decorative use. */
export function Breadcrumb({ items, className }: { items: CrumbItem[]; className?: string }) {
  return (
    <nav
      aria-label="Breadcrumb"
      data-slot="breadcrumb"
      className={cn('mb-1.5 flex items-center gap-1.5', className)}
    >
      {items.map((item, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 ? (
            <span aria-hidden="true" className="text-border role-label-sm">
              /
            </span>
          ) : (
            <span aria-hidden="true" className="text-signal role-label-sm">
              ▸
            </span>
          )}
          {item.to !== undefined && item.to !== '' ? (
            <Link to={item.to} className="hover:text-foreground">
              <LabelText size="sm">{item.label}</LabelText>
            </Link>
          ) : (
            <LabelText size="sm">{item.label}</LabelText>
          )}
        </span>
      ))}
    </nav>
  );
}
