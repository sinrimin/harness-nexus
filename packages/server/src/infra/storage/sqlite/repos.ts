// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { Database } from 'better-sqlite3';
import type {
  User,
  Role,
  PersonalAccessToken,
  McpServer,
  McpTransport,
  Credential,
  Profile,
  ProfileEntry,
  ProfileImport,
  Resource,
  ResourceSource,
  AgentTarget,
  AssistantConfig,
  AssistantMessageRow,
  AssistantRepository,
  AssistantSession,
  Machine,
  MachineInventorySnapshot,
  InventoryAgentData,
  InventoryRepository,
  Job,
  AgentInstance,
  RuntimeConfig,
  LlmProvider,
  JobRepository,
  AgentInstanceRepository,
  RuntimeConfigRepository,
  LlmProviderRepository,
  UserRepository,
  PersonalAccessTokenRepository,
  SystemSettingsRepository,
  McpServerRepository,
  CredentialRepository,
  ProfileRepository,
  ResourceRepository,
  MachineRepository,
} from '@harness-nexus/core';
import { DEFAULT_SYSTEM_SETTINGS as DEFAULTS } from '@harness-nexus/core';

// ---- row shapes ----
interface UserRow {
  id: string;
  username: string;
  email: string | null;
  password_hash: string | null;
  role: string;
  status: string;
  created_at: string;
  updated_at: string;
}
interface PatRow {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  prefix: string;
  scopes: string;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
}
interface SettingsRow {
  id: number;
  allow_registration: number;
  image_retention_days: number;
  updated_at: string;
}
interface CredentialRow {
  id: string;
  name: string;
  secret: string;
  scope: string;
  owner_id: string | null;
  distributable: number;
  created_at: string;
  updated_at: string;
}
interface McpServerRow {
  id: string;
  name: string;
  transport: string;
  dial_site: string;
  scope: string;
  owner_id: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}
interface ProfileRow {
  id: string;
  name: string;
  description: string | null;
  version: string;
  target: string;
  scope: string;
  owner_id: string | null;
  entries: string;
  imports: string | null;
  created_at: string;
  updated_at: string;
}
interface ResourceRow {
  id: string;
  key: string;
  kind: string;
  name: string;
  description: string | null;
  version: string;
  source: string;
  scope: string;
  owner_id: string | null;
  targets: string;
  labels: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

// ---- mappers ----
const mapUser = (r: UserRow): User => ({
  id: r.id,
  username: r.username,
  ...(r.email ? { email: r.email } : {}),
  passwordHash: r.password_hash,
  role: r.role as Role,
  status: r.status as User['status'],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapPat = (r: PatRow): PersonalAccessToken => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  tokenHash: r.token_hash,
  prefix: r.prefix,
  scopes: JSON.parse(r.scopes) as string[],
  expiresAt: r.expires_at,
  lastUsedAt: r.last_used_at,
  createdAt: r.created_at,
});

const mapCredential = (r: CredentialRow): Credential => ({
  id: r.id,
  name: r.name,
  secret: r.secret,
  scope: r.scope as Credential['scope'],
  ownerId: r.owner_id,
  distributable: r.distributable === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapMcpServer = (r: McpServerRow): McpServer => ({
  id: r.id,
  name: r.name,
  transport: JSON.parse(r.transport) as McpTransport,
  dialSite: r.dial_site as McpServer['dialSite'],
  scope: r.scope as McpServer['scope'],
  ownerId: r.owner_id,
  ...(r.deleted_at ? { deletedAt: r.deleted_at } : {}),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const mapProfile = (r: ProfileRow): Profile => {
  const base: Profile = {
    id: r.id,
    name: r.name,
    version: r.version,
    target: r.target as Profile['target'],
    scope: r.scope as Profile['scope'],
    ownerId: r.owner_id,
    entries: JSON.parse(r.entries) as ProfileEntry[],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  const decorated: Profile = {
    ...base,
    ...(r.description ? { description: r.description } : {}),
  };
  return r.imports
    ? { ...decorated, imports: JSON.parse(r.imports) as ProfileImport[] }
    : decorated;
};

const mapResource = (r: ResourceRow): Resource => {
  const base: Resource = {
    id: r.id,
    key: r.key,
    kind: r.kind as Resource['kind'],
    name: r.name,
    version: r.version,
    source: JSON.parse(r.source) as ResourceSource,
    scope: r.scope as Resource['scope'],
    ownerId: r.owner_id,
    targets: JSON.parse(r.targets) as AgentTarget[],
    ...(r.deleted_at ? { deletedAt: r.deleted_at } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  const decorated: Resource = {
    ...base,
    ...(r.description ? { description: r.description } : {}),
  };
  return r.labels
    ? { ...decorated, labels: JSON.parse(r.labels) as Record<string, string> }
    : decorated;
};

// ---- user repository ----
export function sqliteUserRepository(db: Database): UserRepository {
  return {
    async findById(id) {
      const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
      return row ? mapUser(row) : null;
    },
    async findByUsername(username) {
      const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
        UserRow | undefined;
      return row ? mapUser(row) : null;
    },
    async list() {
      const rows = db.prepare('SELECT * FROM users ORDER BY created_at').all() as UserRow[];
      return rows.map(mapUser);
    },
    async count() {
      const row = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
      return row.n;
    },
    async countByRole(role) {
      const row = db.prepare('SELECT COUNT(*) AS n FROM users WHERE role = ?').get(role) as {
        n: number;
      };
      return row.n;
    },
    async save(user) {
      db.prepare(
        `INSERT INTO users (id, username, email, password_hash, role, status, created_at, updated_at)
         VALUES (@id, @username, @email, @password_hash, @role, @status, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           username      = excluded.username,
           email         = excluded.email,
           password_hash = excluded.password_hash,
           role          = excluded.role,
           status        = excluded.status,
           updated_at    = excluded.updated_at`,
      ).run({
        id: user.id,
        username: user.username,
        email: user.email ?? null,
        password_hash: user.passwordHash,
        role: user.role,
        status: user.status,
        created_at: user.createdAt,
        updated_at: user.updatedAt,
      });
      return user;
    },
    async delete(id) {
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
    },
  };
}

// ---- PAT repository ----
export function sqlitePatRepository(db: Database): PersonalAccessTokenRepository {
  return {
    async findById(id) {
      const row = db.prepare('SELECT * FROM personal_access_tokens WHERE id = ?').get(id) as
        PatRow | undefined;
      return row ? mapPat(row) : null;
    },
    async findByTokenHash(tokenHash) {
      const row = db
        .prepare('SELECT * FROM personal_access_tokens WHERE token_hash = ?')
        .get(tokenHash) as PatRow | undefined;
      return row ? mapPat(row) : null;
    },
    async listByUser(userId) {
      const rows = db
        .prepare('SELECT * FROM personal_access_tokens WHERE user_id = ? ORDER BY created_at')
        .all(userId) as PatRow[];
      return rows.map(mapPat);
    },
    async save(token) {
      db.prepare(
        `INSERT INTO personal_access_tokens
           (id, user_id, name, token_hash, prefix, scopes, expires_at, last_used_at, created_at)
         VALUES (@id, @user_id, @name, @token_hash, @prefix, @scopes, @expires_at, @last_used_at, @created_at)
         ON CONFLICT(id) DO UPDATE SET
           name         = excluded.name,
           token_hash   = excluded.token_hash,
           scopes       = excluded.scopes,
           expires_at   = excluded.expires_at,
           last_used_at = excluded.last_used_at`,
      ).run({
        id: token.id,
        user_id: token.userId,
        name: token.name,
        token_hash: token.tokenHash,
        prefix: token.prefix,
        scopes: JSON.stringify(token.scopes),
        expires_at: token.expiresAt,
        last_used_at: token.lastUsedAt,
        created_at: token.createdAt,
      });
      return token;
    },
    async touchLastUsed(id, at) {
      // Bind order matters (#21 bug fix): last_used_at ← at, WHERE id ← id.
      // The previous (id, at) order matched zero rows — lastUsedAt was never
      // recorded, breaking the "stolen token was used at…" audit trail.
      db.prepare('UPDATE personal_access_tokens SET last_used_at = ? WHERE id = ?').run(at, id);
    },
    async delete(id) {
      db.prepare('DELETE FROM personal_access_tokens WHERE id = ?').run(id);
    },
  };
}

// ---- system settings repository (single-row) ----
export function sqliteSettingsRepository(db: Database): SystemSettingsRepository {
  const ensureRow = (): SettingsRow => {
    const existing = db.prepare('SELECT * FROM system_settings WHERE id = 1').get() as
      SettingsRow | undefined;
    if (existing) return existing;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO system_settings (id, allow_registration, image_retention_days, updated_at)
       VALUES (1, ?, ?, ?)`,
    ).run(DEFAULTS.allowRegistration ? 1 : 0, DEFAULTS.imageRetentionDays, now);
    return db.prepare('SELECT * FROM system_settings WHERE id = 1').get() as SettingsRow;
  };

  return {
    async get() {
      const row = ensureRow();
      return {
        allowRegistration: row.allow_registration === 1,
        imageRetentionDays: row.image_retention_days,
        updatedAt: row.updated_at,
      };
    },
    async save(settings) {
      ensureRow();
      const now = settings.updatedAt;
      db.prepare(
        `UPDATE system_settings
         SET allow_registration = ?, image_retention_days = ?, updated_at = ?
         WHERE id = 1`,
      ).run(settings.allowRegistration ? 1 : 0, settings.imageRetentionDays, now);
      return {
        allowRegistration: settings.allowRegistration,
        imageRetentionDays: settings.imageRetentionDays,
        updatedAt: now,
      };
    },
  };
}

// ---- credential repository ----
export function sqliteCredentialRepository(db: Database): CredentialRepository {
  return {
    async findById(id) {
      const row = db.prepare('SELECT * FROM credentials WHERE id = ?').get(id) as
        CredentialRow | undefined;
      return row ? mapCredential(row) : null;
    },
    async findByName(name, scope, ownerId) {
      const row = db
        .prepare(
          'SELECT * FROM credentials WHERE name = ? AND scope = ? AND (scope = ? OR owner_id = ?)',
        )
        .get(name, scope, 'global', ownerId ?? '') as CredentialRow | undefined;
      return row ? mapCredential(row) : null;
    },
    async list(filter) {
      const where: string[] = [];
      const params: Record<string, unknown> = {};
      if (filter?.scope) {
        where.push('scope = @scope');
        params.scope = filter.scope;
      }
      if (filter?.ownerId) {
        where.push('owner_id = @ownerId');
        params.ownerId = filter.ownerId;
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const rows = db
        .prepare(`SELECT * FROM credentials ${clause} ORDER BY created_at`)
        .all(params) as CredentialRow[];
      return rows.map(mapCredential);
    },
    async save(credential) {
      db.prepare(
        `INSERT INTO credentials (id, name, secret, scope, owner_id, distributable, created_at, updated_at)
         VALUES (@id, @name, @secret, @scope, @owner_id, @distributable, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           name          = excluded.name,
           secret        = excluded.secret,
           scope         = excluded.scope,
           owner_id      = excluded.owner_id,
           distributable = excluded.distributable,
           updated_at    = excluded.updated_at`,
      ).run({
        id: credential.id,
        name: credential.name,
        secret: credential.secret,
        scope: credential.scope,
        owner_id: credential.ownerId,
        distributable: credential.distributable ? 1 : 0,
        created_at: credential.createdAt,
        updated_at: credential.updatedAt,
      });
      return credential;
    },
    async delete(id) {
      db.prepare('DELETE FROM credentials WHERE id = ?').run(id);
    },
  };
}

// ---- mcp server repository ----
export function sqliteMcpServerRepository(db: Database): McpServerRepository {
  return {
    async findById(id) {
      const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as
        McpServerRow | undefined;
      return row ? mapMcpServer(row) : null;
    },
    async list(filter) {
      const where: string[] = [];
      const params: Record<string, unknown> = {};
      if (filter?.scope) {
        where.push('scope = @scope');
        params.scope = filter.scope;
      }
      if (filter?.ownerId) {
        where.push('owner_id = @ownerId');
        params.ownerId = filter.ownerId;
      }
      if (filter?.dialSite) {
        where.push('dial_site = @dialSite');
        params.dialSite = filter.dialSite;
      }
      if (!filter?.includeDeleted) where.push('deleted_at IS NULL');
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const rows = db
        .prepare(`SELECT * FROM mcp_servers ${clause} ORDER BY created_at`)
        .all(params) as McpServerRow[];
      return rows.map(mapMcpServer);
    },
    async save(server) {
      db.prepare(
        `INSERT INTO mcp_servers (id, name, transport, dial_site, scope, owner_id, deleted_at, created_at, updated_at)
         VALUES (@id, @name, @transport, @dial_site, @scope, @owner_id, @deleted_at, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           name       = excluded.name,
           transport  = excluded.transport,
           dial_site  = excluded.dial_site,
           scope      = excluded.scope,
           owner_id   = excluded.owner_id,
           deleted_at = excluded.deleted_at,
           updated_at = excluded.updated_at`,
      ).run({
        id: server.id,
        name: server.name,
        transport: JSON.stringify(server.transport),
        dial_site: server.dialSite,
        scope: server.scope,
        owner_id: server.ownerId,
        deleted_at: server.deletedAt ?? null,
        created_at: server.createdAt,
        updated_at: server.updatedAt,
      });
      return server;
    },
    async delete(id) {
      db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
    },
  };
}

// ---- profile repository ----
export function sqliteProfileRepository(db: Database): ProfileRepository {
  return {
    async findById(id) {
      const row = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as
        ProfileRow | undefined;
      return row ? mapProfile(row) : null;
    },
    async findByName(name, scope, ownerId) {
      const where = ['name = @name', 'scope = @scope'];
      const params: Record<string, unknown> = { name, scope };
      if (ownerId) {
        where.push('owner_id = @ownerId');
        params.ownerId = ownerId;
      }
      const row = db.prepare(`SELECT * FROM profiles WHERE ${where.join(' AND ')}`).get(params) as
        ProfileRow | undefined;
      return row ? mapProfile(row) : null;
    },
    async list(filter) {
      const where: string[] = [];
      const params: Record<string, unknown> = {};
      if (filter?.scope) {
        where.push('scope = @scope');
        params.scope = filter.scope;
      }
      if (filter?.ownerId) {
        where.push('owner_id = @ownerId');
        params.ownerId = filter.ownerId;
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const rows = db
        .prepare(`SELECT * FROM profiles ${clause} ORDER BY created_at`)
        .all(params) as ProfileRow[];
      return rows.map(mapProfile);
    },
    async listAll() {
      const rows = db.prepare('SELECT * FROM profiles ORDER BY created_at').all() as ProfileRow[];
      return rows.map(mapProfile);
    },
    async save(profile) {
      db.prepare(
        `INSERT INTO profiles (id, name, description, version, target, scope, owner_id, entries, imports, created_at, updated_at)
         VALUES (@id, @name, @description, @version, @target, @scope, @owner_id, @entries, @imports, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           name        = excluded.name,
           description = excluded.description,
           version     = excluded.version,
           scope       = excluded.scope,
           owner_id    = excluded.owner_id,
           entries     = excluded.entries,
           imports     = excluded.imports,
           updated_at  = excluded.updated_at`,
      ).run({
        id: profile.id,
        name: profile.name,
        description: profile.description ?? null,
        version: profile.version,
        target: profile.target,
        scope: profile.scope,
        owner_id: profile.ownerId,
        entries: JSON.stringify(profile.entries),
        imports: profile.imports ? JSON.stringify(profile.imports) : null,
        created_at: profile.createdAt,
        updated_at: profile.updatedAt,
      });
      return profile;
    },
    async delete(id) {
      db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
    },
  };
}

// ---- resource repository ----
export function sqliteResourceRepository(db: Database): ResourceRepository {
  return {
    async findById(id) {
      const row = db.prepare('SELECT * FROM resources WHERE id = ?').get(id) as
        ResourceRow | undefined;
      return row ? mapResource(row) : null;
    },
    async findByKey(key, scope, ownerId) {
      const where = ['key = @key', 'scope = @scope'];
      const params: Record<string, unknown> = { key, scope };
      // personal rows are owner-scoped; global rows have NULL owner.
      if (scope === 'personal' && ownerId) {
        where.push('owner_id = @ownerId');
        params.ownerId = ownerId;
      } else if (scope === 'global') {
        where.push('owner_id IS NULL');
      }
      const row = db.prepare(`SELECT * FROM resources WHERE ${where.join(' AND ')}`).get(params) as
        ResourceRow | undefined;
      return row ? mapResource(row) : null;
    },
    async list(filter) {
      const where: string[] = [];
      const params: Record<string, unknown> = {};
      if (filter?.kind) {
        where.push('kind = @kind');
        params.kind = filter.kind;
      }
      if (filter?.scope) {
        where.push('scope = @scope');
        params.scope = filter.scope;
      }
      if (filter?.ownerId) {
        where.push('owner_id = @ownerId');
        params.ownerId = filter.ownerId;
      }
      if (filter?.target) {
        // targets is a JSON array; a LIKE match is sufficient at this scale.
        where.push('targets LIKE @target');
        params.target = `%"${filter.target}"%`;
      }
      if (!filter?.includeDeleted) where.push('deleted_at IS NULL');
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const rows = db
        .prepare(`SELECT * FROM resources ${clause} ORDER BY created_at`)
        .all(params) as ResourceRow[];
      return rows.map(mapResource);
    },
    async save(resource) {
      db.prepare(
        `INSERT INTO resources
           (id, key, kind, name, description, version, source, scope, owner_id, targets, labels, deleted_at, created_at, updated_at)
         VALUES (@id, @key, @kind, @name, @description, @version, @source, @scope, @owner_id, @targets, @labels, @deleted_at, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           key         = excluded.key,
           kind        = excluded.kind,
           name        = excluded.name,
           description = excluded.description,
           version     = excluded.version,
           source      = excluded.source,
           scope       = excluded.scope,
           owner_id    = excluded.owner_id,
           targets     = excluded.targets,
           labels      = excluded.labels,
           deleted_at  = excluded.deleted_at,
           updated_at  = excluded.updated_at`,
      ).run({
        id: resource.id,
        key: resource.key,
        kind: resource.kind,
        name: resource.name,
        description: resource.description ?? null,
        version: resource.version,
        source: JSON.stringify(resource.source),
        scope: resource.scope,
        owner_id: resource.ownerId,
        targets: JSON.stringify(resource.targets),
        labels: resource.labels ? JSON.stringify(resource.labels) : null,
        deleted_at: resource.deletedAt ?? null,
        created_at: resource.createdAt,
        updated_at: resource.updatedAt,
      });
      return resource;
    },
    async delete(id) {
      db.prepare('DELETE FROM resources WHERE id = ?').run(id);
    },
  };
}

// ---- machine repository (Phase 8 C1) ----

interface MachineRow {
  id: string;
  owner_id: string;
  name: string;
  hostname: string | null;
  os: string | null;
  arch: string | null;
  daemon_version: string | null;
  capabilities: string;
  remote_chat_enabled: number;
  base_workspace: string | null;
  /** Issue #3 — JSON per-target pre-warm map, NULL on pre-feature rows. */
  chat_prewarm: string | null;
  /** Issue #49 — JSON per-target default-mode map, NULL on pre-feature rows. */
  chat_default_mode: string | null;
  enrollment_pat_id: string;
  enrolled_at: string;
  last_seen_at: string | null;
}

/** JSON column ↔ domain; invalid/legacy JSON null-normalizes (defaults apply). */
function parseMachinePrewarm(raw: string | null): Machine['chatPrewarm'] | undefined {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof (parsed as Record<string, unknown>)['deepseek'] === 'boolean'
    ) {
      return parsed as Machine['chatPrewarm'];
    }
  } catch {
    // fall through
  }
  return undefined;
}

/** JSON column ↔ domain; invalid/legacy JSON null-normalizes (no default mode). */
function parseMachineDefaultMode(raw: string | null): Machine['chatDefaultMode'] | undefined {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof (parsed as Record<string, unknown>)['claude-code'] === 'string'
    ) {
      return parsed as Machine['chatDefaultMode'];
    }
  } catch {
    // fall through
  }
  return undefined;
}

function mapMachine(row: MachineRow): Machine {
  const chatPrewarm = parseMachinePrewarm(row.chat_prewarm);
  const chatDefaultMode = parseMachineDefaultMode(row.chat_default_mode);
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    hostname: row.hostname,
    os: row.os,
    arch: row.arch,
    daemonVersion: row.daemon_version,
    capabilities: JSON.parse(row.capabilities) as string[],
    remoteChatEnabled: row.remote_chat_enabled === 1,
    baseWorkspace: row.base_workspace,
    ...(chatPrewarm !== undefined ? { chatPrewarm } : {}),
    ...(chatDefaultMode !== undefined ? { chatDefaultMode } : {}),
    enrollmentPatId: row.enrollment_pat_id,
    enrolledAt: row.enrolled_at,
    lastSeenAt: row.last_seen_at,
  };
}

export function sqliteMachineRepository(db: Database): MachineRepository {
  return {
    async findById(id) {
      const row = db.prepare('SELECT * FROM machines WHERE id = ?').get(id) as
        MachineRow | undefined;
      return row ? mapMachine(row) : null;
    },
    async findByEnrollmentPatId(patId) {
      const row = db.prepare('SELECT * FROM machines WHERE enrollment_pat_id = ?').get(patId) as
        MachineRow | undefined;
      return row ? mapMachine(row) : null;
    },
    async list(filter) {
      const where: string[] = [];
      const params: Record<string, string> = {};
      if (filter?.ownerId !== undefined) {
        where.push('owner_id = @owner_id');
        params.owner_id = filter.ownerId;
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const rows = db
        .prepare(`SELECT * FROM machines ${clause} ORDER BY enrolled_at`)
        .all(params) as MachineRow[];
      return rows.map(mapMachine);
    },
    async save(machine) {
      db.prepare(
        `INSERT INTO machines
           (id, owner_id, name, hostname, os, arch, daemon_version, capabilities,
            remote_chat_enabled, base_workspace, chat_prewarm, chat_default_mode,
            enrollment_pat_id, enrolled_at, last_seen_at)
         VALUES (@id, @owner_id, @name, @hostname, @os, @arch, @daemon_version, @capabilities,
                 @remote_chat_enabled, @base_workspace, @chat_prewarm, @chat_default_mode,
                 @enrollment_pat_id, @enrolled_at, @last_seen_at)
         ON CONFLICT(id) DO UPDATE SET
           name                = excluded.name,
           hostname            = excluded.hostname,
           os                  = excluded.os,
           arch                = excluded.arch,
           daemon_version      = excluded.daemon_version,
           capabilities        = excluded.capabilities,
           remote_chat_enabled = excluded.remote_chat_enabled,
           base_workspace      = excluded.base_workspace,
           chat_prewarm        = excluded.chat_prewarm,
           chat_default_mode   = excluded.chat_default_mode,
           last_seen_at        = excluded.last_seen_at`,
      ).run({
        id: machine.id,
        owner_id: machine.ownerId,
        name: machine.name,
        hostname: machine.hostname,
        os: machine.os,
        arch: machine.arch,
        daemon_version: machine.daemonVersion,
        capabilities: JSON.stringify(machine.capabilities),
        remote_chat_enabled: machine.remoteChatEnabled ? 1 : 0,
        base_workspace: machine.baseWorkspace,
        chat_prewarm:
          machine.chatPrewarm === undefined ? null : JSON.stringify(machine.chatPrewarm),
        chat_default_mode:
          machine.chatDefaultMode === undefined ? null : JSON.stringify(machine.chatDefaultMode),
        enrollment_pat_id: machine.enrollmentPatId,
        enrolled_at: machine.enrolledAt,
        last_seen_at: machine.lastSeenAt,
      });
      return machine;
    },
    async delete(id) {
      db.prepare('DELETE FROM machines WHERE id = ?').run(id);
    },
  };
}

// ---- machine inventory (phase 8 C3) ----

interface InventoryRow {
  id: string;
  machine_id: string;
  target: string;
  daemon_version: string | null;
  reported_at: string;
  scanned_at: string;
  report: string;
  runtime: string | null;
}

function mapInventory(row: InventoryRow): MachineInventorySnapshot {
  return {
    id: row.id,
    machineId: row.machine_id,
    target: row.target as MachineInventorySnapshot['target'],
    daemonVersion: row.daemon_version,
    reportedAt: row.reported_at,
    scannedAt: row.scanned_at,
    agents: JSON.parse(row.report) as InventoryAgentData[],
    runtime:
      row.runtime === null
        ? null
        : (JSON.parse(row.runtime) as MachineInventorySnapshot['runtime']),
  };
}

export function sqliteInventoryRepository(db: Database): InventoryRepository {
  return {
    async findLatest(machineId, target) {
      const row = db
        .prepare('SELECT * FROM machine_inventory WHERE machine_id = ? AND target = ?')
        .get(machineId, target) as InventoryRow | undefined;
      return row ? mapInventory(row) : null;
    },
    async list(machineId) {
      const rows = db
        .prepare('SELECT * FROM machine_inventory WHERE machine_id = ? ORDER BY target')
        .all(machineId) as InventoryRow[];
      return rows.map(mapInventory);
    },
    async save(snapshot) {
      db.prepare(
        `INSERT INTO machine_inventory
           (id, machine_id, target, daemon_version, reported_at, scanned_at, report, runtime)
         VALUES (@id, @machine_id, @target, @daemon_version, @reported_at, @scanned_at, @report, @runtime)
         ON CONFLICT(machine_id, target) DO UPDATE SET
           id             = excluded.id,
           daemon_version = excluded.daemon_version,
           reported_at    = excluded.reported_at,
           scanned_at     = excluded.scanned_at,
           report         = excluded.report,
           runtime        = excluded.runtime`,
      ).run({
        id: snapshot.id,
        machine_id: snapshot.machineId,
        target: snapshot.target,
        daemon_version: snapshot.daemonVersion,
        reported_at: snapshot.reportedAt,
        scanned_at: snapshot.scannedAt,
        report: JSON.stringify(snapshot.agents),
        runtime: snapshot.runtime === null ? null : JSON.stringify(snapshot.runtime),
      });
      return snapshot;
    },
    async deleteByMachine(machineId) {
      db.prepare('DELETE FROM machine_inventory WHERE machine_id = ?').run(machineId);
    },
  };
}

// ---- jobs + agent instances (phase 8 C4) ----

interface JobRow {
  id: string;
  machine_id: string;
  owner_id: string;
  type: string;
  status: string;
  payload: string;
  result: string | null;
  error: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
}

function mapJob(row: JobRow): Job {
  return {
    id: row.id,
    machineId: row.machine_id,
    ownerId: row.owner_id,
    type: row.type as Job['type'],
    status: row.status as Job['status'],
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    result: row.result === null ? null : JSON.parse(row.result),
    error: row.error,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function sqliteJobRepository(db: Database): JobRepository {
  return {
    async findById(id) {
      const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
      return row ? mapJob(row) : null;
    },
    async listByMachine(machineId) {
      const rows = db
        .prepare('SELECT * FROM jobs WHERE machine_id = ? ORDER BY created_at DESC, id')
        .all(machineId) as JobRow[];
      return rows.map(mapJob);
    },
    async listRecoverable() {
      const rows = db
        .prepare(
          "SELECT * FROM jobs WHERE status IN ('queued', 'dispatched', 'running') ORDER BY created_at",
        )
        .all() as JobRow[];
      return rows.map(mapJob);
    },
    async save(job) {
      db.prepare(
        `INSERT INTO jobs
           (id, machine_id, owner_id, type, status, payload, result, error, attempts, created_at, updated_at)
         VALUES (@id, @machine_id, @owner_id, @type, @status, @payload, @result, @error, @attempts, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           status     = excluded.status,
           payload    = excluded.payload,
           result     = excluded.result,
           error      = excluded.error,
           attempts   = excluded.attempts,
           updated_at = excluded.updated_at`,
      ).run({
        id: job.id,
        machine_id: job.machineId,
        owner_id: job.ownerId,
        type: job.type,
        status: job.status,
        payload: JSON.stringify(job.payload),
        result: job.result === null ? null : JSON.stringify(job.result),
        error: job.error,
        attempts: job.attempts,
        created_at: job.createdAt,
        updated_at: job.updatedAt,
      });
      return job;
    },
    async deleteByMachine(machineId) {
      db.prepare('DELETE FROM jobs WHERE machine_id = ?').run(machineId);
    },
  };
}

interface AgentInstanceRow {
  id: string;
  machine_id: string;
  owner_id: string;
  target: string;
  profile_id: string | null;
  profile_version: string | null;
  source: string;
  name: string;
  directory: string;
  job_id: string | null;
  created_at: string;
  updated_at: string;
}

function mapAgentInstance(row: AgentInstanceRow): AgentInstance {
  return {
    id: row.id,
    machineId: row.machine_id,
    ownerId: row.owner_id,
    target: row.target as AgentInstance['target'],
    profileId: row.profile_id,
    profileVersion: row.profile_version,
    source: row.source as AgentInstance['source'],
    name: row.name,
    directory: row.directory,
    jobId: row.job_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function sqliteAgentInstanceRepository(db: Database): AgentInstanceRepository {
  return {
    async findById(id) {
      const row = db.prepare('SELECT * FROM agent_instances WHERE id = ?').get(id) as
        AgentInstanceRow | undefined;
      return row ? mapAgentInstance(row) : null;
    },
    async listByMachine(machineId) {
      const rows = db
        .prepare('SELECT * FROM agent_instances WHERE machine_id = ? ORDER BY created_at')
        .all(machineId) as AgentInstanceRow[];
      return rows.map(mapAgentInstance);
    },
    async findByMachineAndProfile(machineId, profileId) {
      const row = db
        .prepare('SELECT * FROM agent_instances WHERE machine_id = ? AND profile_id = ?')
        .get(machineId, profileId) as AgentInstanceRow | undefined;
      return row ? mapAgentInstance(row) : null;
    },
    async findByMachineAndTarget(machineId, target) {
      const row = db
        .prepare(
          "SELECT * FROM agent_instances WHERE machine_id = ? AND target = ? AND source = 'detected'",
        )
        .get(machineId, target) as AgentInstanceRow | undefined;
      return row ? mapAgentInstance(row) : null;
    },
    async save(instance) {
      // Upsert by id — identity resolution (deploy keyed by machine+profile,
      // detected by machine+target) belongs to the CALLER, not the driver.
      db.prepare(
        `INSERT INTO agent_instances
           (id, machine_id, owner_id, target, profile_id, profile_version, source, name, directory, job_id, created_at, updated_at)
         VALUES (@id, @machine_id, @owner_id, @target, @profile_id, @profile_version, @source, @name, @directory, @job_id, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           profile_id      = excluded.profile_id,
           profile_version = excluded.profile_version,
           source          = excluded.source,
           name            = excluded.name,
           directory       = excluded.directory,
           job_id          = excluded.job_id,
           updated_at      = excluded.updated_at`,
      ).run({
        id: instance.id,
        machine_id: instance.machineId,
        owner_id: instance.ownerId,
        target: instance.target,
        profile_id: instance.profileId,
        profile_version: instance.profileVersion,
        source: instance.source,
        name: instance.name,
        directory: instance.directory,
        job_id: instance.jobId,
        created_at: instance.createdAt,
        updated_at: instance.updatedAt,
      });
      return instance;
    },
    async delete(id) {
      db.prepare('DELETE FROM agent_instances WHERE id = ?').run(id);
    },
    async deleteByMachine(machineId) {
      db.prepare('DELETE FROM agent_instances WHERE machine_id = ?').run(machineId);
    },
  };
}

// ---- runtime provider configs (phase 9 W3) ----

interface RuntimeConfigRow {
  id: string;
  machine_id: string;
  owner_id: string;
  target: string;
  spec: string;
  created_at: string;
  updated_at: string;
}

function mapRuntimeConfig(row: RuntimeConfigRow): RuntimeConfig {
  const spec = JSON.parse(row.spec) as RuntimeConfig['spec'];
  return {
    id: row.id,
    machineId: row.machine_id,
    ownerId: row.owner_id,
    target: row.target as RuntimeConfig['target'],
    // W10 fields are optional on the wire — normalize pre-W10 rows to null.
    spec: {
      ...spec,
      providerId: spec.providerId ?? null,
      models: spec.models ?? null,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function sqliteRuntimeConfigRepository(db: Database): RuntimeConfigRepository {
  return {
    async findByMachineAndTarget(machineId, target) {
      const row = db
        .prepare('SELECT * FROM runtime_configs WHERE machine_id = ? AND target = ?')
        .get(machineId, target) as RuntimeConfigRow | undefined;
      return row ? mapRuntimeConfig(row) : null;
    },
    async save(config) {
      // Upsert by id — (machine, target) identity resolution belongs to the
      // caller, mirroring the agent_instances contract.
      db.prepare(
        `INSERT INTO runtime_configs
           (id, machine_id, owner_id, target, spec, created_at, updated_at)
         VALUES (@id, @machine_id, @owner_id, @target, @spec, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           spec       = excluded.spec,
           updated_at = excluded.updated_at`,
      ).run({
        id: config.id,
        machine_id: config.machineId,
        owner_id: config.ownerId,
        target: config.target,
        spec: JSON.stringify(config.spec),
        created_at: config.createdAt,
        updated_at: config.updatedAt,
      });
      return config;
    },
    async deleteByMachine(machineId) {
      db.prepare('DELETE FROM runtime_configs WHERE machine_id = ?').run(machineId);
    },
  };
}

// ---- LLM provider catalog (phase 9 W10) ----

interface LlmProviderRow {
  id: string;
  name: string;
  api: string;
  base_url: string | null;
  credential_name: string;
  scope: string;
  owner_id: string | null;
  /** #51 — JSON of ProviderModelConfig[]; NULL on pre-feature rows → []. */
  models: string | null;
  created_at: string;
  updated_at: string;
}

const mapLlmProvider = (r: LlmProviderRow): LlmProvider => ({
  id: r.id,
  name: r.name,
  api: r.api as LlmProvider['api'],
  baseUrl: r.base_url,
  credentialName: r.credential_name,
  scope: r.scope as LlmProvider['scope'],
  ownerId: r.owner_id,
  models: r.models === null ? [] : (JSON.parse(r.models) as LlmProvider['models']),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function sqliteLlmProviderRepository(db: Database): LlmProviderRepository {
  return {
    async findById(id) {
      const row = db.prepare('SELECT * FROM llm_providers WHERE id = ?').get(id) as
        LlmProviderRow | undefined;
      return row ? mapLlmProvider(row) : null;
    },
    async findByName(name, scope, ownerId) {
      const row = db
        .prepare(
          'SELECT * FROM llm_providers WHERE name = ? AND scope = ? AND (scope = ? OR owner_id = ?)',
        )
        .get(name, scope, 'global', ownerId ?? '') as LlmProviderRow | undefined;
      return row ? mapLlmProvider(row) : null;
    },
    async list(filter) {
      const where: string[] = [];
      const params: Record<string, unknown> = {};
      if (filter?.scope) {
        where.push('scope = @scope');
        params.scope = filter.scope;
      }
      if (filter?.ownerId) {
        where.push('owner_id = @ownerId');
        params.ownerId = filter.ownerId;
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const rows = db
        .prepare(`SELECT * FROM llm_providers ${clause} ORDER BY created_at`)
        .all(params) as LlmProviderRow[];
      return rows.map(mapLlmProvider);
    },
    async save(provider) {
      db.prepare(
        `INSERT INTO llm_providers
           (id, name, api, base_url, credential_name, scope, owner_id, models, created_at, updated_at)
         VALUES (@id, @name, @api, @base_url, @credential_name, @scope, @owner_id, @models, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           name            = excluded.name,
           api             = excluded.api,
           base_url        = excluded.base_url,
           credential_name = excluded.credential_name,
           models          = excluded.models,
           updated_at      = excluded.updated_at`,
      ).run({
        id: provider.id,
        name: provider.name,
        api: provider.api,
        base_url: provider.baseUrl,
        credential_name: provider.credentialName,
        scope: provider.scope,
        owner_id: provider.ownerId,
        models: JSON.stringify(provider.models ?? []),
        created_at: provider.createdAt,
        updated_at: provider.updatedAt,
      });
      return provider;
    },
    async delete(id) {
      db.prepare('DELETE FROM llm_providers WHERE id = ?').run(id);
    },
  };
}

// ---- assistant repository (#52) ----

interface AssistantConfigRow {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  provider_id: string;
  default_model: string;
  system_prompt_override: string | null;
  enabled_tool_groups: string;
  mcp_server_ids: string | null;
  skill_resource_ids: string | null;
  daily_token_budget: number | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface AssistantSessionRow {
  id: string;
  owner_id: string;
  assistant_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
}

interface AssistantMessageRow_ {
  session_id: string;
  seq: number;
  item: string;
}

interface AssistantToolCallRow {
  id: string;
  session_id: string;
  user_id: string;
  tool: string;
  args: string;
  status: string;
  duration_ms: number;
  created_at: string;
}

function mapAssistantConfig(r: AssistantConfigRow): AssistantConfig {
  return {
    id: r.id,
    ownerId: r.owner_id,
    name: r.name,
    ...(r.description !== null ? { description: r.description } : {}),
    providerId: r.provider_id,
    defaultModel: r.default_model,
    ...(r.system_prompt_override !== null
      ? { systemPromptOverride: r.system_prompt_override }
      : {}),
    enabledToolGroups: JSON.parse(r.enabled_tool_groups) as AssistantConfig['enabledToolGroups'],
    mcpServerIds: r.mcp_server_ids === null ? [] : (JSON.parse(r.mcp_server_ids) as string[]),
    skillResourceIds:
      r.skill_resource_ids === null ? [] : (JSON.parse(r.skill_resource_ids) as string[]),
    ...(r.daily_token_budget !== null ? { dailyTokenBudget: r.daily_token_budget } : {}),
    ...(r.deleted_at !== null ? { deletedAt: r.deleted_at } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function mapAssistantSession(r: AssistantSessionRow): AssistantSession {
  return {
    id: r.id,
    ownerId: r.owner_id,
    assistantId: r.assistant_id,
    title: r.title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastMessageAt: r.last_message_at,
  };
}

export function sqliteAssistantRepository(db: Database): AssistantRepository {
  return {
    async findById(id) {
      const row = db.prepare('SELECT * FROM assistant_configs WHERE id = ?').get(id) as
        AssistantConfigRow | undefined;
      return row ? mapAssistantConfig(row) : null;
    },
    async listByOwner(ownerId) {
      const rows = db
        .prepare(
          'SELECT * FROM assistant_configs WHERE owner_id = ? AND deleted_at IS NULL ORDER BY created_at',
        )
        .all(ownerId) as AssistantConfigRow[];
      return rows.map(mapAssistantConfig);
    },
    async findByName(ownerId, name) {
      const row = db
        .prepare(
          'SELECT * FROM assistant_configs WHERE owner_id = ? AND name = ? AND deleted_at IS NULL',
        )
        .get(ownerId, name) as AssistantConfigRow | undefined;
      return row ? mapAssistantConfig(row) : null;
    },
    async save(config) {
      db.prepare(
        `INSERT INTO assistant_configs
           (id, owner_id, name, description, provider_id, default_model,
            system_prompt_override, enabled_tool_groups, mcp_server_ids, skill_resource_ids,
            daily_token_budget, deleted_at, created_at, updated_at)
         VALUES (@id, @owner_id, @name, @description, @provider_id, @default_model,
                 @system_prompt_override, @enabled_tool_groups, @mcp_server_ids, @skill_resource_ids,
                 @daily_token_budget, @deleted_at, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           name                   = excluded.name,
           description            = excluded.description,
           provider_id            = excluded.provider_id,
           default_model          = excluded.default_model,
           system_prompt_override = excluded.system_prompt_override,
           enabled_tool_groups    = excluded.enabled_tool_groups,
           mcp_server_ids         = excluded.mcp_server_ids,
           skill_resource_ids     = excluded.skill_resource_ids,
           daily_token_budget     = excluded.daily_token_budget,
           deleted_at             = excluded.deleted_at,
           updated_at             = excluded.updated_at`,
      ).run({
        id: config.id,
        owner_id: config.ownerId,
        name: config.name,
        description: config.description ?? null,
        provider_id: config.providerId,
        default_model: config.defaultModel,
        system_prompt_override: config.systemPromptOverride ?? null,
        enabled_tool_groups: JSON.stringify(config.enabledToolGroups),
        mcp_server_ids: JSON.stringify(config.mcpServerIds ?? []),
        skill_resource_ids: JSON.stringify(config.skillResourceIds ?? []),
        daily_token_budget: config.dailyTokenBudget ?? null,
        deleted_at: config.deletedAt ?? null,
        created_at: config.createdAt,
        updated_at: config.updatedAt,
      });
      return config;
    },
    async delete(id) {
      db.prepare('DELETE FROM assistant_configs WHERE id = ?').run(id);
    },

    async findSessionById(id) {
      const row = db.prepare('SELECT * FROM assistant_sessions WHERE id = ?').get(id) as
        AssistantSessionRow | undefined;
      return row ? mapAssistantSession(row) : null;
    },
    async listSessions(ownerId, assistantId) {
      const rows = (
        assistantId === undefined
          ? db
              .prepare(
                `SELECT * FROM assistant_sessions WHERE owner_id = ?
                 ORDER BY COALESCE(last_message_at, created_at) DESC, created_at DESC`,
              )
              .all(ownerId)
          : db
              .prepare(
                `SELECT * FROM assistant_sessions WHERE owner_id = ? AND assistant_id = ?
                 ORDER BY COALESCE(last_message_at, created_at) DESC, created_at DESC`,
              )
              .all(ownerId, assistantId)
      ) as AssistantSessionRow[];
      return rows.map(mapAssistantSession);
    },
    async saveSession(session) {
      db.prepare(
        `INSERT INTO assistant_sessions
           (id, owner_id, assistant_id, title, created_at, updated_at, last_message_at)
         VALUES (@id, @owner_id, @assistant_id, @title, @created_at, @updated_at, @last_message_at)
         ON CONFLICT(id) DO UPDATE SET
           title           = excluded.title,
           updated_at      = excluded.updated_at,
           last_message_at = excluded.last_message_at`,
      ).run({
        id: session.id,
        owner_id: session.ownerId,
        assistant_id: session.assistantId,
        title: session.title,
        created_at: session.createdAt,
        updated_at: session.updatedAt,
        last_message_at: session.lastMessageAt,
      });
      return session;
    },
    async deleteSession(id) {
      db.prepare('DELETE FROM assistant_sessions WHERE id = ?').run(id);
    },

    async appendMessage(sessionId, row) {
      const { seq, ...item } = row;
      db.prepare('INSERT INTO assistant_messages (session_id, seq, item) VALUES (?, ?, ?)').run(
        sessionId,
        seq,
        JSON.stringify(item),
      );
    },
    async listMessages(sessionId) {
      const rows = db
        .prepare('SELECT * FROM assistant_messages WHERE session_id = ? ORDER BY seq')
        .all(sessionId) as AssistantMessageRow_[];
      return rows.map((r) => ({
        seq: r.seq,
        ...(JSON.parse(r.item) as object),
      })) as AssistantMessageRow[];
    },
    async clearMessages(sessionId) {
      db.prepare('DELETE FROM assistant_messages WHERE session_id = ?').run(sessionId);
    },

    async appendToolCallAudit(audit) {
      db.prepare(
        `INSERT INTO assistant_tool_calls
           (id, session_id, user_id, tool, args, status, duration_ms, created_at)
         VALUES (@id, @session_id, @user_id, @tool, @args, @status, @duration_ms, @created_at)`,
      ).run({
        id: audit.id,
        session_id: audit.sessionId,
        user_id: audit.userId,
        tool: audit.tool,
        args: audit.args,
        status: audit.status,
        duration_ms: audit.durationMs,
        created_at: audit.createdAt,
      });
    },
    async listToolCallAudits(sessionId) {
      const rows = db
        .prepare('SELECT * FROM assistant_tool_calls WHERE session_id = ? ORDER BY created_at')
        .all(sessionId) as AssistantToolCallRow[];
      return rows.map((r) => ({
        id: r.id,
        sessionId: r.session_id,
        userId: r.user_id,
        tool: r.tool,
        args: r.args,
        status: r.status as 'ok' | 'error' | 'blocked',
        durationMs: r.duration_ms,
        createdAt: r.created_at,
      }));
    },
  };
}
