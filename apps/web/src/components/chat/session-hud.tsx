// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { type ReactNode } from 'react';
import { useI18n } from '@/i18n';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { ChatSessionUsage } from '@/realtime';
import { ContextDetails, contextPressure, formatTokens } from './context-meter.js';
import type { ComposerUsage, MeterTone } from './context-meter.js';
import type { HudEditStats } from './hud-stats.js';

/**
 * #124/#128 — the session HUD, the band UNDER the Sender's top edge:
 *
 *   CTX ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮ -- --   TOK -- | READ -- | WRITE -- | HIT -- | REQ --   FILES 0 +0 −0
 *   CTX ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮ 1% 11.6K/1M   TOK 14.2K | READ 13.7K | WRITE 526 | HIT 0% | REQ 2   FILES 0 +0 −0
 *
 * The Sender keeps its full rounded rectangle; this strip is a sibling that
 * carries an 18px spacer in flow and then extends BEHIND the card (absolute,
 * radius + 2px deeper than the visible strip). The card's opaque background
 * and rounded top corners therefore cut the strip's bottom edge into the
 * concave corners of a slider-phone body: the Sender is on top, the band
 * slides out from under it. The assembly's single shadow and the card's own
 * border fall on the band at the seam — the strip carries no shadow or border
 * of its own, so both surfaces read as one device's physics.
 *
 * The reference layout (alpha.11 revision): three groups across one glass
 * face — CTX on the left, the token/cache cluster (TOK · READ · WRITE · HIT ·
 * REQ) in the middle behind hairline dividers, FILES on the right. Each cell
 * sits in a FIXED slot (`SLOT_MIN`); nothing shuffles when a source goes
 * dark.
 *
 * Material is the always-dark instrument glass (`data-surface="hud"`); every
 * colour and size is a `--hud-*` token, so BAY repaints it as its inverted LCD
 * window without touching this file. Labels are English in BOTH locales
 * (`CTX/TOK/READ/WRITE/HIT/REQ/FILES`): the strip is an engraved instrument
 * face, the same exception as the nav-group labels; tooltips are localized.
 *
 * Honesty (fixed face): labels and gauges always render, on both pages, in
 * every state. An UNKNOWN reading is `--` (never a fake zero); the FILES
 * zero state is a real number (`0 +0 −0` — nothing edited is data, not
 * absence). The strip never unmounts.
 *
 * Phone: the CTX bar shortens (16 → 8 segments) and READ/WRITE abbreviate to
 * R/W; the cells keep their fixed slots.
 */

/** Wide-face segment count; the phone face draws the compact count. */
const SEGMENTS = 16;
const SEGMENTS_COMPACT = 6;

/**
 * Each cell owns a FIXED slot; the mins hold its typical widest content plus
 * a little headroom. The `@max-2xl` step is the narrow composer column (the
 * used/size pair hides there too); `@max-sm` is the phone face.
 */
const SLOT_MIN = {
  ctx: 'min-w-[76px] @sm:min-w-[120px] @2xl:min-w-[210px]',
  tok: 'min-w-[46px] @sm:min-w-[58px] @2xl:min-w-[70px]',
  read: 'min-w-[30px] @sm:min-w-[56px] @2xl:min-w-[80px]',
  write: 'min-w-[34px] @sm:min-w-[60px] @2xl:min-w-[82px]',
  hit: 'min-w-[36px] @sm:min-w-[50px] @2xl:min-w-[62px]',
  req: 'min-w-[34px] @sm:min-w-[48px] @2xl:min-w-[62px]',
  files: 'min-w-[66px] @sm:min-w-[96px] @2xl:min-w-[130px]',
} as const;

/** "34.1k" → "34.1K" — the HUD reads in instrument case. */
function compact(n: number): string {
  return formatTokens(n).toUpperCase();
}

/**
 * The FILES cell cannot grow without bound: a pathological diff (tens of
 * thousands of lines) must not push the strip past the sender's width on a
 * phone. Above 10k the strip prints whole K (52K, 13K) — at most four
 * characters — while the tooltip and the Edit cards keep the exact numbers.
 */
function shortCount(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 10_000) return compact(n);
  // 999.5K would round to "1000K"; cross to M instead of growing a digit.
  if (n < 999_500) return `${String(Math.round(n / 1_000))}K`;
  const m = (n / 1_000_000).toFixed(1);
  return `${m.endsWith('.0') ? m.slice(0, -2) : m}M`;
}

/** Session-cumulative token totals as the strip reads them. */
interface Totals {
  /** Total tokens through the session: input + output + cache read/written. */
  total: number;
  input?: number | undefined;
  output?: number | undefined;
  read?: number | undefined;
  write?: number | undefined;
  turns: number;
}

function sessionTotals(usage: ChatSessionUsage | null): Totals | null {
  if (usage === null) return null;
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = usage;
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined
  ) {
    return null;
  }
  return {
    total:
      (inputTokens ?? 0) +
      (outputTokens ?? 0) +
      (cacheReadTokens ?? 0) +
      (cacheWriteTokens ?? 0),
    input: inputTokens,
    output: outputTokens,
    read: cacheReadTokens,
    write: cacheWriteTokens,
    turns: usage.turns,
  };
}

/** Cache hit rate = read / (input + read + write); null until both sides known. */
function cacheHit(usage: ChatSessionUsage | null): string | null {
  if (usage === null) return null;
  const read = usage.cacheReadTokens;
  const input = usage.inputTokens;
  if (read === undefined || input === undefined) return null;
  const write = usage.cacheWriteTokens ?? 0;
  const denom = input + read + write;
  if (denom <= 0) return null;
  const raw = (read / denom) * 100;
  return raw > 0 && raw < 1 ? '<1' : String(Math.round(raw));
}

/**
 * The pressure tone runs a health ramp (green → amber → red); the reference
 * face shows a low reading in the ok ink, so neutral maps to --hud-ok here
 * rather than the default ink of the surrounding values.
 */
function toneClass(tone: MeterTone): string {
  return tone === 'warn'
    ? 'text-(--hud-warn)'
    : tone === 'danger'
      ? 'text-(--hud-fail)'
      : 'text-(--hud-ok)';
}

function Label({ children }: { children: string }) {
  return (
    <span className="font-hud text-[length:var(--hud-label-size)] leading-none tracking-normal text-(--hud-dim) uppercase @sm:tracking-[0.12em]">
      {children}
    </span>
  );
}

/**
 * A label that keeps its full engraved word on the wide face and its letter
 * on the phone face (READ → R, WRITE → W). Both are always in the DOM; the
 * container query picks one, so the accessible name stays the full word.
 */
function AbbrLabel({ full, short }: { full: string; short: string }) {
  return (
    <span className="font-hud text-[length:var(--hud-label-size)] leading-none tracking-normal text-(--hud-dim) uppercase @sm:tracking-[0.12em]">
      <span className="hidden @sm:inline">{full}</span>
      <span className="inline @sm:hidden">{short}</span>
    </span>
  );
}

function Value({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'font-hud text-[length:var(--hud-value-size)] leading-none tabular-nums text-(--hud-ink)',
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A hairline between the middle cluster's cells (never around the ends). */
function Rule() {
  return <span aria-hidden="true" className="h-3 w-px shrink-0 bg-(--hud-track)" />;
}

/** One segment gauge; the phone face renders the compact count. */
function Segments({
  pct,
  tone,
  count,
  compactFace,
}: {
  pct: number;
  tone: MeterTone;
  count: number;
  compactFace: boolean;
}) {
  const filled = Math.min(count, Math.max(0, Math.ceil((pct / 100) * count)));
  return (
    <span
      data-slot="hud-bar"
      data-compact={compactFace ? 'true' : 'false'}
      aria-hidden="true"
      className={cn(
        'items-center',
        compactFace ? 'flex gap-[1px] @sm:hidden' : 'hidden gap-[2px] @sm:flex',
      )}
    >
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          data-slot="hud-seg"
          data-on={i < filled ? 'true' : 'false'}
          data-tone={tone}
          className={cn(
            'h-2 rounded-[1px]',
            compactFace ? 'w-[2px]' : 'w-[3px]',
            i < filled
              ? tone === 'warn'
                ? 'bg-(--hud-warn)'
                : tone === 'danger'
                  ? 'bg-(--hud-fail)'
                  : 'bg-(--hud-fill)'
              : 'bg-(--hud-track)',
          )}
        />
      ))}
    </span>
  );
}

export interface SessionHudProps {
  /** Context occupancy from the fold (null when the adapter reports none). */
  usage: ComposerUsage | null;
  /** Session-cumulative token totals (null until a countable turn). */
  sessionUsage: ChatSessionUsage | null;
  /** Loaded-transcript edit totals (null when nothing was edited). */
  files?: HudEditStats | null;
  /** Older history is not loaded: the FILES count is a lower bound. */
  historyPartial?: boolean;
}

export function SessionHud({
  usage,
  sessionUsage,
  files = null,
  historyPartial = false,
}: SessionHudProps) {
  const { t } = useI18n();
  const pressure = contextPressure(usage);
  const totals = sessionTotals(sessionUsage);
  const hit = cacheHit(sessionUsage);

  const noData = t('chat.hudNoData');

  const contextTitle =
    pressure !== null
      ? t('chat.hudContextTitle', {
          used: formatTokens(pressure.used),
          size: formatTokens(pressure.size),
          pct: String(Math.round(pressure.pct)),
        })
      : noData;
  const tokensTitle =
    totals !== null
      ? t('chat.hudTokensTitle', {
          total: compact(totals.total),
          turns: String(totals.turns),
          input: totals.input !== undefined ? compact(totals.input) : '--',
          output: totals.output !== undefined ? compact(totals.output) : '--',
        })
      : noData;
  const readTitle =
    totals?.read !== undefined
      ? t('chat.hudReadTitle', { read: compact(totals.read) })
      : noData;
  const writeTitle =
    totals?.write !== undefined
      ? t('chat.hudWriteTitle', { write: compact(totals.write) })
      : noData;
  const hitTitle =
    hit !== null ? t('chat.hudHitTitle', { pct: hit }) : noData;
  const reqTitle =
    totals !== null ? t('chat.hudReqTitle', { count: String(totals.turns) }) : noData;
  const filesTitle =
    files !== null
      ? [
          t('chat.hudFilesTitle', {
            files: String(files.files),
            added: String(files.added),
            removed: String(files.removed),
          }),
          ...(files.pathless ? [t('chat.hudFilesPathless')] : []),
          ...(historyPartial ? [t('chat.hudFilesPartial')] : []),
          ...files.list
            .slice(0, 5)
            .map((f) => `${f.path} +${String(f.added)} −${String(f.removed)}`),
          ...(files.list.length > 5
            ? [t('chat.hudFilesMore', { count: String(files.list.length - 5) })]
            : []),
        ].join('\n')
      : t('chat.hudFilesTitle', { files: '0', added: '0', removed: '0' });

  return (
    <div data-slot="session-hud-slot" className="relative h-(--hud-h)">
      <section
        data-slot="session-hud"
        data-surface="hud"
        aria-label={t('chat.hudAria')}
        className="@container absolute inset-x-0 top-0 flex h-[calc(var(--hud-h)+var(--radius-xl)+2px)] items-stretch justify-between overflow-x-auto rounded-t-[var(--radius-xl)] bg-(--hud-bg) px-0.5 pb-[calc(var(--radius-xl)+2px)] text-(--hud-ink) [scrollbar-width:none] @sm:px-2"
      >
        {/* CTX — occupancy gauge on the left. */}
        <div
          data-slot="hud-slot"
          data-kind="ctx"
          className={cn('flex shrink-0 items-center', SLOT_MIN.ctx)}
        >
          {pressure !== null ? (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  data-slot="hud-cell"
                  data-kind="ctx"
                  aria-label={contextTitle}
                  title={contextTitle}
                  className="focus-visible:ring-ring/50 flex shrink-0 items-center gap-0.5 px-0.5 transition-colors hover:bg-(--hud-hover) focus-visible:ring-[3px] focus-visible:outline-none @sm:gap-1 @sm:px-1.5 @2xl:gap-2 @2xl:px-2"
                >
                  <Label>{t('chat.hudContext')}</Label>
                  <Segments pct={pressure.pct} tone={pressure.tone} count={SEGMENTS} compactFace={false} />
                  <Segments
                    pct={pressure.pct}
                    tone={pressure.tone}
                    count={SEGMENTS_COMPACT}
                    compactFace
                  />
                  <Value className={cn(toneClass(pressure.tone), 'font-medium')}>
                    {String(Math.round(pressure.pct))}%
                  </Value>
                  <span className="font-hud text-[length:var(--hud-value-size)] hidden leading-none tabular-nums text-(--hud-dim) @2xl:inline">
                    {formatTokens(pressure.used).toUpperCase()}/
                    {formatTokens(pressure.size).toUpperCase()}
                  </span>
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-64 space-y-2 p-3">
                <ContextDetails usage={usage} />
              </PopoverContent>
            </Popover>
          ) : (
            // Fixed face, no reading yet: the gauge sits dark, the value is
            // an explicit unknown — never a fake zero, never absent.
            <div
              data-slot="hud-cell"
              data-kind="ctx"
              data-unknown="true"
              className="flex shrink-0 items-center gap-2 px-2 @max-2xl:gap-1 @max-2xl:px-1.5 @max-sm:gap-1 @max-sm:px-0.5"
            >
              <Label>{t('chat.hudContext')}</Label>
              <span
                data-slot="hud-bar"
                data-compact="false"
                aria-hidden="true"
                className="hidden items-center gap-[2px] @sm:flex"
              >
                {Array.from({ length: SEGMENTS }, (_, i) => (
                  <span key={i} data-slot="hud-seg" data-on="false" className="h-2 w-[3px] rounded-[1px] bg-(--hud-track)" />
                ))}
              </span>
              <span
                data-slot="hud-bar"
                data-compact="true"
                aria-hidden="true"
                className="flex items-center gap-[1px] @sm:hidden"
              >
                {Array.from({ length: SEGMENTS_COMPACT }, (_, i) => (
                  <span key={i} data-slot="hud-seg" data-on="false" className="h-2 w-[2px] rounded-[1px] bg-(--hud-track)" />
                ))}
              </span>
              <Value>--</Value>
            </div>
          )}
        </div>

        {/* The token/cache cluster: TOK | READ | WRITE | HIT | REQ. */}
        <div className="flex shrink-0 items-center">
          <div
            data-slot="hud-slot"
            data-kind="tok"
            className={cn('flex shrink-0 items-center', SLOT_MIN.tok)}
          >
            <div
              data-slot="hud-cell"
              data-kind="tok"
              data-unknown={totals !== null ? undefined : 'true'}
              role="group"
              aria-label={tokensTitle}
              title={tokensTitle}
              className="flex shrink-0 items-center gap-0.5 px-0.5 @sm:gap-1 @sm:px-1.5 @2xl:gap-2 @2xl:px-2"
            >
              <Label>{t('chat.hudTokens')}</Label>
              <Value>{totals !== null ? compact(totals.total) : '--'}</Value>
            </div>
          </div>

          <Rule />
          <div
            data-slot="hud-slot"
            data-kind="read"
            className={cn('flex shrink-0 items-center', SLOT_MIN.read)}
          >
            <div
              data-slot="hud-cell"
              data-kind="read"
              data-unknown={totals?.read !== undefined ? undefined : 'true'}
              role="group"
              aria-label={readTitle}
              title={readTitle}
              className="flex shrink-0 items-center gap-0.5 px-0.5 @sm:gap-1 @sm:px-1.5 @2xl:gap-2 @2xl:px-2"
            >
              <AbbrLabel full={t('chat.hudRead')} short="R" />
              <Value>{totals?.read !== undefined ? compact(totals.read) : '--'}</Value>
            </div>
          </div>

          <Rule />
          <div
            data-slot="hud-slot"
            data-kind="write"
            className={cn('flex shrink-0 items-center', SLOT_MIN.write)}
          >
            <div
              data-slot="hud-cell"
              data-kind="write"
              data-unknown={totals?.write !== undefined ? undefined : 'true'}
              role="group"
              aria-label={writeTitle}
              title={writeTitle}
              className="flex shrink-0 items-center gap-0.5 px-0.5 @sm:gap-1 @sm:px-1.5 @2xl:gap-2 @2xl:px-2"
            >
              <AbbrLabel full={t('chat.hudWrite')} short="W" />
              <Value>{totals?.write !== undefined ? compact(totals.write) : '--'}</Value>
            </div>
          </div>

          <Rule />
          <div
            data-slot="hud-slot"
            data-kind="hit"
            className={cn('flex shrink-0 items-center', SLOT_MIN.hit)}
          >
            <div
              data-slot="hud-cell"
              data-kind="hit"
              data-unknown={hit !== null ? undefined : 'true'}
              role="group"
              aria-label={hitTitle}
              title={hitTitle}
              className="flex shrink-0 items-center gap-0.5 px-0.5 @sm:gap-1 @sm:px-1.5 @2xl:gap-2 @2xl:px-2"
            >
              <Label>{t('chat.hudHit')}</Label>
              <Value>{hit !== null ? `${hit}%` : '--'}</Value>
            </div>
          </div>

          <Rule />
          <div
            data-slot="hud-slot"
            data-kind="req"
            className={cn('flex shrink-0 items-center', SLOT_MIN.req)}
          >
            <div
              data-slot="hud-cell"
              data-kind="req"
              data-unknown={totals !== null ? undefined : 'true'}
              role="group"
              aria-label={reqTitle}
              title={reqTitle}
              className="flex shrink-0 items-center gap-0.5 px-0.5 @sm:gap-1 @sm:px-1.5 @2xl:gap-2 @2xl:px-2"
            >
              <Label>{t('chat.hudReq')}</Label>
              <Value>{totals !== null ? shortCount(totals.turns) : '--'}</Value>
            </div>
          </div>
        </div>

        {/* FILES — what the loaded transcript edited (real zero when none). */}
        <div
          data-slot="hud-slot"
          data-kind="files"
          className={cn('flex shrink-0 items-center', SLOT_MIN.files)}
        >
          <div
            data-slot="hud-cell"
            data-kind="files"
            data-zero={files === null ? 'true' : undefined}
            role="group"
            aria-label={filesTitle}
            title={filesTitle}
            className="flex shrink-0 items-center gap-0.5 px-0.5 @sm:gap-1 @sm:px-1.5 @2xl:gap-2 @2xl:px-2"
          >
            <Label>{t('chat.hudFiles')}</Label>
            <Value>{files !== null ? shortCount(files.files) : '0'}</Value>
            <Value className="text-(--hud-ok)">+{files !== null ? shortCount(files.added) : '0'}</Value>
            <Value className="text-(--hud-fail)">−{files !== null ? shortCount(files.removed) : '0'}</Value>
          </div>
        </div>
      </section>
    </div>
  );
}
