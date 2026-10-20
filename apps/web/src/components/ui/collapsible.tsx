// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import * as React from 'react';
import { Collapsible as CollapsiblePrimitive } from 'radix-ui';

/**
 * Thin shadcn-style wrapper around radix-ui's Collapsible primitive. Added in
 * Phase 2.4 for the MCP management row's expandable tool-inspection panel.
 * `radix-ui` is already a workspace dependency (the umbrella package re-exports
 * this primitive); this wrapper mirrors the `components/ui/*` convention.
 */
function Collapsible({
  className,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" className={className} {...props} />;
}

function CollapsibleTrigger({
  className,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Trigger>) {
  return (
    <CollapsiblePrimitive.Trigger
      data-slot="collapsible-trigger"
      className={className}
      {...props}
    />
  );
}

function CollapsibleContent({
  className,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Content>) {
  return (
    <CollapsiblePrimitive.Content
      data-slot="collapsible-content"
      className={className}
      {...props}
    />
  );
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
