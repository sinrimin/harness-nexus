import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';
import { SIGNAL_TONE, type SignalState, type SignalTone } from '@/components/state-signal';
import { useSkin } from '@/components/skin-provider';

/**
 * Lamp — the status truth (02-content.md §3.3).
 *
 * `data-state` stays the truth and styling never rewrites it; what a skin
 * decides is the *shape* (manifest.statusStyle):
 *
 *   dot   Signal — a small round lamp
 *   led   BAY    — a lensed LED (skin adds the ring and the glow)
 *   lamp  NIGHTWATCH — a phosphor lamp (slow breath)
 *   word  LEDGER — no lamp at all: the printed word, underlined/struck by CSS
 *
 * Two channels always: the lamp carries the tone, the word carries the state,
 * so nothing is communicated by colour alone — and the `word` style, which has
 * no colour at all, still says everything.
 */

export type LampSize = 'md' | 'sm' | 'lg';

const LAMP_CLASS: Record<SignalTone, string> = {
  ok: 'bg-lamp-ok',
  warn: 'bg-lamp-warn',
  fail: 'bg-lamp-fail',
  live: 'bg-signal',
  off: 'bg-lamp-off',
};

const LAMP_SIZE: Record<LampSize, string> = {
  md: 'size-2',
  sm: 'size-1.5',
  lg: 'size-2.5',
};

const WORD_CLASS: Record<SignalTone, string> = {
  ok: 'text-state-ok-ink',
  warn: 'text-state-warn-ink',
  fail: 'text-state-fail-ink',
  live: 'text-signal',
  off: 'text-muted-foreground',
};

type LampProps = Omit<ComponentProps<'span'>, 'children'> & {
  state: SignalState;
  /** The state word rendered next to the lamp (the second channel). */
  word?: string;
  /** Accessible name when there is no word. */
  label?: string;
  size?: LampSize;
  /** Breathing lamp — reserved for things that are *running* right now. */
  pulse?: boolean;
  /** "This is the one you are looking at" (current bay / channel / session). */
  live?: boolean;
};

export function Lamp({
  state,
  word,
  label,
  size = 'md',
  pulse,
  live,
  className,
  ...props
}: LampProps) {
  const { manifest } = useSkin();
  const tone = SIGNAL_TONE[state];
  const isLive = live === true || tone === 'live';
  const asWord = manifest.statusStyle === 'word';

  return (
    <span
      data-lamp={manifest.statusStyle}
      data-state={state}
      data-tone={tone}
      data-live={isLive ? 'true' : undefined}
      className={cn('inline-flex min-w-0 items-center gap-1.5', className)}
      {...props}
    >
      {asWord ? null : (
        <span
          data-slot="lamp-body"
          aria-hidden="true"
          className={cn(
            'lamp-body shrink-0 rounded-full',
            LAMP_SIZE[size],
            LAMP_CLASS[tone],
            (pulse === true || isLive) && 'lamp-breath',
          )}
        />
      )}
      {word !== undefined ? (
        <span data-slot="lamp-word" className={cn('role-data-sm truncate', WORD_CLASS[tone])}>
          {word}
        </span>
      ) : label !== undefined ? (
        <span className="sr-only">{label}</span>
      ) : null}
    </span>
  );
}
