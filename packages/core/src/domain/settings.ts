// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { ApiToolAllowlistEntry } from './api-tool.js';

/**
 * System-wide settings — a single-row aggregate persisted in `system_settings`.
 * Phase 1 uses `allowRegistration`; later fields append here without a new table.
 */
export interface SystemSettings {
  /** When false, `POST /api/auth/register` is rejected; admins use POST /api/users. */
  allowRegistration: boolean;
  /**
   * #59 — how many days an assistant image blob lives. The value is STAMPED on
   * each blob at ingest; changing the setting affects future ingests only,
   * never already-stamped objects.
   */
  imageRetentionDays: number;
  /**
   * #80 — the API tool runtime's default-DENY host allowlist. Empty (the
   * default) = no outbound API tool traffic at all.
   */
  apiToolAllowlist: ApiToolAllowlistEntry[];
  updatedAt: string;
}

export const DEFAULT_SYSTEM_SETTINGS: Pick<
  SystemSettings,
  'allowRegistration' | 'imageRetentionDays' | 'apiToolAllowlist'
> = {
  allowRegistration: true,
  imageRetentionDays: 30,
  apiToolAllowlist: [],
};

/** Bounds for the retention setting (days). */
export const IMAGE_RETENTION_MIN = 1;
export const IMAGE_RETENTION_MAX = 3650;
