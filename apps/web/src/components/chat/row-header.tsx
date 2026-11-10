// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { ReactNode, Ref } from 'react';
import { ChevronDownIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';

/**
 * #121 — the ONE disclosure header every transcript row wears: tool cards,
 * the thinking row and sub-agent rows all read
 * `[lead][chevron] title · summary ⟶ readouts [running…]`. The anatomy used
 * to be hand-copied three times and the copies drifted (the thinking row's
 * chevron sat after its label, its label ran smaller and its whole row
 * lighter). Presentational only — each row owns its expand state, its
 * wrapper and its body.
 */
export interface RowHeaderProps {
  /** The leading mark — a tool icon or a status dot. Never shrinks (#72). */
  lead: ReactNode;
  title: ReactNode;
  summary?: ReactNode;
  /** `path` sets the summary in mono; `error` in the destructive ink. */
  summaryTone?: 'plain' | 'path' | 'error';
  summaryRef?: Ref<HTMLSpanElement>;
  /** Hover text for a truncated summary. */
  summaryTitle?: string;
  /** Right-hand readouts (line stats, duration), before the running label. */
  readouts?: ReactNode;
  /** Shows the trailing `running…` label. */
  running?: boolean;
  /** The row breathes on its header alone (the thinking row's live text). */
  breathing?: boolean;
  expandable: boolean;
  open: boolean;
  onToggle: () => void;
}

export function RowHeader({
  lead,
  title,
  summary,
  summaryTone = 'plain',
  summaryRef,
  summaryTitle,
  readouts,
  running = false,
  breathing = false,
  expandable,
  open,
  onToggle,
}: RowHeaderProps) {
  const { t } = useI18n();
  const hasSummary = summary !== undefined && summary !== null && summary !== '';
  return (
    <button
      type="button"
      aria-expanded={expandable ? open : undefined}
      disabled={!expandable}
      onClick={onToggle}
      className={cn(
        'flex h-6 min-w-0 flex-1 items-center gap-1.5 text-left',
        expandable ? 'hover:text-foreground' : 'cursor-default',
        breathing && 'lamp-breath',
      )}
    >
      <span className="flex shrink-0 items-center">{lead}</span>
      {expandable ? (
        <ChevronDownIcon
          className={cn('size-3 shrink-0 transition-transform', open && 'rotate-180')}
        />
      ) : null}
      <span className="text-muted-foreground shrink-0 font-medium">{title}</span>
      {hasSummary ? (
        <>
          <span className="text-muted-foreground/40" aria-hidden>
            ·
          </span>
          <span
            ref={summaryRef}
            title={summaryTitle}
            className={cn(
              'min-w-0 truncate',
              summaryTone === 'error'
                ? 'text-destructive'
                : summaryTone === 'path'
                  ? 'text-muted-foreground font-mono'
                  : 'text-muted-foreground',
            )}
          >
            {summary}
          </span>
        </>
      ) : null}
      <span className="min-w-0 flex-1" />
      {readouts}
      {running ? (
        <span className="text-muted-foreground shrink-0 text-[10px]">{t('chat.running')}</span>
      ) : null}
    </button>
  );
}

/** Elapsed time of a settled row, or null under the 400ms noise floor. */
export function elapsedLabel(startedAt: number, endedAt: number | undefined): string | null {
  return endedAt !== undefined && endedAt - startedAt > 400
    ? `${((endedAt - startedAt) / 1000).toFixed(1)}s`
    : null;
}

/** The duration readout at the header's right edge. */
export function DurationReadout({ label }: { label: string | null }) {
  return label !== null ? (
    <span className="text-muted-foreground/60 shrink-0 font-mono text-[10px] tabular-nums">
      {label}
    </span>
  ) : null;
}
