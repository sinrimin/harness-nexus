// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * #59 — one stored image blob. The bytes live OUTSIDE the database (the sqlite
 * driver writes them to a local files directory); this row is the registry the
 * persisted transcript blocks reference by `id`.
 */
export interface FileObject {
  id: string;
  mimeType: string;
  /** Byte length of the stored payload. */
  size: number;
  /**
   * Stamped at ingest from the then-current `imageRetentionDays` and never
   * rewritten — readers judge expiry against this field; the periodic sweep
   * only reclaims what has already passed it.
   */
  expiresAt: string;
  createdAt: string;
}
