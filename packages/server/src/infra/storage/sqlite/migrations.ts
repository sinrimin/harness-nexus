// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * SQLite schema migrations — append-only and idempotent.
 *
 * The runner tracks applied versions in `schema_version`. Only forward
 * migrations; no down/rollback in Phase 1.
 */
export interface Migration {
  version: number;
  description: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    description: 'initial schema (users, personal_access_tokens, system_settings)',
    sql: `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  email         TEXT,
  password_hash TEXT,
  role          TEXT NOT NULL DEFAULT 'user',
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS personal_access_tokens (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  prefix        TEXT NOT NULL,
  scopes        TEXT NOT NULL DEFAULT '[]',
  expires_at    TEXT,
  last_used_at  TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pat_user_id ON personal_access_tokens(user_id);

CREATE TABLE IF NOT EXISTS system_settings (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  allow_registration INTEGER NOT NULL DEFAULT 1,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_version (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
    `,
  },
  {
    version: 2,
    description: 'phase 2.1 — credentials and mcp_servers (connection config layer)',
    sql: `
CREATE TABLE IF NOT EXISTS credentials (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  secret     TEXT NOT NULL,
  scope      TEXT NOT NULL,
  owner_id   TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credentials_owner ON credentials(owner_id);
CREATE INDEX IF NOT EXISTS idx_credentials_scope ON credentials(scope);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  transport  TEXT NOT NULL,
  mode       TEXT NOT NULL DEFAULT 'proxy',
  scope      TEXT NOT NULL,
  owner_id   TEXT REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_owner ON mcp_servers(owner_id);
CREATE INDEX IF NOT EXISTS idx_mcp_servers_scope ON mcp_servers(scope);
    `,
  },
  {
    version: 3,
    description: 'phase 2.2 — profiles table',
    sql: `
CREATE TABLE IF NOT EXISTS profiles (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  version     TEXT NOT NULL DEFAULT '1.0.0',
  scope       TEXT NOT NULL,
  owner_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
  entries     TEXT NOT NULL DEFAULT '[]',
  imports     TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_profiles_owner ON profiles(owner_id);
CREATE INDEX IF NOT EXISTS idx_profiles_scope ON profiles(scope);
    `,
  },
  {
    version: 4,
    description: 'phase 4.2 — resources table (sub_agent/rule/skill/hook/command/mcp)',
    sql: `
CREATE TABLE IF NOT EXISTS resources (
  id          TEXT PRIMARY KEY,
  key         TEXT NOT NULL,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  version     TEXT NOT NULL DEFAULT '1.0.0',
  source      TEXT NOT NULL,
  scope       TEXT NOT NULL,
  owner_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
  targets     TEXT NOT NULL DEFAULT '[]',
  labels      TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_resources_owner ON resources(owner_id);
CREATE INDEX IF NOT EXISTS idx_resources_scope ON resources(scope);
CREATE INDEX IF NOT EXISTS idx_resources_kind  ON resources(kind);
    `,
  },
  {
    version: 5,
    description: 'phase 3.2 — profiles.target (immutable install target)',
    sql: `
ALTER TABLE profiles ADD COLUMN target TEXT NOT NULL DEFAULT 'generic';
    `,
  },
  {
    version: 6,
    description: 'phase 8 C1 — machines (enrolled via the Harness Nexus client)',
    sql: `
CREATE TABLE IF NOT EXISTS machines (
  id                 TEXT PRIMARY KEY,
  owner_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  hostname           TEXT,
  os                 TEXT,
  arch               TEXT,
  daemon_version     TEXT,
  capabilities       TEXT NOT NULL DEFAULT '[]',
  remote_chat_enabled INTEGER NOT NULL DEFAULT 0,
  enrollment_pat_id  TEXT NOT NULL,
  enrolled_at        TEXT NOT NULL,
  last_seen_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_machines_owner ON machines(owner_id);
CREATE INDEX IF NOT EXISTS idx_machines_pat   ON machines(enrollment_pat_id);
    `,
  },
  {
    version: 7,
    description:
      'phase 8 C2 — mcp_servers.mode → dial_site (proxy→auto, direct→client); credentials.distributable',
    sql: `
ALTER TABLE mcp_servers ADD COLUMN dial_site TEXT NOT NULL DEFAULT 'auto';
UPDATE mcp_servers SET dial_site = CASE WHEN mode = 'direct' THEN 'client' ELSE 'auto' END;
ALTER TABLE mcp_servers DROP COLUMN mode;

ALTER TABLE credentials ADD COLUMN distributable INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 8,
    description:
      'phase 8 C3 — latest inventory snapshot per (machine, target); report stored as a JSON document',
    sql: `
CREATE TABLE IF NOT EXISTS machine_inventory (
  id             TEXT PRIMARY KEY,
  machine_id     TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  target         TEXT NOT NULL,
  daemon_version TEXT,
  reported_at    TEXT NOT NULL,
  scanned_at     TEXT NOT NULL,
  report         TEXT NOT NULL,
  UNIQUE (machine_id, target)
);
    `,
  },
  {
    version: 9,
    description:
      'phase 8 C4 — replayable jobs + deployed agent instances (one per machine+profile)',
    sql: `
CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,
  machine_id  TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  owner_id    TEXT NOT NULL,
  type        TEXT NOT NULL,
  status      TEXT NOT NULL,
  payload     TEXT NOT NULL,
  result      TEXT,
  error       TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_machine ON jobs(machine_id);

CREATE TABLE IF NOT EXISTS agent_instances (
  id              TEXT PRIMARY KEY,
  machine_id      TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  owner_id        TEXT NOT NULL,
  target          TEXT NOT NULL,
  profile_id      TEXT NOT NULL,
  profile_version TEXT,
  name            TEXT NOT NULL,
  directory       TEXT NOT NULL,
  job_id          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (machine_id, profile_id)
);
    `,
  },
  {
    version: 10,
    description: 'ac_sessions (phase 8 C5 chat audit rows; no FKs by design)',
    sql: `
CREATE TABLE IF NOT EXISTS ac_sessions (
  id                TEXT PRIMARY KEY,
  agent_instance_id TEXT NOT NULL,
  machine_id        TEXT NOT NULL,
  owner_id          TEXT NOT NULL,
  opened_at         TEXT NOT NULL,
  closed_at         TEXT,
  close_reason      TEXT
);
-- Deliberately NO foreign keys: these rows are AUDIT records and must survive
-- machine deletion (machine delete closes them with 'machine-deleted' instead
-- of cascading — the documented asymmetry vs jobs/agent_instances).
CREATE INDEX IF NOT EXISTS idx_ac_sessions_machine ON ac_sessions(machine_id, closed_at);
CREATE INDEX IF NOT EXISTS idx_ac_sessions_agent ON ac_sessions(agent_instance_id, opened_at);
    `,
  },
  {
    version: 11,
    description:
      'phase 9 W1 — agent_instances.source + nullable profile_id/job_id (detected instances); machine_inventory.runtime',
    sql: `
-- agent_instances: detected instances (Phase 9 W1) carry no profile and no
-- job. SQLite cannot relax NOT NULL in place, so recreate the table. The
-- UNIQUE (machine_id, profile_id) survives: NULL profile_ids are distinct,
-- letting one detected row per (machine, target) coexist with deploy rows —
-- the sync layer keeps detected rows unique per pair.
CREATE TABLE IF NOT EXISTS agent_instances_v11 (
  id              TEXT PRIMARY KEY,
  machine_id      TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  owner_id        TEXT NOT NULL,
  target          TEXT NOT NULL,
  profile_id      TEXT,
  profile_version TEXT,
  source          TEXT NOT NULL DEFAULT 'deploy',
  name            TEXT NOT NULL,
  directory       TEXT NOT NULL,
  job_id          TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (machine_id, profile_id)
);
INSERT INTO agent_instances_v11
  (id, machine_id, owner_id, target, profile_id, profile_version, source, name, directory, job_id, created_at, updated_at)
SELECT id, machine_id, owner_id, target, profile_id, profile_version, 'deploy', name, directory, job_id, created_at, updated_at
FROM agent_instances;
DROP TABLE agent_instances;
ALTER TABLE agent_instances_v11 RENAME TO agent_instances;
CREATE INDEX IF NOT EXISTS idx_agent_instances_machine ON agent_instances(machine_id, target);

-- per-target runtime probe arm on the latest-snapshot row (null = the
-- reporting daemon build does not probe runtimes)
ALTER TABLE machine_inventory ADD COLUMN runtime TEXT;
    `,
  },
  {
    version: 12,
    description: 'phase 9 W3 — runtime provider configs (one row per machine × target)',
    sql: `
CREATE TABLE IF NOT EXISTS runtime_configs (
  id         TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  owner_id   TEXT NOT NULL,
  target     TEXT NOT NULL,
  spec       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (machine_id, target)
);
    `,
  },
  {
    version: 13,
    description: 'phase 9 W6 — machine base workspace + chat session cwd/title (portal chat)',
    sql: `
-- root under which chat sessions may pick their project cwd
ALTER TABLE machines ADD COLUMN base_workspace TEXT;

-- session working directory (project grouping) + derived display title
ALTER TABLE ac_sessions ADD COLUMN cwd TEXT;
ALTER TABLE ac_sessions ADD COLUMN title TEXT;
    `,
  },
  {
    version: 14,
    description:
      "phase 9 W7 — sessions are the AGENT's own (native list + resume); the platform keeps nothing",
    sql: `
-- AcSession audit rows are gone by design: session list/history/resume all
-- read the harness's own store through the daemon (wiki design-phase-9-w7-native-sessions.md).
DROP TABLE IF EXISTS ac_sessions;
    `,
  },
  {
    version: 15,
    description: 'phase 9 W10 — LLM provider catalog (reusable routes; the key stays a Credential)',
    sql: `
-- Name uniqueness is per (name, scope, owner), enforced read-then-write in
-- the route (mirrors the resources \`key\` rule — no composite unique index
-- over a nullable owner_id).
CREATE TABLE IF NOT EXISTS llm_providers (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  api             TEXT NOT NULL,
  base_url        TEXT,
  credential_name TEXT NOT NULL,
  scope           TEXT NOT NULL,
  owner_id        TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
    `,
  },
  {
    version: 16,
    description: 'issue #3 — per-target chat adapter pre-warm switches (machine-scoped)',
    sql: `
-- JSON of { 'claude-code', codex, deepseek } booleans per MACHINE (the idle
-- prewarmed processes live on the machine, so its owner decides); NULL on
-- rows written before the feature → readers apply the shared defaults.
ALTER TABLE machines ADD COLUMN chat_prewarm TEXT;
    `,
  },
  {
    version: 17,
    description: 'two-stage delete — soft-delete stamps for mcp_servers and resources',
    sql: `
-- deleted_at set = soft-deleted: hidden from management lists, greyed in
-- profile editors (saving strips the entry), skipped by every deploy path.
-- NULL on all pre-existing rows (= live). A second DELETE physically removes
-- the row once no profile references it.
ALTER TABLE mcp_servers ADD COLUMN deleted_at TEXT;
ALTER TABLE resources ADD COLUMN deleted_at TEXT;
    `,
  },
  {
    version: 18,
    description: 'issue #49 — per-target default chat permission modes (machine-scoped)',
    sql: `
-- JSON of { 'claude-code': string | null } per MACHINE; NULL on rows written
-- before the feature → no platform default (adapter-resolved mode).
ALTER TABLE machines ADD COLUMN chat_default_mode TEXT;
    `,
  },
  {
    version: 19,
    description: 'issue #51 — provider model registry (configured models on the provider row)',
    sql: `
-- JSON of ProviderModelConfig[] (whole-row read/write — the chat_prewarm
-- precedent, no cross-row queries worth a table). NULL on rows written before
-- the feature → readers map it to [].
ALTER TABLE llm_providers ADD COLUMN models TEXT;
    `,
  },
  {
    version: 20,
    description: 'issue #52 — platform assistant (configs, sessions, transcript, tool-call audit)',
    sql: `
-- All owner-only rows (no scope column: personal by construction, the #36
-- owner rule with no admin arm). Configs are soft-deleted (deleted_at set =
-- gone from pickers, sessions stay readable). The transcript is append-only
-- JSON items in seq order; the seq is caller-allocated and monotonic per
-- session, so (session_id, seq) is the natural identity.
CREATE TABLE IF NOT EXISTS assistant_configs (
  id                    TEXT PRIMARY KEY,
  owner_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  description           TEXT,
  provider_id           TEXT NOT NULL,
  default_model         TEXT NOT NULL,
  system_prompt_override TEXT,
  enabled_tool_groups   TEXT NOT NULL DEFAULT '[]',
  deleted_at            TEXT,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assistant_configs_owner ON assistant_configs(owner_id);
-- PARTIAL: a soft-deleted config frees its name for reuse; live rows stay
-- unique per owner.
CREATE UNIQUE INDEX IF NOT EXISTS idx_assistant_configs_owner_name
  ON assistant_configs(owner_id, name) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS assistant_sessions (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  assistant_id    TEXT NOT NULL REFERENCES assistant_configs(id) ON DELETE CASCADE,
  title           TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  last_message_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_assistant_sessions_owner ON assistant_sessions(owner_id);
CREATE INDEX IF NOT EXISTS idx_assistant_sessions_assistant ON assistant_sessions(assistant_id);

CREATE TABLE IF NOT EXISTS assistant_messages (
  session_id TEXT NOT NULL REFERENCES assistant_sessions(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  item       TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS assistant_tool_calls (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES assistant_sessions(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  tool        TEXT NOT NULL,
  args        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_assistant_tool_calls_session ON assistant_tool_calls(session_id);
    `,
  },
  {
    version: 21,
    description: 'issue #52 M2 — assistant config MCP server + skill resource references',
    sql: `
-- JSON of string ids (full replace on update). NULL on rows written before
-- M2 → readers map it to []. Visibility is enforced at save; dialability and
-- readability resolve at turn time (the pool / resource store decide).
ALTER TABLE assistant_configs ADD COLUMN mcp_server_ids TEXT;
ALTER TABLE assistant_configs ADD COLUMN skill_resource_ids TEXT;
    `,
  },
  {
    version: 22,
    description: 'issue #52 M3 — per-config daily token budget',
    sql: `
-- NULL = unlimited. Summed over the config's assistant turns per UTC day;
-- a cost guard enforced at turn start.
ALTER TABLE assistant_configs ADD COLUMN daily_token_budget INTEGER;
    `,
  },
  {
    version: 23,
    description: 'issue #59 — assistant image blobs: registry table + retention setting',
    sql: `
-- Bytes live on local disk (the data dir's files/ folder); this table is the
-- registry the transcript blocks reference by id.
CREATE TABLE IF NOT EXISTS file_objects (
  id         TEXT PRIMARY KEY,
  mime_type  TEXT NOT NULL,
  size       INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_file_objects_expires ON file_objects (expires_at);

-- Retention stamped on each blob AT INGEST; the default covers pre-#59 rows.
ALTER TABLE system_settings ADD COLUMN image_retention_days INTEGER NOT NULL DEFAULT 30;
    `,
  },
] as const;

/**
 * Run all pending migrations inside a transaction. `versionAt(version)`
 * reflects the user_version pragma-style tracking via the schema_version table.
 */
export function runMigrations(db: import('better-sqlite3').Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_version').all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );

  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    const tx = db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
        m.version,
        new Date().toISOString(),
      );
    });
    tx();
  }
}
