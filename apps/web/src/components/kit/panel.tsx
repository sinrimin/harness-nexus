import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Panel — the unit of content area (02-content.md §3.1).
 *
 * Structure is fixed here (1px frame, a 28px nameplate strip, a body) and the
 * material is the skin's: radius, shadow, and the strip's finish all come from
 * tokens. The strip is the panel's identity and is never folded away on mobile.
 *
 * Replaces both of yesterday's shells — `Card` (which carried document-style
 * padding and forced the bezel header to escape with negative margins) and the
 * hand-written `div.rounded-xl.border` blocks — so a page stops choosing a
 * shell per panel.
 */

type PanelProps = HTMLAttributes<HTMLElement> & {
  /** Nameplate text (rendered in the label role). */
  label?: ReactNode;
  icon?: ReactNode;
  /** Facts on the right of the strip: counts, refresh semantics, legend. */
  meta?: ReactNode;
  actions?: ReactNode;
  /** `live` puts the panel's own accent on the strip (the one live panel). */
  tone?: 'default' | 'live';
  density?: 'default' | 'compact';
};

export function Panel({
  label,
  icon,
  meta,
  actions,
  tone = 'default',
  density,
  className,
  children,
  ...props
}: PanelProps) {
  const hasHeader =
    label !== undefined || icon !== undefined || meta !== undefined || actions !== undefined;
  return (
    <section
      data-surface="panel"
      data-tone={tone}
      data-density={density}
      className={cn(
        'bg-card text-card-foreground flex flex-col rounded-(--radius-panel) border shadow-(--shadow-panel)',
        className,
      )}
      {...props}
    >
      {hasHeader ? <PanelHeader label={label} icon={icon} meta={meta} actions={actions} /> : null}
      {children}
    </section>
  );
}

type PanelHeaderProps = HTMLAttributes<HTMLElement> & {
  label?: ReactNode;
  icon?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
};

export function PanelHeader({
  label,
  icon,
  meta,
  actions,
  className,
  children,
  ...props
}: PanelHeaderProps) {
  return (
    <header
      data-slot="panel-header"
      className={cn('flex h-(--panel-head-h) shrink-0 items-center gap-2 border-b px-3', className)}
      {...props}
    >
      {icon ? (
        <span data-slot="panel-icon" className="text-muted-foreground [&_svg]:size-3.5">
          {icon}
        </span>
      ) : null}
      {label !== undefined ? (
        <span data-slot="panel-title" className="role-label text-foreground truncate">
          {label}
        </span>
      ) : null}
      {children}
      {meta !== undefined || actions !== undefined ? (
        <span data-slot="panel-meta" className="ml-auto flex items-center gap-3">
          {meta ? <span className="text-muted-foreground text-xs">{meta}</span> : null}
          {actions}
        </span>
      ) : null}
    </header>
  );
}

type PanelBodyProps = HTMLAttributes<HTMLDivElement> & {
  /**
   * `pad` = the instrument step (--panel-pad); `flush` = 0, for tables and
   * lists that own their own edges; `wide` = one gap, for form grids.
   */
  variant?: 'pad' | 'flush' | 'wide';
};

export function PanelBody({ variant = 'pad', className, ...props }: PanelBodyProps) {
  return (
    <div
      data-slot="panel-body"
      className={cn(
        'min-w-0 flex-1',
        variant === 'pad' && 'p-(--panel-pad)',
        variant === 'wide' && 'p-(--gap)',
        variant === 'flush' && 'p-0',
        className,
      )}
      {...props}
    />
  );
}
