// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { MIGRATIONS, runMigrations } from '../src/infra/storage/sqlite/migrations.js';

/**
 * #95 — the v32 data transform, tested against a hand-built v31 schema: one
 * provider row per legacy shape (chat, embedding carrier, systemone+decision,
 * official-base null) plus a user row. The runner only applies the pending
 * version, which is exactly the upgrade path production databases take.
 */

function v31Db(): import('better-sqlite3').Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE users (
      id            TEXT PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE,
      email         TEXT,
      password_hash TEXT,
      role          TEXT NOT NULL,
      status        TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE TABLE llm_providers (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      api             TEXT NOT NULL,
      base_url        TEXT,
      credential_name TEXT NOT NULL,
      scope           TEXT NOT NULL,
      owner_id        TEXT,
      models          TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );
  `);
  // every pre-v32 version is "applied" — the runner replays anything missing.
  const markApplied = db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)');
  for (const m of MIGRATIONS) {
    if (m.version < 32) markApplied.run(m.version, '2026-10-27T00:00:00Z');
  }
  return db;
}

function seedProvider(db: import('better-sqlite3').Database, row: Record<string, unknown>): void {
  db.prepare(
    `INSERT INTO llm_providers (id, name, api, base_url, credential_name, scope, owner_id, models, created_at, updated_at)
     VALUES (@id, @name, @api, @base_url, @credential_name, @scope, @owner_id, @models, @created_at, @updated_at)`,
  ).run({
    base_url: null,
    owner_id: null,
    models: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...row,
  });
}

describe('migration v32 — providers speak several wires (#95)', () => {
  it('maps every legacy row: api→apis, model type→apiKind, embedding carriers gain the wire', () => {
    const db = v31Db();
    seedProvider(db, {
      id: 'p-chat',
      name: 'plain chat',
      api: 'openai-chat',
      base_url: 'https://gw.example.com/v1',
      credential_name: 'k',
      scope: 'personal',
      owner_id: 'u1',
      models: JSON.stringify([
        { id: 'm-chat', type: 'chat' },
        { id: 'm-emb', type: 'embedding' },
      ]),
    });
    seedProvider(db, {
      id: 'p-decision',
      name: 'decider',
      api: 'systemone',
      base_url: 'https://dashscope.example.com/compatible-mode/v1',
      credential_name: 'k',
      scope: 'global',
      models: JSON.stringify([{ id: 'decision-model-preview', type: 'decision' }]),
    });
    seedProvider(db, {
      id: 'p-official',
      name: 'anthropic proper',
      api: 'anthropic',
      credential_name: 'k',
      scope: 'personal',
      owner_id: 'u1',
      models: null,
    });
    db.prepare(
      `INSERT INTO users (id, username, password_hash, role, status, created_at, updated_at)
       VALUES ('u1', 'alice', 'x', 'user', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    ).run();

    runMigrations(db);

    const chat = db
      .prepare('SELECT apis, models FROM llm_providers WHERE id = ?')
      .get('p-chat') as { apis: string; models: string };
    expect(JSON.parse(chat.apis)).toEqual([
      { kind: 'openai-chat', path: null },
      { kind: 'openai-embedding', path: null },
    ]);
    expect(JSON.parse(chat.models)).toEqual([
      { id: 'm-chat', apiKind: 'openai-chat' },
      { id: 'm-emb', apiKind: 'openai-embedding' },
    ]);

    const decision = db
      .prepare('SELECT apis, models FROM llm_providers WHERE id = ?')
      .get('p-decision') as { apis: string; models: string };
    expect(JSON.parse(decision.apis)).toEqual([{ kind: 'systemone', path: null }]);
    expect(JSON.parse(decision.models)).toEqual([
      { id: 'decision-model-preview', apiKind: 'systemone' },
    ]);

    const official = db
      .prepare('SELECT apis, base_url, models FROM llm_providers WHERE id = ?')
      .get('p-official') as { apis: string; base_url: string | null; models: string };
    expect(JSON.parse(official.apis)).toEqual([{ kind: 'anthropic', path: null }]);
    expect(official.base_url).toBeNull();
    expect(JSON.parse(official.models)).toEqual([]);

    // the dead `api` column is gone; users gained default_models (NULL).
    const providerCols = (
      db.prepare('PRAGMA table_info(llm_providers)').all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    expect(providerCols).not.toContain('api');
    expect(providerCols).toContain('apis');
    const user = db.prepare('SELECT default_models FROM users WHERE id = ?').get('u1') as {
      default_models: string | null;
    };
    expect(user.default_models).toBeNull();
  });
});
