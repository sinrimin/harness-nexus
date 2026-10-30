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
 * title line's right end, and no per-row borders — the machine rail separates
 * groups, not rows.
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
        'flex w-full items-start border-l-2 border-l-transparent py-2 pr-3 pl-[30px] text-left md:pr-8',
        active
          ? 'border-l-signal bg-signal/8 hover:bg-signal/12'
          : faded
            ? 'cursor-default'
            : 'hover:bg-tray/60',
        faded && !active && 'opacity-50',
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-xs',
              active && 'text-foreground font-semibold',
            )}
          >
            {title}
          </span>
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
        <DataText size="sm" tone="dim" className="mt-0.5 block truncate">
          {meta}
        </DataText>
      </span>
    </button>
  );
}
