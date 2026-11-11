// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useI18n } from '@/i18n';
import { DataText, LabelText } from '@/components/kit';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/**
 * #26/#122/#123 — the context-pressure device, extracted from the composer in
 * #124 so the composer toolbar and the session HUD can share one reading and
 * one details card:
 *
 *   - `contextPressure()` — the pure slice (pct / tone / figure) every form
 *     renders; null when the adapter reported no occupancy (the only source,
 *     nothing is invented).
 *   - `ContextDetails` — the popover body: the complete numerator/denominator,
 *     the percentage, and the wide bar variant.
 *   - `ContextMeter` — the toolbar form the assistant page still uses: the
 *     16px ring plus its percentage (#123). The agent session page hides it in
 *     favour of the HUD's CTX cell (#124).
 */

export interface ComposerUsage {
  contextUsed?: number;
  contextSize?: number;
}

export type MeterTone = 'neutral' | 'warn' | 'danger';

export interface ContextPressure {
  used: number;
  size: number;
  pct: number;
  tone: MeterTone;
  /** "34.1k / 200k" — the complete figures for the details card. */
  figure: string;
}

/** 1234 → "1.2k" · 64000 → "64k" · 130000 → "130k" · 1500000 → "1.5M". */
export function formatTokens(n: number): string {
  const compact = (div: number): string => {
    const s = (n / div).toFixed(1);
    return `${s.endsWith('.0') ? s.slice(0, -2) : s}`;
  };
  if (n >= 1_000_000) return `${compact(1_000_000)}M`;
  if (n >= 1_000) return `${compact(1_000)}k`;
  return String(n);
}

/** The occupancy slice, or null when the adapter has not reported one. */
export function contextPressure(usage: ComposerUsage | null): ContextPressure | null {
  const used = usage?.contextUsed;
  const size = usage?.contextSize;
  if (used === undefined || size === undefined || size <= 0) return null;
  const pct = Math.min(100, Math.max(0, (used / size) * 100));
  const tone: MeterTone = pct > 95 ? 'danger' : pct > 80 ? 'warn' : 'neutral';
  return {
    used,
    size,
    pct,
    tone,
    figure: `${formatTokens(used)} / ${formatTokens(size)}`,
  };
}

/**
 * The ring — one half of the toolbar meter (#122, paired with its number in
 * #123): a 16px gauge whose stroke is the tone: `meter-ring-track` is the
 * muted step, `meter-ring-fill` the value, both on `currentColor`. `data-tone`
 * rides every element of the device because that is the attribute a skin keys
 * on: a skin that re-tones only the visual and forgets the fill leaves the
 * danger reading painted in its neutral colour — measured, not assumed (#26).
 * The neutral stroke has NO colour class: it inherits the trigger's
 * `text-muted-foreground hover:text-foreground`, the same as its number.
 */
function MeterRing({ pct, tone }: { pct: number; tone: MeterTone }) {
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg
      data-slot="meter-ring"
      data-tone={tone}
      viewBox="0 0 20 20"
      aria-hidden="true"
      className={cn(
        'size-4 shrink-0',
        tone === 'warn' ? 'text-warn' : tone === 'danger' ? 'text-danger' : undefined,
      )}
    >
      <circle
        data-slot="meter-ring-track"
        data-tone={tone}
        cx="10"
        cy="10"
        r={radius}
        fill="none"
        strokeWidth="2.5"
        className="text-muted stroke-current"
      />
      <circle
        data-slot="meter-ring-fill"
        data-tone={tone}
        cx="10"
        cy="10"
        r={radius}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        stroke="currentColor"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - pct / 100)}
        transform="rotate(-90 10 10)"
      />
    </svg>
  );
}

/**
 * The details card — complete figures + percentage + the wide bar. Shared by
 * the toolbar meter's popover and the HUD's CTX cell (#124). Returns null when
 * there is no occupancy to describe.
 */
export function ContextDetails({ usage }: { usage: ComposerUsage | null }) {
  const { t } = useI18n();
  const pressure = contextPressure(usage);
  if (pressure === null) return null;
  const { pct, tone, figure } = pressure;
  return (
    <>
      <LabelText as="div" size="sm">
        {t('chat.contextWindow')}
      </LabelText>
      <div className="flex items-baseline justify-between gap-2">
        <DataText
          size="sm"
          tone={tone === 'warn' ? 'warn' : tone === 'danger' ? 'fail' : 'default'}
        >
          {figure}
        </DataText>
        <span className="text-muted-foreground text-xs tabular-nums">
          {t('chat.contextPct', { pct: String(Math.round(pct)) })}
        </span>
      </div>
      {/* The same device again, at the width a card can hold — the variant is
          how a skin knows this bar is NOT the 62px nameplate one. */}
      <span
        data-slot="meter"
        data-variant="wide"
        data-tone={tone}
        className="bg-muted relative block h-1.5 w-full overflow-hidden rounded-full"
      >
        <span
          data-slot="meter-fill"
          data-tone={tone}
          className={cn(
            'absolute inset-y-0 left-0 rounded-full transition-[width] duration-300',
            tone === 'danger' ? 'bg-danger' : tone === 'warn' ? 'bg-warn' : 'bg-primary',
          )}
          style={{ width: `${pct}%` }}
        />
      </span>
    </>
  );
}

/**
 * The toolbar meter (#122 made it ONE shape at every size; #123 paired the
 * ring with its percentage; #124 removed it from agent sessions — the HUD's
 * CTX cell owns context there, and the assistant page keeps this form).
 *
 * Exported for the unit test (`context-meter.test.tsx`).
 */
export function ContextMeter({ usage }: { usage: ComposerUsage | null }) {
  const { t } = useI18n();
  const pressure = contextPressure(usage);
  if (pressure === null) return null;
  const { pct, tone, used, size } = pressure;
  const label = t('chat.contextUsed', { used: formatTokens(used), size: formatTokens(size) });
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-slot="meter-trigger"
          aria-label={label}
          title={label}
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 flex h-(--control-h-sm) shrink-0 items-center gap-1.5 rounded-sm px-1 transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
        >
          <MeterRing pct={pct} tone={tone} />
          <span
            data-slot="meter-pct"
            data-tone={tone}
            className={cn(
              'font-mono text-[10px] leading-none tabular-nums',
              tone === 'warn'
                ? 'text-state-warn-ink'
                : tone === 'danger'
                  ? 'text-state-fail-ink'
                  : undefined,
            )}
          >
            {/* #123 — the noun rides only where the toolbar's own container
                has room; below that the ring + bare number still name the
                value, and the popover/tooltip carry the label. */}
            <span className="@max-2xl:hidden">
              {t('chat.contextShort', { pct: String(Math.round(pct)) })}
            </span>
            <span className="hidden @max-2xl:inline">
              {t('chat.contextPctShort', { pct: String(Math.round(pct)) })}
            </span>
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 space-y-2 p-3">
        <ContextDetails usage={usage} />
      </PopoverContent>
    </Popover>
  );
}
