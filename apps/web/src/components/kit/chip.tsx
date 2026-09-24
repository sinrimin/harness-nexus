import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';

/**
 * Chip — an interactive item (02-content.md §3.4).
 *
 * The distinction from `Badge` is exactly one question: *does clicking do
 * something?* A transport name, a scope and a role are enumerations (Badge); a
 * machine in a fleet strip, a model in a provider's list, `+ add model` are
 * destinations or actions (Chip). Today both were the same component, which is
 * why a clickable model and a read-only scope looked identical.
 */

type ChipProps = {
  /** Router destination — renders a `<Link>`. */
  to?: string;
  /** External/absolute href — renders an `<a>`. */
  href?: string;
  onClick?: () => void;
  tone?: 'default' | 'muted' | 'live';
  icon?: ReactNode;
  title?: string;
  className?: string;
  children: ReactNode;
};

export function Chip({
  to,
  href,
  onClick,
  tone = 'default',
  icon,
  title,
  className,
  children,
}: ChipProps) {
  const interactive = to !== undefined || href !== undefined || onClick !== undefined;
  const classes = cn(
    'inline-flex max-w-full items-center gap-1 rounded-(--radius-well) border border-border bg-card px-1.5 py-0.5 role-data-sm text-foreground shadow-(--shadow-panel)',
    tone === 'muted' && 'text-muted-foreground bg-transparent shadow-none border-border',
    tone === 'live' && 'border-signal text-signal',
    interactive && 'hover:bg-tray transition-colors',
    className,
  );

  const content = (
    <>
      {icon !== undefined ? (
        <span aria-hidden="true" className="[&_svg]:size-3">
          {icon}
        </span>
      ) : null}
      <span className="truncate">{children}</span>
    </>
  );

  if (to !== undefined) {
    return (
      <Link to={to} title={title} data-slot="chip" className={classes}>
        {content}
      </Link>
    );
  }
  if (href !== undefined) {
    return (
      <a href={href} title={title} data-slot="chip" className={classes}>
        {content}
      </a>
    );
  }
  if (onClick !== undefined) {
    return (
      <button type="button" title={title} onClick={onClick} data-slot="chip" className={classes}>
        {content}
      </button>
    );
  }
  return (
    <span title={title} data-slot="chip" data-tone={tone} className={classes}>
      {content}
    </span>
  );
}
