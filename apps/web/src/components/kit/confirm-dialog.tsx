import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Field } from './field';
import { LabelText } from './text';
import { Well } from './well';

/**
 * ConfirmDialog — a destructive action that says what it does
 * (03-interaction.md §2).
 *
 * The app had 19 native `confirm()` calls across 15 files. Native dialogs
 * cannot be styled, cannot be typeset in two languages, and — worse — they
 * cannot say *what will happen*: they ask "are you sure?" about something the
 * reader has to remember from the previous screen.
 *
 * Two tiers, by whether the action can be undone:
 *   - one confirmation: the ordinary delete;
 *   - `confirmPhrase`: the reader types the object's name (remove a machine,
 *     revoke a one-shot token, terminate a process, overwrite a config).
 * The action's name is passed in by the caller and must be the same words as
 * the button that opened this dialog and the toast that follows it.
 */

type Impact = { label?: ReactNode; value: ReactNode };

type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The action's own name: "Remove machine", not "Confirm". */
  title: ReactNode;
  /** What will happen, in prose. The consequence, never "are you sure". */
  consequence: ReactNode;
  /** The affected objects, as protocol material. */
  impact?: Impact[];
  /** Tier 2 — the exact string the reader must type (a name, a prefix). */
  confirmPhrase?: string;
  /** The confirm button's label; same words as `title`. */
  actionLabel: ReactNode;
  tone?: 'danger' | 'default';
  /**
   * Whether the generic "This cannot be undone." line is true. Defaults to the
   * danger tone, which is right for a destroyed secret or a revoked token — but
   * a two-stage delete is *not* irreversible, and claiming otherwise would be
   * the one thing this kit promises never to do.
   */
  irreversible?: boolean;
  /**
   * A PHYSICAL action: it reaches a running process or a piece of hardware —
   * terminate an adapter, decommission a machine — rather than deleting a
   * record. Separate from `irreversible` on purpose (revoking a token is
   * irreversible and not physical), and set by the caller because only the
   * caller knows: the base marks it, a skin decides what the mark looks like
   * (BAY's hazard stripe, 02-content.md §A.2 `.hazard`).
   */
  hazard?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
};

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  consequence,
  impact,
  confirmPhrase,
  actionLabel,
  tone = 'danger',
  irreversible,
  hazard,
  busy,
  onConfirm,
  children,
}: ConfirmDialogProps) {
  const { t } = useI18n();
  const [typed, setTyped] = useState('');

  // A typed confirmation never survives a close: reopening must start empty.
  useEffect(() => {
    if (!open) setTyped('');
  }, [open]);

  const armed = confirmPhrase === undefined || typed === confirmPhrase;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        data-surface="panel"
        data-slot="confirm-dialog"
        className={cn(
          'gap-0 overflow-hidden p-0 sm:max-w-lg',
          tone === 'danger' && 'border-l-danger border-l-[3px]',
        )}
      >
        <DialogHeader className="h-(--panel-head-h) flex-row items-center gap-2 border-b px-3">
          <DialogTitle className="role-label text-foreground">{title}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 p-(--panel-pad)">
          <DialogDescription className="text-foreground max-w-[68ch] text-sm">
            {consequence}
          </DialogDescription>
          {(irreversible ?? tone === 'danger') === true ? (
            <p className="text-muted-foreground text-xs">{t('kit.irreversible')}</p>
          ) : null}

          {impact !== undefined && impact.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {impact.map((item, i) => (
                <span key={i} className="inline-flex items-baseline gap-1.5">
                  {item.label !== undefined ? <LabelText size="sm">{item.label}</LabelText> : null}
                  <Well
                    variant="chip"
                    copy={typeof item.value === 'string' ? item.value : undefined}
                  >
                    {item.value}
                  </Well>
                </span>
              ))}
            </div>
          ) : null}

          {confirmPhrase !== undefined ? (
            <Field label={t('kit.typeToConfirm', { name: confirmPhrase })} htmlFor="confirm-phrase">
              <Input
                id="confirm-phrase"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                autoFocus
              />
            </Field>
          ) : null}

          {children}
        </div>

        <DialogFooter className="flex-row justify-end gap-2 border-t px-3 py-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy === true}
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            variant={tone === 'danger' ? 'destructive' : 'default'}
            {...(hazard === true ? { 'data-hazard': 'true' } : {})}
            onClick={onConfirm}
            disabled={busy === true || !armed}
          >
            {actionLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
