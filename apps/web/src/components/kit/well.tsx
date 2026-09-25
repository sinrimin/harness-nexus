import type { HTMLAttributes, ReactNode } from 'react';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useCopyFeedback } from '@/lib/clipboard';
import { useI18n } from '@/i18n';

/**
 * Well — the surface protocol material sits on (02-content.md §3.2).
 *
 * One surface, five geometries: a host name and a JSON config are the same
 * kind of thing (a string you may copy verbatim into a terminal) at different
 * sizes, so they share a material and differ only in shape. Signal cuts a
 * shallow trough into the page; BAY re-points --well at a dark LCD window —
 * the component never knows which.
 *
 * Long values truncate and offer a copy button. They never scroll, and never
 * fall back to a `title` tooltip: the value must be reachable (02-content.md §3.2).
 */

type WellVariant = 'text' | 'block' | 'chip' | 'code' | 'term' | 'diff';

type WellProps = HTMLAttributes<HTMLElement> & {
  variant?: WellVariant;
  /** The exact string to copy. Omit and no copy affordance renders. */
  copy?: string;
  /** Keep the copy affordance visible (commands) instead of hover-revealed. */
  copyAlways?: boolean;
  /** Status ink inside the well (--well-*), for values that carry state. */
  tone?: 'default' | 'ok' | 'warn' | 'fail';
  /** `text`/`chip` truncate by default; pass false to let them wrap. */
  truncate?: boolean;
  children?: ReactNode;
};

const TONE_CLASS: Record<NonNullable<WellProps['tone']>, string> = {
  default: 'text-well-ink',
  ok: 'text-well-ok',
  warn: 'text-well-warn',
  fail: 'text-well-fail',
};

export function Well({
  variant = 'text',
  copy,
  copyAlways,
  tone = 'default',
  truncate,
  className,
  children,
  ...props
}: WellProps) {
  const inline = variant === 'text' || variant === 'chip';
  const shouldTruncate = truncate ?? inline;

  return (
    <span
      data-surface="well"
      data-variant={variant}
      className={cn(
        'bg-well border-well-edge group/well relative min-w-0 border',
        inline ? 'inline-flex max-w-full items-center gap-1' : 'block',
        variant === 'chip' ? 'rounded-(--radius-well) px-1.5 py-px' : null,
        variant === 'text' ? 'rounded-(--radius-well) px-1.5 py-1' : null,
        variant === 'block' ? 'rounded-(--radius-well) px-2 py-1.5' : null,
        (variant === 'code' || variant === 'term' || variant === 'diff') &&
          'rounded-(--radius-well) px-2 py-1.5',
        variant === 'chip' ? 'role-data-sm' : 'role-data',
        TONE_CLASS[tone],
        className,
      )}
      {...props}
    >
      <span
        data-slot="well-value"
        className={cn(
          'min-w-0',
          shouldTruncate ? 'truncate' : null,
          variant === 'block' && !shouldTruncate ? 'break-all whitespace-pre-wrap' : null,
          (variant === 'code' || variant === 'term' || variant === 'diff') &&
            'block overflow-x-auto whitespace-pre',
        )}
      >
        {children}
      </span>
      {copy !== undefined ? (
        <CopyButton
          value={copy}
          always={copyAlways}
          className={inline ? undefined : 'absolute top-1 right-1'}
        />
      ) : null}
    </span>
  );
}

type CopyButtonProps = {
  value: string;
  label?: string;
  className?: string;
  /** Always visible (commands) instead of revealed on hover/focus. */
  always?: boolean;
};

/** The copy affordance: revealed on hover, always reachable by keyboard. */
export function CopyButton({ value, label, className, always }: CopyButtonProps) {
  const { t } = useI18n();
  const { copied, onCopy } = useCopyFeedback();
  const name = label ?? t('common.copy');
  return (
    <button
      type="button"
      data-slot="copy"
      className={cn(
        'text-well-dim hover:text-well-ink focus-visible:text-well-ink shrink-0 rounded-[2px] transition-opacity focus-visible:outline-none',
        always ? null : 'opacity-0 group-hover/well:opacity-100 focus-visible:opacity-100',
        '[@media(hover:none)]:opacity-100', // touch: no hover to reveal it
        className,
      )}
      aria-label={copied ? t('common.copied') : name}
      onClick={() => onCopy(value)}
    >
      {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
    </button>
  );
}
