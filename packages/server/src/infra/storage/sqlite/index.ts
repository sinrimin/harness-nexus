import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { UnitOfWork } from '@harness-nexus/core';
import { runMigrations } from './migrations.js';
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
  };
}
