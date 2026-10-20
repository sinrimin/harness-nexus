// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

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
  updatedAt: string;
}

export const DEFAULT_SYSTEM_SETTINGS: Pick<
  SystemSettings,
  'allowRegistration' | 'imageRetentionDays'
> = {
  allowRegistration: true,
  imageRetentionDays: 30,
};

/** Bounds for the retention setting (days). */
export const IMAGE_RETENTION_MIN = 1;
export const IMAGE_RETENTION_MAX = 3650;
