// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { Database } from 'better-sqlite3';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FileBlobRepository, FileObject } from '@harness-nexus/core';
import { generateId } from '../../crypto.js';

interface FileObjectRow {
  id: string;
  mime_type: string;
  size: number;
  expires_at: string;
  created_at: string;
}

function toDomain(row: FileObjectRow): FileObject {
  return {
    id: row.id,
    mimeType: row.mime_type,
    size: row.size,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

/**
 * #59 — the sqlite file-blob driver: a small registry table in the database,
 * the BYTES on local disk (one file per object, named by its id, under the
 * data directory's `files/` folder — the same volume the SQLite file lives
 * on, so container mounts keep them together). No dedup: every ingest writes
 * its own object.
 *
 * better-sqlite3 is synchronous; the byte I/O stays synchronous too so a
 * put/get pair can never observe a half-written object (the DB row is
 * inserted only after the payload file exists).
 */
export function sqliteFileBlobRepository(db: Database, filesDir: string): FileBlobRepository {
  mkdirSync(filesDir, { recursive: true });
  const payloadOf = (id: string): string => join(filesDir, id);

  return {
    async put({ data, mimeType, expiresAt }) {
      const id = generateId();
      const now = new Date().toISOString();
      writeFileSync(payloadOf(id), data);
      db.prepare(
        `INSERT INTO file_objects (id, mime_type, size, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(id, mimeType, data.byteLength, expiresAt, now);
      return { id, mimeType, size: data.byteLength, expiresAt, createdAt: now };
    },

    async get(id) {
      const row = db.prepare('SELECT * FROM file_objects WHERE id = ?').get(id) as
        FileObjectRow | undefined;
      if (row === undefined) return null;
      try {
        return { row: toDomain(row), data: new Uint8Array(readFileSync(payloadOf(id))) };
      } catch {
        // The registry row exists but the payload is gone (hand-deleted file,
        // partially restored volume) — treat as missing, never half-truth.
        return null;
      }
    },

    async delete(id) {
      db.prepare('DELETE FROM file_objects WHERE id = ?').run(id);
      try {
        unlinkSync(payloadOf(id));
      } catch {
        // Already gone — delete is idempotent.
      }
    },

    async purgeExpired(now) {
      const rows = db.prepare('SELECT id FROM file_objects WHERE expires_at < ?').all(now) as {
        id: string;
      }[];
      for (const { id } of rows) {
        db.prepare('DELETE FROM file_objects WHERE id = ?').run(id);
        try {
          unlinkSync(payloadOf(id));
        } catch {
          // Payload already absent; the registry row is what matters.
        }
      }
      return rows.length;
    },
  };
}
