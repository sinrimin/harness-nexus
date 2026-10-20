// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteUnitOfWork } from '../src/infra/storage/sqlite/index.js';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import { sqliteFileBlobRepository } from '../src/infra/storage/sqlite/file-blobs.js';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/infra/storage/sqlite/migrations.js';

/**
 * #59 — the file-blob drivers. The sqlite arm keeps a registry row in the DB
 * and the BYTES on local disk (never in SQLite); the memory arm keeps both
 * in a map. purgeExpired is the reclamation path; reads never resurrect what
 * it removed.
 */

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function sqliteHarness(): { dir: string; blobs: ReturnType<typeof sqliteFileBlobRepository> } {
  const dir = mkdtempSync(join(tmpdir(), 'hnx-blobs-'));
  tmpDirs.push(dir);
  const db = new Database(':memory:');
  runMigrations(db);
  return { dir, blobs: sqliteFileBlobRepository(db, join(dir, 'files')) };
}

describe('#59 file-blob drivers', () => {
  it('sqlite: round-trips bytes, keeps them on disk, never in the DB', async () => {
    const { dir, blobs } = sqliteHarness();
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const row = await blobs.put({
      data: bytes,
      mimeType: 'image/png',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(row.size).toBe(5);

    const got = await blobs.get(row.id);
    expect(got).not.toBeNull();
    expect([...got!.data]).toEqual([1, 2, 3, 4, 5]);
    expect(got!.row.mimeType).toBe('image/png');

    // The payload is a FILE; the DB table carries no bytes column at all.
    expect(readdirSync(join(dir, 'files'))).toEqual([row.id]);

    await blobs.delete(row.id);
    expect(await blobs.get(row.id)).toBeNull();
    expect(readdirSync(join(dir, 'files'))).toEqual([]);
  });

  it('sqlite: purgeExpired removes only what has passed its stamp', async () => {
    const { blobs } = sqliteHarness();
    const old = await blobs.put({
      data: new Uint8Array([1]),
      mimeType: 'image/png',
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    const fresh = await blobs.put({
      data: new Uint8Array([2]),
      mimeType: 'image/png',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(await blobs.purgeExpired('2026-01-01T00:00:00.000Z')).toBe(1);
    expect(await blobs.get(old.id)).toBeNull();
    expect(await blobs.get(fresh.id)).not.toBeNull();
    expect(await blobs.purgeExpired('2026-01-01T00:00:00.000Z')).toBe(0);
  });

  it('sqlite: a registry row whose payload file is gone reads as null', async () => {
    const { dir, blobs } = sqliteHarness();
    const row = await blobs.put({
      data: new Uint8Array([9]),
      mimeType: 'image/png',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    // Hand-delete the payload; the registry row stays.
    rmSync(join(dir, 'files', row.id));
    expect(await blobs.get(row.id)).toBeNull();
    // delete stays idempotent over the half-state.
    await blobs.delete(row.id);
    expect(await blobs.get(row.id)).toBeNull();
  });

  it('memory: round-trip + purge through the UnitOfWork', async () => {
    const uow = createMemoryUnitOfWork();
    const row = await uow.fileBlobs.put({
      data: new Uint8Array([7, 7]),
      mimeType: 'image/webp',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    const got = await uow.fileBlobs.get(row.id);
    expect([...got!.data]).toEqual([7, 7]);
    expect(await uow.fileBlobs.purgeExpired('2999-01-01T00:00:00.000Z')).toBe(1);
    expect(await uow.fileBlobs.get(row.id)).toBeNull();
  });

  it('sqlite unitOfWork wires fileBlobs beside the database file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hnx-uow-'));
    tmpDirs.push(dir);
    const uow = createSqliteUnitOfWork(join(dir, 'harnessnexus.sqlite'));
    const row = await uow.fileBlobs.put({
      data: new Uint8Array([3]),
      mimeType: 'image/gif',
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(readdirSync(join(dir, 'files'))).toEqual([row.id]);
  });
});
