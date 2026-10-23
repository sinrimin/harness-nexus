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
   * #80 — the API tool runtime's host allowlist. Enforced only while
   * `apiToolOutbound` is `restricted` (#85); kept and editable either way so
   * tightening later is a flip, not a rebuild.
   */
  apiToolAllowlist: ApiToolAllowlistEntry[];
  /**
   * #85 — the outbound host policy. `open` (the default): any http/https host
   * may be saved and dialed — the cloud-metadata/link-local ranges stay
   * hard-denied in EVERY mode (that guard is not a policy). `restricted`:
   * default-deny, only allowlisted hosts dial (internal-flagged entries may
   * resolve private/loopback).
   */
  apiToolOutbound: 'open' | 'restricted';
  updatedAt: string;
}

export const DEFAULT_SYSTEM_SETTINGS: Pick<
  SystemSettings,
  'allowRegistration' | 'imageRetentionDays' | 'apiToolAllowlist' | 'apiToolOutbound'
> = {
  allowRegistration: true,
  imageRetentionDays: 30,
  apiToolAllowlist: [],
  apiToolOutbound: 'open',
};

/** Bounds for the retention setting (days). */
export const IMAGE_RETENTION_MIN = 1;
export const IMAGE_RETENTION_MAX = 3650;
