import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Type roles (02-content.md §2). The system has four roles, not a scale:
 * prose stays sans, protocol material and numbers go through `DataText`, and
 * the label role is the only place that gets uppercase + positive tracking.
 *
 * Families and sizes come from tokens (--app-font-label, --label-size,
 * --data-size), so a skin can move them without a component changing.
 */

type LabelElement = 'span' | 'div' | 'p' | 'dt' | 'h2' | 'h3' | 'legend';

type LabelTextProps = HTMLAttributes<HTMLElement> & {
  as?: LabelElement;
  /** `sm` is the readout/bay-number step (9.5px). */
  size?: 'md' | 'sm';
  /** Label role defaults to the hint colour; pass false for full-contrast ink. */
  muted?: boolean;
  children?: ReactNode;
};

export function LabelText({
  as: Comp = 'span',
  size = 'md',
  muted = true,
  className,
  ...props
}: LabelTextProps) {
  return (
    <Comp
      data-slot="label-text"
      className={cn(
        size === 'sm' ? 'role-label-sm' : 'role-label',
        muted && 'text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

type DataElement = 'span' | 'div' | 'code' | 'dd' | 'p' | 'strong' | 'time';

type DataTextProps = HTMLAttributes<HTMLElement> & {
  as?: DataElement;
  size?: 'md' | 'sm';
  tone?: 'default' | 'dim' | 'ok' | 'warn' | 'fail';
  children?: ReactNode;
};

const DATA_TONE: Record<NonNullable<DataTextProps['tone']>, string> = {
  default: 'text-foreground',
  dim: 'text-muted-foreground',
  ok: 'text-state-ok-ink',
  warn: 'text-state-warn-ink',
  fail: 'text-state-fail-ink',
};

/**
 * Every protocol string and every figure — ids, hosts, paths, versions,
 * transports, commands, counts, timestamps. Prose never uses this role, and
 * data never escapes it (02-content.md §1).
 */
export function DataText({
  as: Comp = 'span',
  size = 'md',
  tone = 'default',
  className,
  ...props
}: DataTextProps) {
  return (
    <Comp
      data-slot="data-text"
      className={cn(size === 'sm' ? 'role-data-sm' : 'role-data', DATA_TONE[tone], className)}
      {...props}
    />
  );
}
