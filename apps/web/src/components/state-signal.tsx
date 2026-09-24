import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/**
 * The shared status/presence signal. Status truth lives in `data-state` —
 * skins restyle the dot through `[data-skin] [data-state=…]` selectors and may
 * one day render it as a word instead (see wiki design-skin-system.md); the
 * state itself is data and must never be altered by styling.
 *
 * `pulse` is explicit per site (a running job is a steady dot in the jobs
 * table but a pulsing one in the chat tool row — both are correct today and
 * stay that way).
 */

export type SignalState =
  | 'online'
  | 'offline'
  | 'connected'
  | 'error'
  | 'configured'
  | 'connecting'
  | 'running'
  | 'busy'
  | 'succeeded'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'queued'
  | 'live'
  | 'idle'
  | 'warn'
  | 'neutral'
  | 'inactive';

/** HTML dot colors (Signal baseline) — one class family per state. */
export const SIGNAL_DOT_CLASS: Record<SignalState, string> = {
  online: 'bg-ok',
  connected: 'bg-ok',
  succeeded: 'bg-ok',
  completed: 'bg-ok',
  busy: 'bg-ok',
  running: 'bg-warn',
  connecting: 'bg-warn',
  error: 'bg-warn',
  warn: 'bg-warn',
  failed: 'bg-danger',
  live: 'bg-signal',
  idle: 'bg-transparent',
  offline: 'bg-muted-foreground/70',
  configured: 'bg-muted-foreground/70',
  neutral: 'bg-muted-foreground/60',
  cancelled: 'bg-muted-foreground/40',
  queued: 'bg-muted-foreground/40',
  inactive: 'bg-muted-foreground/40',
};

/** SVG fill equivalents (mesh-topology nodes). */
export const SIGNAL_FILL_CLASS: Record<SignalState, string> = {
  online: 'fill-ok',
  connected: 'fill-ok',
  succeeded: 'fill-ok',
  completed: 'fill-ok',
  busy: 'fill-ok',
  running: 'fill-warn',
  connecting: 'fill-warn',
  error: 'fill-warn',
  warn: 'fill-warn',
  failed: 'fill-danger',
  live: 'fill-signal',
  idle: 'fill-transparent',
  offline: 'fill-muted-foreground/70',
  configured: 'fill-muted-foreground/70',
  neutral: 'fill-muted-foreground/60',
  cancelled: 'fill-muted-foreground/40',
  queued: 'fill-muted-foreground/40',
  inactive: 'fill-muted-foreground/40',
};

type StateSignalProps = Omit<ComponentProps<'span'>, 'children'> & {
  state: SignalState;
  /** Accessible name when the dot is the only indicator (renders aria-label). */
  label?: string;
  pulse?: boolean;
};

/**
 * The 18 state words collapse to five tones, and that five-tone table is what
 * the kit's `Lamp` renders: colour carries the tone, the word carries the
 * state. Keeping the tone table here (next to the state union) means a new
 * state can never be added without deciding its tone.
 */
export type SignalTone = 'ok' | 'warn' | 'fail' | 'live' | 'off';

export const SIGNAL_TONE: Record<SignalState, SignalTone> = {
  online: 'ok',
  connected: 'ok',
  succeeded: 'ok',
  completed: 'ok',
  busy: 'ok',
  running: 'warn',
  connecting: 'warn',
  error: 'warn',
  warn: 'warn',
  failed: 'fail',
  live: 'live',
  idle: 'off',
  offline: 'off',
  configured: 'off',
  neutral: 'off',
  cancelled: 'off',
  queued: 'off',
  inactive: 'off',
};

export function StateSignal({ state, label, pulse, className, ...props }: StateSignalProps) {
  return (
    <span
      data-state={state}
      className={cn(
        'signal-dot inline-block size-2 shrink-0 rounded-full',
        SIGNAL_DOT_CLASS[state],
        pulse && 'animate-pulse',
        className,
      )}
      aria-label={label}
      {...props}
    />
  );
}
