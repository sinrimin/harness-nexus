// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { ApiToolOutboundRules } from './api-tool.js';

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
   * #85 — the outbound DEFAULT action for API tool dials. `allow` (the
   * default): everything dials except the rule lists (they are BLACKLISTS).
   * `deny`: nothing dials except the rule lists (WHITELISTS). The lists are
   * split by network side; cloud-metadata/link-local ranges stay hard-denied
   * in every mode (that guard is not a policy).
   */
  apiToolOutbound: 'allow' | 'deny';
  apiToolOutboundRules: ApiToolOutboundRules;
  updatedAt: string;
}

export const DEFAULT_SYSTEM_SETTINGS: Pick<
  SystemSettings,
  'allowRegistration' | 'imageRetentionDays' | 'apiToolOutbound' | 'apiToolOutboundRules'
> = {
  allowRegistration: true,
  imageRetentionDays: 30,
  apiToolOutbound: 'allow',
  apiToolOutboundRules: { external: [], internal: [] },
};

/** Bounds for the retention setting (days). */
export const IMAGE_RETENTION_MIN = 1;
export const IMAGE_RETENTION_MAX = 3650;
