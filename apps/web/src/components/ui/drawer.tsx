import * as React from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Drawer (right-side sheet) built from the same Radix Dialog primitives as
 * `ui/dialog.tsx` — the shadcn "Sheet" is exactly this composition. First
 * used by the Phase 9 W4 redacted config viewer; prefer this over a centered
 * dialog whenever the payload is tall content (files, logs) the user reads
 * alongside the page.
 */

function Drawer({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="drawer" {...props} />;
}

function DrawerContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal data-slot="drawer-portal">
      <DialogPrimitive.Overlay
        data-slot="drawer-overlay"
        className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 bg-scrim/50 fixed inset-0 z-50"
      />
      <DialogPrimitive.Content
        data-slot="drawer-content"
        className={cn(
          'bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-300 data-[state=open]:duration-300 fixed inset-y-0 right-0 z-50 flex h-full w-full flex-col border-l shadow-lg outline-none sm:max-w-xl',
          className,
        )}
        {...props}
      >
        {children}
        <DialogPrimitive.Close
          data-slot="drawer-close"
          className="text-muted-foreground hover:text-foreground focus-visible:ring-ring absolute top-4 right-4 rounded-xs opacity-70 transition-opacity outline-none focus-visible:ring-[3px] disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
        >
          <XIcon />
          <span className="sr-only">Close</span>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

function DrawerHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="drawer-header"
      className={cn('flex flex-col gap-1.5 border-b p-4 pr-12', className)}
      {...props}
    />
  );
}

function DrawerBody({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="drawer-body"
      className={cn('flex-1 overflow-y-auto p-4', className)}
      {...props}
    />
  );
}

function DrawerTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="drawer-title"
      className={cn('text-base leading-none font-semibold', className)}
      {...props}
    />
  );
}

function DrawerDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="drawer-description"
      className={cn('text-muted-foreground text-sm', className)}
      {...props}
    />
  );
}

export { Drawer, DrawerContent, DrawerDescription, DrawerHeader, DrawerBody, DrawerTitle };
