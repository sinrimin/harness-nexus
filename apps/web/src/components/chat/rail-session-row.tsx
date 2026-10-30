// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { DataText } from '@/components/kit';

/**
 * #99 — the session row shared by BOTH chat rails (machine + platform
 * assistant, desktop column and phone drawer). One device so the active
 * language cannot drift again: 2px `--signal` left edge at x=0 + 8% signal
 * tint (BAY swaps the tint for paper via `[data-skin]`), a status WORD at the
 * meta line's right end, and no per-row borders — the machine rail separates
 * groups, not rows. #104 — the word moved off the title line: a long title
 * and a status word competing for one 288px line truncated the thing the row
 * exists to show.
 *
 * State truth: `aria-current="true"` on the current row; `word` is real text
 * (`running` shows on the current row too; `open` is for NON-current attached
 * rows — the edge + tint already mark the current one). Every row reserves the
 * 2px edge so lighting it never shifts the text.
 */
export function RailSessionRow({
  title,
  meta,
  active = false,
  word = null,
  titleAttr,
  faded = false,
  disabled = false,
  onClick,
}: {
  title: string;
  /** The second line (relative time · short id) — data role, mono. */
  meta: string;
  active?: boolean;
  /** `running` (busy) or `open` (attached, idle, non-current); null = no word. */
  word?: 'running' | 'open' | null;
  /** The row's tooltip — a stale-model reason, a rejoin hint, the title. */
  titleAttr?: string | undefined;
  /** Stale rows: 50% opacity, no hover, no pointer. */
  faded?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      data-slot="session-row"
      aria-current={active ? 'true' : undefined}
      onClick={onClick}
      disabled={disabled}
      title={titleAttr}
      className={cn(
        // #99 review — md+ reserves the hover-trash slot on the right
        // (32px ≈ the 30px left hanging indent; the trash keeps the folder
        // header's `+` margin inside it), so the title's truncation point
        // never shifts when the trash fades in. Phone: no on-row trash (the
        // swipe reveal), keep the plain 12px.
        // #104 — the free (right) corners take the skin radius; the signal
        // edge stays anchored at x=0. Full-bleed rows otherwise read square
        // beside the plate's rounded current key (Signal 6px, BAY 2px — the
        // token keeps each skin's own language).
        'flex w-full items-start rounded-r-(--radius-well) border-l-2 border-l-transparent py-2 pr-3 pl-[30px] text-left md:pr-8',
        active
          ? 'border-l-signal bg-signal/8 hover:bg-signal/12'
          : faded
            ? 'cursor-default'
            : 'hover:bg-tray/60',
        faded && !active && 'opacity-50',
      )}
    >
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block truncate text-xs',
            active && 'text-foreground font-semibold',
          )}
        >
          {title}
        </span>
        <span className="mt-0.5 flex items-baseline gap-1.5">
          <DataText size="sm" tone="dim" className="min-w-0 flex-1 truncate">
            {meta}
          </DataText>
          {word !== null ? (
            <span
              className={cn(
                'shrink-0 text-[10px] leading-[15px] font-semibold',
                word === 'running' ? 'text-state-ok-ink' : 'text-signal-ink',
              )}
            >
              {word === 'running' ? t('chat.sessionRunning') : t('chat.sessionOpen')}
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );
}
