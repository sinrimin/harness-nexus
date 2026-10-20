// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import type { UnitOfWork } from '@harness-nexus/core';
import { runMigrations } from './migrations.js';
import { sqliteFileBlobRepository } from './file-blobs.js';
import {
  sqliteUserRepository,
  sqlitePatRepository,
  sqliteSettingsRepository,
  sqliteCredentialRepository,
  sqliteMcpServerRepository,
  sqliteProfileRepository,
  sqliteResourceRepository,
  sqliteMachineRepository,
  sqliteInventoryRepository,
  sqliteJobRepository,
  sqliteAgentInstanceRepository,
  sqliteRuntimeConfigRepository,
  sqliteLlmProviderRepository,
  sqliteAssistantRepository,
} from './repos.js';

/**
 * SQLite storage driver (default).
 *
 * Opens a single connection (better-sqlite3 is synchronous), runs migrations,
 * and returns a UnitOfWork.
 */
export function createSqliteUnitOfWork(dbPath: string): UnitOfWork {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  // #59 — image blobs live beside the database file (same volume/mount); a
  // memory database has no durable location, so its payloads get a throwaway
  // temp dir (tests only).
  const filesDir =
    dbPath === ':memory:'
      ? join(tmpdir(), `hnx-files-${randomUUID()}`)
      : join(dirname(dbPath), 'files');

  return {
    users: sqliteUserRepository(db),
    tokens: sqlitePatRepository(db),
    settings: sqliteSettingsRepository(db),
    credentials: sqliteCredentialRepository(db),
    mcpServers: sqliteMcpServerRepository(db),
    profiles: sqliteProfileRepository(db),
    resources: sqliteResourceRepository(db),
    machines: sqliteMachineRepository(db),
    inventories: sqliteInventoryRepository(db),
    jobs: sqliteJobRepository(db),
    agentInstances: sqliteAgentInstanceRepository(db),
    runtimeConfigs: sqliteRuntimeConfigRepository(db),
    llmProviders: sqliteLlmProviderRepository(db),
    assistants: sqliteAssistantRepository(db),
    fileBlobs: sqliteFileBlobRepository(db, filesDir),
  };
}
