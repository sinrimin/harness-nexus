import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { Lamp } from './lamp';
import { LabelText } from './text';
import type { SignalState } from '@/components/state-signal';

/**
 * Readout — a count that refuses to lie (02-content.md §7).
 *
 * `5 agents` misleads when three of the five machines are offline; `2/5` plus a
 * qualifier line does not. So a count that has a denominator always renders as
 * numerator/denominator (the denominator dimmer), and the qualifier states the
 * fact — `1 error · 1 down` — never a reassurance.
 *
 * `layout` picks between the two places the same number appears: `figure` for
 * the overview (label above, number large, whole thing a link) and `inline`
 * for a strip of readouts in a nameplate (lamp, number, label).
 */

type ReadoutProps = {
  value: ReactNode;
  total?: ReactNode;
  /** The fact under the number: "3 offline", "1 error · 2 queued". */
  qualifier?: ReactNode;
  label?: ReactNode;
  lamp?: SignalState;
  live?: boolean;
  /** Renders the whole readout as a link to the thing it counts. */
  to?: string;
  layout?: 'figure' | 'inline';
  /** `lg` is the overview figure; `sm` has to live inside a 28px nameplate. */
  size?: 'lg' | 'sm';
  /** No data yet — shows an em dash, never a zero. */
  loading?: boolean;
  className?: string;
};

export function Readout({
  value,
  total,
  qualifier,
  label,
  lamp,
  live,
  to,
  layout = 'figure',
  size = 'lg',
  loading,
  className,
}: ReadoutProps) {
  const number = (
    <span className="flex items-baseline gap-0.5">
      <span className={cn(size === 'sm' ? 'role-readout-sm' : 'role-readout', 'text-foreground')}>
        {loading === true ? '—' : value}
      </span>
      {total !== undefined && loading !== true ? (
        <span className={size === 'sm' ? 'role-readout-sm-dim' : 'role-readout-dim'}>/{total}</span>
      ) : null}
    </span>
  );

  const body = (
    <>
      {layout === 'figure' ? (
        label !== undefined ? (
          <LabelText size="sm">{label}</LabelText>
        ) : null
      ) : null}
      <span className={cn('flex items-center gap-1.5', layout === 'figure' && 'gap-2')}>
        {lamp !== undefined ? <Lamp state={lamp} live={live} /> : null}
        {number}
        {layout === 'inline' && label !== undefined ? (
          <LabelText size="sm">{label}</LabelText>
        ) : null}
      </span>
      {qualifier !== undefined ? (
        <span className="text-muted-foreground text-xs">{qualifier}</span>
      ) : null}
    </>
  );

  const classes = cn(
    'min-w-0',
    layout === 'figure' ? 'flex flex-col gap-1.5' : 'inline-flex items-center gap-2',
    className,
  );

  return to === undefined ? (
    <span data-surface="readout" data-layout={layout} className={classes}>
      {body}
    </span>
  ) : (
    <Link to={to} data-surface="readout" data-layout={layout} className={cn(classes, 'group')}>
      {body}
    </Link>
  );
}
