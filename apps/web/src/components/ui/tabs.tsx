import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';

import { cn } from '@/lib/utils';

/**
 * Radix Tabs, Signal-styled: a quiet segmented navigation — the active tab
 * is `text-foreground` with a bottom indicator; `--signal` stays reserved
 * for liveness and is never spent here.
 */
const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    data-slot="tabs-list"
    className={cn(
      'text-muted-foreground inline-flex h-10 items-center gap-1 border-b w-full justify-start rounded-none p-0',
      className,
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    data-slot="tabs-trigger"
    className={cn(
      'inline-flex items-center justify-center whitespace-nowrap border-b-2 border-transparent px-3 pb-2 pt-1.5 text-sm font-medium transition-colors',
      'hover:text-foreground focus-visible:ring-ring rounded-none outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
      'data-[state=active]:text-foreground data-[state=active]:border-foreground data-[state=active]:font-semibold',
      'disabled:pointer-events-none disabled:opacity-50',
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

/**
 * Content pane. The machine detail page renders every pane with
 * `forceMount` + `hidden` so form state survives tab switches for free —
 * the attribute rides Radix's own hidden mechanism when unforced.
 */
const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content ref={ref} className={cn('mt-6 outline-none', className)} {...props} />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
