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
 * #124 — the session HUD, the band UNDER the Sender's top edge:
 *
 *   CTX ▮▮▯▯▯▯▯▯ 17% 34.1K/200K │ TOK ↑34.1K ↓1.2K │ CACHE 84% │ FILES 3 +42 −7
 *
 * The Sender keeps its full rounded rectangle; this strip is a sibling that
 * carries a 26px spacer in flow and then extends BEHIND the card (absolute,
 * radius + 2px deeper than the visible strip). The card's opaque background
 * and rounded top corners therefore cut the strip's bottom edge into the
 * concave corners of a slider-phone body: the Sender is on top, the band
 * slides out from under it. The assembly's single shadow and the card's own
 * border fall on the band at the seam — the strip carries no shadow or border
 * of its own, so both surfaces read as one device's physics.
 *
 * The readings sit on the strip's FLOOR — 2px above the Sender's first row —
 * so the band reads as a header moulded into the card rather than a label
 * parked in its middle.
 *
 * Material is the always-dark instrument glass (`data-surface="hud"`); every
 * colour and size is a `--hud-*` token, so BAY repaints it as its inverted LCD
 * window without touching this file. Labels are English in BOTH locales
 * (`CTX/TOK/CACHE/FILES`): the strip is an engraved instrument face, the same
 * exception as the nav-group labels; accessible names carry the full phrases.
 *
 * Honesty: a cell renders only when its source reported the value (never 0 for
 * unknown), and the whole strip returns null when it has nothing to say.
 */

const SEGMENTS = 10;

/** "34.1k" → "34.1K" — the HUD reads in instrument case. */
function compact(n: number): string {
  return formatTokens(n).toUpperCase();
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
    <span className="font-hud text-[length:var(--hud-label-size)] leading-none tracking-[0.08em] text-(--hud-dim) uppercase">
      {children}
    </span>
  );
}

function Value({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'font-mono text-[length:var(--hud-value-size)] leading-none tabular-nums text-(--hud-ink)',
        className,
      )}
    >
      {children}
    </span>
  );
}

function Divider() {
  return <span aria-hidden="true" className="my-1.5 w-px shrink-0 bg-(--hud-rule)" />;
}

export interface SessionHudProps {
  /** Context occupancy from the fold (null when the adapter reports none). */
  usage: ComposerUsage | null;
  /** Daemon session-cumulative token totals (null until a countable turn). */
  sessionUsage: ChatSessionUsage | null;
  /** Loaded-transcript edit totals (null when nothing was edited). */
  files: HudEditStats | null;
  /** Older history is not loaded: the FILES count is a lower bound. */
  historyPartial: boolean;
}

export function SessionHud({ usage, sessionUsage, files, historyPartial }: SessionHudProps) {
  const { t } = useI18n();
  const pressure = contextPressure(usage);
  const tokens =
    sessionUsage !== null &&
    (sessionUsage.inputTokens !== undefined || sessionUsage.outputTokens !== undefined)
      ? sessionUsage
      : null;
  const cache = cacheHit(tokens);

  if (pressure === null && tokens === null && cache === null && files === null) return null;

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
    files !== null
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
          ...(files.list.length > 5 ? [`+${String(files.list.length - 5)} more`] : []),
        ].join('\n')
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
        className="@container absolute inset-x-0 top-0 flex h-[calc(var(--hud-h)+var(--radius-xl)+2px)] items-stretch justify-between overflow-x-auto rounded-t-[var(--radius-xl)] bg-(--hud-bg) pb-[calc(var(--radius-xl)+2px)] text-(--hud-ink) [scrollbar-width:none]"
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
                className="focus-visible:ring-ring/50 flex shrink-0 items-end gap-2 px-3 pb-0.5 transition-colors hover:bg-(--hud-hover) focus-visible:ring-[3px] focus-visible:outline-none @max-2xl:gap-1 @max-2xl:px-1.5 @max-sm:px-1"
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
                <span className="font-mono text-[length:var(--hud-value-size)] leading-none tabular-nums text-(--hud-dim) @max-2xl:hidden">
                  {formatTokens(pressure.used).toUpperCase()}/
                  {formatTokens(pressure.size).toUpperCase()}
                </span>
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-64 space-y-2 p-3">
              <ContextDetails usage={usage} />
            </PopoverContent>
          </Popover>
        ) : null}

        {tokens !== null ? (
          <>
            <Divider />
            <div
              data-slot="hud-cell"
              data-kind="tok"
              role="group"
              aria-label={tokensTitle}
              title={tokensTitle}
              className="flex shrink-0 items-end gap-2 px-3 pb-0.5 @max-2xl:gap-1 @max-2xl:px-1.5 @max-sm:px-1"
            >
              <Label>{t('chat.hudTokens')}</Label>
              {tokens.inputTokens !== undefined ? (
                <Value>
                  <span className="text-(--hud-dim)">↑</span>
                  {compact(tokens.inputTokens)}
                </Value>
              ) : null}
              {tokens.outputTokens !== undefined ? (
                <Value>
                  <span className="text-(--hud-dim)">↓</span>
                  {compact(tokens.outputTokens)}
                </Value>
              ) : null}
            </div>
          </>
        ) : null}

        {cache !== null ? (
          <>
            <Divider />
            <div
              data-slot="hud-cell"
              data-kind="cache"
              role="group"
              aria-label={cacheTitle}
              title={cacheTitle}
              className="flex shrink-0 items-end gap-2 px-3 pb-0.5 @max-2xl:gap-1 @max-2xl:px-1.5 @max-sm:px-1"
            >
              <Label>{t('chat.hudCache')}</Label>
              <Value>{cache.pct}%</Value>
            </div>
          </>
        ) : null}

        {files !== null ? (
          <>
            <Divider />
            <div
              data-slot="hud-cell"
              data-kind="files"
              role="group"
              aria-label={filesTitle}
              title={filesTitle}
              className="flex shrink-0 items-end gap-2 px-3 pb-0.5 @max-2xl:gap-1 @max-2xl:px-1.5 @max-sm:px-1"
            >
              <Label>{t('chat.hudFiles')}</Label>
              <Value>{files.files > 0 ? String(files.files) : '?'}</Value>
              {files.added > 0 ? (
                <Value className="text-(--hud-ok)">+{String(files.added)}</Value>
              ) : null}
              {files.removed > 0 ? (
                <Value className="text-(--hud-fail)">−{String(files.removed)}</Value>
              ) : null}
            </div>
          </>
        ) : null}
      </section>
    </div>
  );
}
