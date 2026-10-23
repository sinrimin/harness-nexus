// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { z } from 'zod';

/**
 * System settings beyond the registration toggle (#59). The image-retention
 * knob: days an assistant image blob lives, STAMPED on each blob at ingest —
 * changing the setting never rewrites already-stamped objects.
 */
export const updateImageRetentionSchema = z.object({
  imageRetentionDays: z.number().int().min(1).max(3650),
});
export type UpdateImageRetentionInput = z.infer<typeof updateImageRetentionSchema>;

/** #80 — the API tool runtime's default-deny host allowlist (admin-managed). */
export const apiToolAllowlistEntrySchema = z.object({
  host: z
    .string()
    .min(1)
    .max(253)
    .regex(
      /^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$|^\d{1,3}(\.\d{1,3}){3}$/i,
      'hostname, *.domain wildcard, or an IP literal',
    ),
  /** Permit private/loopback resolutions for this named host (intranet APIs). */
  internal: z.boolean().optional(),
});
export const updateApiToolAllowlistSchema = z.object({
  entries: z.array(apiToolAllowlistEntrySchema).max(256),
});
export type UpdateApiToolAllowlistInput = z.infer<typeof updateApiToolAllowlistSchema>;

/** #85 — the API tool outbound host policy (admin-managed). */
export const updateApiToolOutboundSchema = z.object({
  outbound: z.enum(['open', 'restricted']),
});
export type UpdateApiToolOutboundInput = z.infer<typeof updateApiToolOutboundSchema>;
