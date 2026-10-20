// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { ServerConfig } from '../../config.js';
import type { UnitOfWork } from '@harness-nexus/core';

/**
 * Storage factory — the single place a driver is chosen.
 *
 * Every driver returns the same `UnitOfWork` shape (defined in core), so the
 * rest of the server never knows which DB is running. Add new drivers here and
 * implement every repository on `UnitOfWork`; nothing else in the codebase
 * changes.
 */
export async function createStorage(config: ServerConfig): Promise<UnitOfWork> {
  switch (config.storageDriver) {
    case 'sqlite':
      return createSqliteStorage(config);
    case 'memory':
      return createMemoryStorage();
    default: {
      const _exhaustive: never = config.storageDriver;
      throw new Error(`Unknown storage driver: ${String(_exhaustive)}`);
    }
  }
}

async function createSqliteStorage(config: ServerConfig): Promise<UnitOfWork> {
  const { createSqliteUnitOfWork } = await import('./sqlite/index.js');
  return createSqliteUnitOfWork(config.sqlitePath);
}

async function createMemoryStorage(): Promise<UnitOfWork> {
  const { createMemoryUnitOfWork } = await import('./memory/index.js');
  return createMemoryUnitOfWork();
}
