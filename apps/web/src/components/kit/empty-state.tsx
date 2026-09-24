import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { DataText } from './text';
import { Well } from './well';

/**
 * EmptyState — an invitation, not a mood (02-content.md §3.9).
 *
 * The graphic is the comp's lamp sockets: a dashed lead with unlit positions,
 * which is the honest picture of "nothing is plugged in yet". Four lines, in
 * this order, none optional in spirit: the fact, the hint (what to do), the
 * machine-readable state (mono), the action.
 */

function LampSockets({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 140 26"
      aria-hidden="true"
      className={cn('h-6 w-[140px] text-muted-foreground/60', className)}
    >
      <g stroke="currentColor" strokeWidth="1" fill="none" strokeDasharray="3 3">
        <path d="M0 13H24" />
        <path d="M52 13H72" />
        <path d="M100 13H116" />
      </g>
      <g stroke="currentColor" strokeWidth="1">
        <circle cx="38" cy="13" r="6" fill="var(--lamp-off)" />
        <circle cx="86" cy="13" r="6" fill="var(--lamp-off)" />
        <circle cx="126" cy="13" r="6" fill="none" strokeDasharray="2 2" />
      </g>
    </svg>
  );
}

type EmptyStateProps = {
  title?: ReactNode;
  hint?: ReactNode;
  /** Machine-readable state, set in mono (e.g. an error/empty code). */
  code?: ReactNode;
  action?: ReactNode;
  className?: string;
};

export function EmptyState({ title, hint, code, action, className }: EmptyStateProps) {
  return (
    <div
      data-slot="empty-state"
      className={cn('flex flex-col items-center gap-2 px-6 py-8 text-center', className)}
    >
      <LampSockets />
      {title !== undefined ? <p className="text-foreground text-sm font-medium">{title}</p> : null}
      {hint !== undefined ? (
        <p className="text-muted-foreground max-w-[52ch] text-xs">{hint}</p>
      ) : null}
      {code !== undefined ? (
        <Well variant="chip" className="mt-1">
          <DataText size="sm">{code}</DataText>
        </Well>
      ) : null}
      {action !== undefined ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
