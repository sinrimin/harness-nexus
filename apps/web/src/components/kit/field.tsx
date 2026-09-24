import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Label } from '@/components/ui/label';

/**
 * Field — label, control, hint, error (04-contract.md §2).
 *
 * The 45 hand-written `div.grid.gap-2 + Label + Input` blocks in the app differ
 * in nothing but their contents, and seven of them carry a `content-start`
 * patch with a comment explaining that the field stretches inside a taller grid
 * row. That patch is the primitive's job: `align-content: start` belongs here,
 * once.
 *
 * The error is `role="alert"` so a failed validation is announced, and the hint
 * explains a constraint the label cannot carry.
 */

type FieldProps = {
  label?: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  /** Rendered after the label inside the same row (a switch, a badge). */
  aside?: ReactNode;
  className?: string;
  children: ReactNode;
};

export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  aside,
  className,
  children,
}: FieldProps) {
  return (
    <div data-slot="field" className={cn('grid content-start gap-2', className)}>
      {label !== undefined || aside !== undefined ? (
        <div className="flex items-center gap-2">
          {label !== undefined ? (
            <Label htmlFor={htmlFor}>
              {label}
              {required === true ? (
                <span aria-hidden="true" className="text-danger">
                  *
                </span>
              ) : null}
            </Label>
          ) : null}
          {aside !== undefined ? <span className="ml-auto">{aside}</span> : null}
        </div>
      ) : null}
      {children}
      {hint !== undefined && error === undefined ? (
        <p className="text-muted-foreground text-xs">{hint}</p>
      ) : null}
      {error !== undefined ? (
        <p role="alert" className="text-state-fail-ink text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}
