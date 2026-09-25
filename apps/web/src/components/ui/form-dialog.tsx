import type { ReactNode } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/**
 * FormDialog — the shared MODAL CONTAINER for create/edit flows (Phase 9 W5).
 *
 * List pages keep their tables as the page body; every mutation form opens in
 * one of these instead of an always-mounted Card below the list. The shell is
 * the stock Dialog wrapper with fixed header/footer chrome and a size scale:
 *
 *   sm — single-field confirms (enroll, simple creates)
 *   md — default forms (credentials, users)
 *   lg — multi-field forms (MCP server, machine workspace picker)
 *   xl — tall editors (profile entry pickers, resource editors)
 *
 * Content scrolls inside the dialog (long forms never overflow the viewport).
 * Pages own the open flag (`creating` / `editing: T | 'new' | null`) and
 * conditionally render their form component, which wraps itself in this shell
 * with `open` always true — the Resources ResourceEditor is the reference.
 */

const SIZES = {
  sm: 'sm:max-w-sm',
  md: 'sm:max-w-lg',
  lg: 'sm:max-w-2xl',
  xl: 'sm:max-w-4xl',
} as const;

type FormDialogSize = keyof typeof SIZES;

interface FormDialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  size?: FormDialogSize;
  /** Action row pinned under the content (submit/cancel buttons). */
  footer?: ReactNode;
  children: ReactNode;
}

export function FormDialog({
  open,
  onClose,
  title,
  description,
  size = 'md',
  footer,
  children,
}: FormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent className={cn(SIZES[size], 'max-h-[calc(100svh-4rem)] gap-4 overflow-y-auto')}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description !== undefined ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {children}
        {footer !== undefined ? <DialogFooter>{footer}</DialogFooter> : null}
      </DialogContent>
    </Dialog>
  );
}
