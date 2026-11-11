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
import type { HudEditStats, HudToolCalls } from './hud-stats.js';

/**
 * #124 — the session HUD, the band UNDER the Sender's top edge:
 *
 *   CTX ▮▮▯▯▯▯▯▯ 17% 34.1K/200K   TOK ↑34.1K ↓1.2K   CACHE 84%   FILES 3 +42 −7
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
 * The readings are centred in the 18px strip, and each cell sits in a FIXED
 * slot (`SLOT_MIN`) in the order CTX · TOK · CACHE · FILES — a real HUD's
 * gauges don't shuffle when one goes dark; the slot stays and reads blank.
 * No divider rules between them: the strip is one glass face.
 *
 * Material is the always-dark instrument glass (`data-surface="hud"`); every
 * colour and size is a `--hud-*` token, so BAY repaints it as its inverted LCD
 * window without touching this file. Labels are English in BOTH locales
 * (`CTX/TOK/CACHE/FILES`): the strip is an engraved instrument face, the same
 * exception as the nav-group labels; accessible names carry the full phrases.
 *
 * Honesty (fixed-face revision, alpha.11): the strip is a FIXED instrument
 * face — labels and gauges always render, on both pages, in every state. An
 * UNKNOWN reads `--` (CTX/TOK/CACHE: no source reported yet — never a fake
 * zero); the fourth slot's zero state is a real number (`FILES 0 +0 −0`,
 * `TOOLS 0` — nothing ran is data, not absence). The strip never unmounts.
 */

const SEGMENTS = 10;

/**
 * Each cell owns a FIXED slot — a real HUD's gauges sit at fixed positions,
 * so a reading with nothing to report leaves its slot blank instead of
 * letting the neighbours slide into it. The mins hold each cell's typical
 * widest content (rig-measured: 186/99/77/110 desktop, 98/75/57/82 under the
 * 2xl container break, plus value-growth headroom); pathological values
 * (999K-class FILES) outgrow the min and ride the strip's horizontal scroll.
 * #128 — the fourth slot has TWO tenants: FILES (machine sessions) and
 * TOOLS (the assistant, whose work product is tool calls, not edits). The
 * occupant is fixed PER PAGE (a prop choice, never a live flip), and TOOLS
 * holds a shorter figure (label + one count), so its min is its own.
 */
const SLOT_MIN: Record<'ctx' | 'tok' | 'cache' | 'files' | 'tools', string> = {
  ctx: 'min-w-[190px] @max-2xl:min-w-[100px]',
  tok: 'min-w-[120px] @max-2xl:min-w-[80px]',
  cache: 'min-w-[80px] @max-2xl:min-w-[60px]',
  files: 'min-w-[150px] @max-2xl:min-w-[96px]',
  tools: 'min-w-[110px] @max-2xl:min-w-[72px]',
};

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

function cacheHit(
  usage: ChatSessionUsage | null,
): { pct: string; read: number; write: number; input: number } | null {
  if (usage === null) return null;
  const read = usage.cacheReadTokens;
  const input = usage.inputTokens;
  if (read === undefined || input === undefined) return null;
  const write = usage.cacheWriteTokens ?? 0;
  const denom = input + read + write;
  if (denom <= 0) return null;
  const raw = (read / denom) * 100;
  const pct = raw > 0 && raw < 1 ? '<1' : String(Math.round(raw));
  return { pct, read, write, input };
}

function toneClass(tone: MeterTone): string | undefined {
  return tone === 'warn'
    ? 'text-(--hud-warn)'
    : tone === 'danger'
      ? 'text-(--hud-fail)'
      : undefined;
}

function Label({ children }: { children: string }) {
  return (
    <span className="font-hud text-[length:var(--hud-label-size)] leading-none tracking-[0.12em] text-(--hud-dim) uppercase">
      {children}
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

/**
 * VT323 ships no arrow glyphs — the UA fallback is a smooth outline that
 * breaks the 1-bit face, and the triangles/`^`/`v` substitutes read wrong.
 * The token direction is therefore drawn on the same pixel grid as the
 * digits: a 5×9 arrow, one SVG unit per CSS pixel, crisp edges.
 */
function PixelArrow({ dir }: { dir: 'up' | 'down' }) {
  return (
    <svg
      viewBox="0 0 5 9"
      width="5"
      height="9"
      aria-hidden="true"
      shapeRendering="crispEdges"
      fill="currentColor"
      className="text-(--hud-dim)"
    >
      {dir === 'up' ? (
        <>
          <rect x="2" y="0" width="1" height="1" />
          <rect x="1" y="1" width="3" height="1" />
          <rect x="0" y="2" width="5" height="1" />
          <rect x="2" y="3" width="1" height="6" />
        </>
      ) : (
        <>
          <rect x="2" y="0" width="1" height="6" />
          <rect x="0" y="6" width="5" height="1" />
          <rect x="1" y="7" width="3" height="1" />
          <rect x="2" y="8" width="1" height="1" />
        </>
      )}
    </svg>
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
  /**
   * #128 — tool-call totals (the assistant's fourth slot's data). The slot's
   * TENANT is the `slot4` prop, not this value's nullity — a page passes its
   * tenant even before any data exists (the face is fixed).
   */
  toolCalls?: HudToolCalls | null;
  /**
   * #128 — the fourth slot's tenant: 'files' (machine sessions, the
   * default) or 'tools' (the assistant). Explicit per page so an empty
   * assistant still reads TOOLS 0, never FILES.
   */
  slot4?: 'files' | 'tools';
}

export function SessionHud({
  usage,
  sessionUsage,
  files = null,
  historyPartial = false,
  toolCalls = null,
  slot4 = 'files',
}: SessionHudProps) {
  const { t } = useI18n();
  const pressure = contextPressure(usage);
  const tokens =
    sessionUsage !== null &&
    (sessionUsage.inputTokens !== undefined || sessionUsage.outputTokens !== undefined)
      ? sessionUsage
      : null;
  const cache = cacheHit(tokens);

  const contextTitle =
    pressure !== null
      ? t('chat.hudContextTitle', {
          used: formatTokens(pressure.used),
          size: formatTokens(pressure.size),
          pct: String(Math.round(pressure.pct)),
        })
      : '';
  const tokensTitle =
    tokens !== null
      ? t('chat.hudTokensTitle', {
          turns: String(tokens.turns),
          input: tokens.inputTokens !== undefined ? compact(tokens.inputTokens) : '—',
          output: tokens.outputTokens !== undefined ? compact(tokens.outputTokens) : '—',
        })
      : '';
  const cacheTitle =
    cache !== null
      ? t('chat.hudCacheTitle', {
          read: compact(cache.read),
          write: compact(cache.write),
          input: compact(cache.input),
        })
      : '';
  const filesTitle =
    slot4 !== 'tools'
      ? files !== null
        ? [
            t('chat.hudFilesTitle', {
              files: files.files > 0 ? String(files.files) : '?',
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
        : // The fixed face's zero state: nothing edited in the loaded
          // transcript is a real zero, tooltip says so.
          t('chat.hudFilesTitle', { files: '0', added: '0', removed: '0' })
      : '';
  // #128 — unlike the #124 strings, the TOOLS tooltip IS localized: tool
  // names are protocol identifiers, but the sentence around them is copy.
  const toolsTitle =
    slot4 === 'tools'
      ? toolCalls !== null
        ? [
            t('chat.hudToolsTitle', { count: String(toolCalls.count) }),
            ...toolCalls.list.slice(0, 5).map((tc) => `${tc.name} ×${String(tc.n)}`),
            ...(toolCalls.list.length > 5
              ? [t('chat.hudToolsMore', { count: String(toolCalls.list.length - 5) })]
              : []),
          ].join('\n')
        : t('chat.hudToolsTitle', { count: '0' })
      : '';

  const filled =
    pressure !== null
      ? Math.min(SEGMENTS, Math.max(0, Math.ceil((pressure.pct / 100) * SEGMENTS)))
      : 0;

  return (
    <div data-slot="session-hud-slot" className="relative h-(--hud-h)">
      <section
        data-slot="session-hud"
        data-surface="hud"
        aria-label={t('chat.hudAria')}
        className="@container absolute inset-x-0 top-0 flex h-[calc(var(--hud-h)+var(--radius-xl)+2px)] items-stretch justify-between overflow-x-auto rounded-t-[var(--radius-xl)] bg-(--hud-bg) px-2 pb-[calc(var(--radius-xl)+2px)] text-(--hud-ink) [scrollbar-width:none]"
      >
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
                  className="focus-visible:ring-ring/50 flex shrink-0 items-center gap-2 px-3 transition-colors hover:bg-(--hud-hover) focus-visible:ring-[3px] focus-visible:outline-none @max-2xl:gap-1 @max-2xl:px-1.5 @max-sm:px-1"
                >
                  <Label>{t('chat.hudContext')}</Label>
                  <span
                    data-slot="hud-segments"
                    data-tone={pressure.tone}
                    aria-hidden="true"
                    className="flex items-center gap-[2px]"
                  >
                    {Array.from({ length: SEGMENTS }, (_, i) => (
                      <span
                        key={i}
                        data-slot="hud-seg"
                        data-on={i < filled ? 'true' : 'false'}
                        data-tone={pressure.tone}
                        className={cn(
                          'h-2 w-[3px] rounded-[1px]',
                          i < filled
                            ? pressure.tone === 'warn'
                              ? 'bg-(--hud-warn)'
                              : pressure.tone === 'danger'
                                ? 'bg-(--hud-fail)'
                                : 'bg-(--hud-fill)'
                            : 'bg-(--hud-track)',
                        )}
                      />
                    ))}
                  </span>
                  <Value className={toneClass(pressure.tone)}>
                    {String(Math.round(pressure.pct))}%
                  </Value>
                  <span className="font-hud text-[length:var(--hud-value-size)] leading-none tabular-nums text-(--hud-dim) @max-2xl:hidden">
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
              className="flex shrink-0 items-center gap-2 px-3 @max-2xl:gap-1 @max-2xl:px-1.5 @max-sm:px-1"
            >
              <Label>{t('chat.hudContext')}</Label>
              <span
                data-slot="hud-segments"
                data-unknown="true"
                aria-hidden="true"
                className="flex items-center gap-[2px]"
              >
                {Array.from({ length: SEGMENTS }, (_, i) => (
                  <span
                    key={i}
                    data-slot="hud-seg"
                    data-on="false"
                    className="h-2 w-[3px] rounded-[1px] bg-(--hud-track)"
                  />
                ))}
              </span>
              <Value>--</Value>
            </div>
          )}
        </div>

        <div
          data-slot="hud-slot"
          data-kind="tok"
          className={cn('flex shrink-0 items-center', SLOT_MIN.tok)}
        >
          {tokens !== null ? (
            <div
              data-slot="hud-cell"
              data-kind="tok"
              role="group"
              aria-label={tokensTitle}
              title={tokensTitle}
              className="flex shrink-0 items-center gap-2 px-3 @max-2xl:gap-1 @max-2xl:px-1.5 @max-sm:px-1"
            >
              <Label>{t('chat.hudTokens')}</Label>
              {tokens.inputTokens !== undefined ? (
                <Value className="flex items-center gap-0.5">
                  <PixelArrow dir="up" />
                  {compact(tokens.inputTokens)}
                </Value>
              ) : null}
              {tokens.outputTokens !== undefined ? (
                <Value className="flex items-center gap-0.5">
                  <PixelArrow dir="down" />
                  {compact(tokens.outputTokens)}
                </Value>
              ) : null}
            </div>
          ) : (
            // Fixed face: both directions hold their glyphs, values unknown.
            <div
              data-slot="hud-cell"
              data-kind="tok"
              data-unknown="true"
              className="flex shrink-0 items-center gap-2 px-3 @max-2xl:gap-1 @max-2xl:px-1.5 @max-sm:px-1"
            >
              <Label>{t('chat.hudTokens')}</Label>
              <Value className="flex items-center gap-0.5">
                <PixelArrow dir="up" />--
              </Value>
              <Value className="flex items-center gap-0.5">
                <PixelArrow dir="down" />--
              </Value>
            </div>
          )}
        </div>

        <div
          data-slot="hud-slot"
          data-kind="cache"
          className={cn('flex shrink-0 items-center', SLOT_MIN.cache)}
        >
          {cache !== null ? (
            <div
              data-slot="hud-cell"
              data-kind="cache"
              role="group"
              aria-label={cacheTitle}
              title={cacheTitle}
              className="flex shrink-0 items-center gap-2 px-3 @max-2xl:gap-1 @max-2xl:px-1.5 @max-sm:px-1"
            >
              <Label>{t('chat.hudCache')}</Label>
              <Value>{cache.pct}%</Value>
            </div>
          ) : (
            <div
              data-slot="hud-cell"
              data-kind="cache"
              data-unknown="true"
              className="flex shrink-0 items-center gap-2 px-3 @max-2xl:gap-1 @max-2xl:px-1.5 @max-sm:px-1"
            >
              <Label>{t('chat.hudCache')}</Label>
              <Value>--</Value>
            </div>
          )}
        </div>

        {/* #128 — the fourth fixed slot's tenant is the page's `slot4` prop:
        TOOLS on the assistant (its work product is tool calls), FILES on
        machine sessions. Both have a REAL zero state — nothing ran is data. */}
        <div
          data-slot="hud-slot"
          data-kind={slot4 === 'tools' ? 'tools' : 'files'}
          className={cn(
            'flex shrink-0 items-center',
            slot4 === 'tools' ? SLOT_MIN.tools : SLOT_MIN.files,
          )}
        >
          {slot4 === 'tools' ? (
            <div
              data-slot="hud-cell"
              data-kind="tools"
              role="group"
              aria-label={toolsTitle}
              title={toolsTitle}
              className="flex shrink-0 items-center gap-2 px-3 @max-2xl:gap-1 @max-2xl:px-1.5 @max-sm:px-1"
            >
              <Label>{t('chat.hudTools')}</Label>
              <Value>{toolCalls !== null ? shortCount(toolCalls.count) : '0'}</Value>
            </div>
          ) : files !== null ? (
            <div
              data-slot="hud-cell"
              data-kind="files"
              role="group"
              aria-label={filesTitle}
              title={filesTitle}
              className="flex shrink-0 items-center gap-2 px-3 @max-2xl:gap-1 @max-2xl:px-1.5 @max-sm:px-1"
            >
              <Label>{t('chat.hudFiles')}</Label>
              <Value>{files.files > 0 ? shortCount(files.files) : '?'}</Value>
              {files.added > 0 ? (
                <Value className="text-(--hud-ok)">+{shortCount(files.added)}</Value>
              ) : null}
              {files.removed > 0 ? (
                <Value className="text-(--hud-fail)">−{shortCount(files.removed)}</Value>
              ) : null}
            </div>
          ) : (
            <div
              data-slot="hud-cell"
              data-kind="files"
              data-zero="true"
              role="group"
              aria-label={filesTitle}
              title={filesTitle}
              className="flex shrink-0 items-center gap-2 px-3 @max-2xl:gap-1 @max-2xl:px-1.5 @max-sm:px-1"
            >
              <Label>{t('chat.hudFiles')}</Label>
              <Value>0</Value>
              <Value className="text-(--hud-ok)">+0</Value>
              <Value className="text-(--hud-fail)">−0</Value>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
