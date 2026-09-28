import * as React from 'react';
import { Popover as PopoverPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

/**
 * Popover primitive (Radix). A floating surface that is NOT a menu: it holds a
 * readout the user asked for, not a list of actions — so it borrows the
 * dropdown's MATERIAL without borrowing its role. The content classes are
 * deliberately the same family as `dropdown-menu-content` / `select-content`
 * (`bg-popover` + `border` + `shadow-md` + the same zoom-in), because a
 * floating surface should read as one device in the product whatever opened
 * it; a skin restyles them together or not at all.
 *
 * Defaults match how it is used here: anchored to the trigger's END (the
 * Sender sits at the right edge, so an end-aligned card stays on screen) and
 * above it by preference (the Sender is pinned to the bottom of the column,
 * and Radix flips when there is no room).
 */
function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverContent({
  className,
  align = 'end',
  side = 'top',
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        side={side}
        sideOffset={sideOffset}
        className={cn(
          'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 origin-(--radix-popover-content-transform-origin) rounded-md border shadow-md outline-none',
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverTrigger, PopoverContent };
