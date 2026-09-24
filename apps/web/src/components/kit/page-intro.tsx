import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * PageIntro — the one line of prose a page needs under the chrome
 * (01-skeleton.md §4/§7).
 *
 * The page's identity moved into the topbar in P2: the shell renders the
 * breadcrumb trail and the `<h1>` from the route manifest, so a page no longer
 * writes its own heading (twelve files used to, and one page had none). What
 * is left here is the sentence that explains the page's content — prose, so it
 * stays in the prose column (≤68ch) and never grows a title.
 */
export function PageIntro({
  sub,
  children,
  className,
}: {
  sub?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  if (sub === undefined && children === undefined) return null;
  return (
    <div
      data-slot="page-intro"
      className={cn('mb-(--gap) flex flex-wrap items-center gap-x-3 gap-y-2', className)}
    >
      {sub !== undefined ? (
        <p className="text-muted-foreground max-w-[68ch] text-sm">{sub}</p>
      ) : null}
      {children}
    </div>
  );
}
