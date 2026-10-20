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
