import type { ReactNode } from 'react';
import { HarnessNexusError } from '@harness-nexus/sdk';
import { cn } from '@/lib/utils';

/**
 * Note — the inline status surface (02-content.md §3.7).
 *
 * The one place a sentence is allowed to sit on protocol material: a `note`
 * carries an error code plus one line of explanation, which is exactly what a
 * toast cannot do (a toast is gone before you have read the code, and the page
 * behind it is left blank). Left rule 3px + 1px frame; four tones.
 *
 * This is the list-load-failure surface: the page keeps its shape, states what
 * failed, and offers the retry.
 */

type NoteTone = 'neutral' | 'ok' | 'warn' | 'fail';

const TONE_EDGE: Record<NoteTone, string> = {
  neutral: 'border-l-foreground/40',
  ok: 'border-l-ok',
  warn: 'border-l-warn',
  fail: 'border-l-danger',
};

type NoteProps = {
  tone?: NoteTone;
  title?: ReactNode;
  /** Error/status code, mono: `hnx/prompt-error`. */
  code?: ReactNode;
  action?: ReactNode;
  className?: string;
  children?: ReactNode;
};

export function Note({ tone = 'neutral', title, code, action, className, children }: NoteProps) {
  return (
    <div
      data-slot="note"
      data-tone={tone}
      role={tone === 'fail' || tone === 'warn' ? 'alert' : undefined}
      className={cn(
        'bg-card flex items-start gap-3 rounded-(--radius-panel) border border-l-[3px] px-3 py-2',
        TONE_EDGE[tone],
        className,
      )}
    >
      <div className="min-w-0 flex-1 text-sm">
        {title !== undefined ? <p className="text-foreground font-medium">{title}</p> : null}
        {code !== undefined ? (
          <p className="role-data text-muted-foreground mt-0.5 break-all">{code}</p>
        ) : null}
        {children !== undefined ? (
          <div className="text-muted-foreground mt-0.5 text-xs">{children}</div>
        ) : null}
      </div>
      {action !== undefined ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/**
 * Split a thrown value into the parts the UI shows. The code is the product's
 * error vocabulary (`hnx/…`) and must survive to the screen — a message alone
 * cannot be searched for or matched against the docs.
 */
export function errorParts(error: unknown): { code: string | null; message: string | null } {
  if (error instanceof HarnessNexusError) {
    return { code: error.code || null, message: error.message || null };
  }
  if (error instanceof Error) return { code: null, message: error.message || null };
  if (typeof error === 'string') return { code: null, message: error };
  if (typeof error === 'object' && error !== null) {
    // A transport may hand back a bare `{ code, message }` payload.
    const record = error as { code?: unknown; message?: unknown };
    return {
      code: typeof record.code === 'string' ? record.code : null,
      message: typeof record.message === 'string' ? record.message : null,
    };
  }
  return { code: null, message: null };
}
