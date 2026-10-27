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
  ApiToolRepository,
  ApiToolService,
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
  SystemSettings,
  SystemSettingsRepository,
  McpServerRepository,
  Note,
  NoteAnnotation,
  NoteAnnotationRepository,
  NoteCategory,
  NoteCategoryRepository,
  NoteRepository,
  NoteVersion,
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
  /** #95 — JSON of UserDefaultModels; NULL on pre-feature rows. */
  default_models: string | null;
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
  api_tool_outbound: string | null;
  api_tool_outbound_rules: string | null;
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
  ...(r.default_models
    ? { defaultModels: JSON.parse(r.default_models) as User['defaultModels'] }
    : {}),
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
        `INSERT INTO users (id, username, email, password_hash, role, status, default_models, created_at, updated_at)
         VALUES (@id, @username, @email, @password_hash, @role, @status, @default_models, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           username        = excluded.username,
           email           = excluded.email,
           password_hash   = excluded.password_hash,
           role            = excluded.role,
           status          = excluded.status,
           default_models  = excluded.default_models,
           updated_at      = excluded.updated_at`,
      ).run({
        id: user.id,
        username: user.username,
        email: user.email ?? null,
        password_hash: user.passwordHash,
        role: user.role,
        status: user.status,
        default_models: user.defaultModels ? JSON.stringify(user.defaultModels) : null,
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
      `INSERT INTO system_settings (id, allow_registration, image_retention_days, api_tool_outbound, api_tool_outbound_rules, updated_at)
       VALUES (1, ?, ?, ?, ?, ?)`,
    ).run(
      DEFAULTS.allowRegistration ? 1 : 0,
      DEFAULTS.imageRetentionDays,
      DEFAULTS.apiToolOutbound,
      JSON.stringify(DEFAULTS.apiToolOutboundRules),
      now,
    );
    return db.prepare('SELECT * FROM system_settings WHERE id = 1').get() as SettingsRow;
  };

  return {
    async get() {
      const row = ensureRow();
      return {
        allowRegistration: row.allow_registration === 1,
        imageRetentionDays: row.image_retention_days,
        // #85 — pre-v28 rows (and any null) read as the allow default.
        apiToolOutbound: row.api_tool_outbound === 'deny' ? 'deny' : 'allow',
        apiToolOutboundRules:
          row.api_tool_outbound_rules === null || row.api_tool_outbound_rules === '{}'
            ? { external: [], internal: [] }
            : (JSON.parse(row.api_tool_outbound_rules) as SystemSettings['apiToolOutboundRules']),
        updatedAt: row.updated_at,
      };
    },
    async save(settings) {
      ensureRow();
      const now = settings.updatedAt;
      db.prepare(
        `UPDATE system_settings
         SET allow_registration = ?, image_retention_days = ?, api_tool_outbound = ?, api_tool_outbound_rules = ?, updated_at = ?
         WHERE id = 1`,
      ).run(
        settings.allowRegistration ? 1 : 0,
        settings.imageRetentionDays,
        settings.apiToolOutbound ?? 'allow',
        JSON.stringify(settings.apiToolOutboundRules ?? { external: [], internal: [] }),
        now,
      );
      return {
        allowRegistration: settings.allowRegistration,
        imageRetentionDays: settings.imageRetentionDays,
        apiToolOutbound: settings.apiToolOutbound ?? 'allow',
        apiToolOutboundRules: settings.apiToolOutboundRules ?? { external: [], internal: [] },
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
  /** Issue #92 — JSON delegated-approvals config, NULL on pre-feature rows. */
  chat_approvals: string | null;
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

/** JSON column ↔ domain; invalid/legacy JSON null-normalizes (manual default). */
function parseMachineApprovals(raw: string | null): Machine['chatApprovals'] | undefined {
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      (typeof (parsed as Record<string, unknown>)['responder'] === 'string' ||
        typeof (parsed as Record<string, unknown>)['providerId'] === 'string')
    ) {
      return parsed as Machine['chatApprovals'];
    }
  } catch {
    // fall through
  }
  return undefined;
}

function mapMachine(row: MachineRow): Machine {
  const chatPrewarm = parseMachinePrewarm(row.chat_prewarm);
  const chatDefaultMode = parseMachineDefaultMode(row.chat_default_mode);
  const chatApprovals = parseMachineApprovals(row.chat_approvals);
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
    ...(chatApprovals !== undefined ? { chatApprovals } : {}),
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
            chat_approvals, enrollment_pat_id, enrolled_at, last_seen_at)
         VALUES (@id, @owner_id, @name, @hostname, @os, @arch, @daemon_version, @capabilities,
                 @remote_chat_enabled, @base_workspace, @chat_prewarm, @chat_default_mode,
                 @chat_approvals, @enrollment_pat_id, @enrolled_at, @last_seen_at)
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
           chat_approvals      = excluded.chat_approvals,
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
        chat_approvals:
          machine.chatApprovals === undefined ? null : JSON.stringify(machine.chatApprovals),
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
  /** #95 — JSON of ProviderApiEndpoint[] (was the single `api` TEXT pre-v32). */
  apis: string;
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
  apis: JSON.parse(r.apis) as LlmProvider['apis'],
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
           (id, name, apis, base_url, credential_name, scope, owner_id, models, created_at, updated_at)
         VALUES (@id, @name, @apis, @base_url, @credential_name, @scope, @owner_id, @models, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           name            = excluded.name,
           apis            = excluded.apis,
           base_url        = excluded.base_url,
           credential_name = excluded.credential_name,
           models          = excluded.models,
           updated_at      = excluded.updated_at`,
      ).run({
        id: provider.id,
        name: provider.name,
        apis: JSON.stringify(provider.apis),
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
  permission_mode: string;
  api_tool_service_ids: string | null;
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
  /** #79 — NULL on pre-v27 rows (the config default applies at open). */
  permission_mode: string | null;
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
    permissionMode: r.permission_mode === 'autoWrite' ? 'autoWrite' : 'prompt',
    apiToolServiceIds:
      r.api_tool_service_ids === null ? [] : (JSON.parse(r.api_tool_service_ids) as string[]),
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

interface ApiToolRow {
  id: string;
  scope: string;
  owner_id: string | null;
  name: string;
  bundle: string;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapApiToolService(r: ApiToolRow): ApiToolService {
  const bundle = JSON.parse(r.bundle) as Omit<
    ApiToolService,
    'id' | 'scope' | 'ownerId' | 'createdAt' | 'updatedAt' | 'deletedAt'
  >;
  return {
    id: r.id,
    scope: r.scope === 'global' ? 'global' : 'personal',
    ownerId: r.owner_id,
    ...bundle,
    ...(r.deleted_at !== null ? { deletedAt: r.deleted_at } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function sqliteApiToolRepository(db: Database): ApiToolRepository {
  const repo: ApiToolRepository = {
    async findById(id) {
      const row = db.prepare('SELECT * FROM api_tool_services WHERE id = ?').get(id) as
        ApiToolRow | undefined;
      return row ? mapApiToolService(row) : null;
    },
    async list(filter) {
      const conds: string[] = [];
      const args: (string | null)[] = [];
      if (filter?.includeDeleted !== true) conds.push('deleted_at IS NULL');
      if (filter?.scope !== undefined) {
        conds.push('scope = ?');
        args.push(filter.scope);
      }
      if (filter?.ownerId !== undefined) {
        conds.push('owner_id = ?');
        args.push(filter.ownerId);
      }
      const where = conds.length > 0 ? 'WHERE ' + conds.join(' AND ') : '';
      const rows = db
        .prepare('SELECT * FROM api_tool_services ' + where + ' ORDER BY created_at')
        .all(...args) as ApiToolRow[];
      return rows.map(mapApiToolService);
    },
    async save(service) {
      const bundle = JSON.stringify({
        name: service.name,
        ...(service.description !== undefined ? { description: service.description } : {}),
        baseUrl: service.baseUrl,
        headers: service.headers,
        ...(service.auth !== undefined ? { auth: service.auth } : {}),
        tools: service.tools,
      });
      db.prepare(
        `INSERT INTO api_tool_services
         (id, scope, owner_id, name, bundle, deleted_at, created_at, updated_at)
         VALUES (@id, @scope, @owner_id, @name, @bundle, @deleted_at, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           scope = excluded.scope,
           owner_id = excluded.owner_id,
           name = excluded.name,
           bundle = excluded.bundle,
           deleted_at = excluded.deleted_at,
           updated_at = excluded.updated_at`,
      ).run({
        id: service.id,
        scope: service.scope,
        owner_id: service.ownerId,
        name: service.name,
        bundle,
        deleted_at: service.deletedAt ?? null,
        created_at: service.createdAt,
        updated_at: service.updatedAt,
      });
      return service;
    },
    async delete(id) {
      db.prepare('DELETE FROM api_tool_services WHERE id = ?').run(id);
    },
  };
  return repo;
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
    permissionMode:
      r.permission_mode === 'prompt' || r.permission_mode === 'autoWrite'
        ? r.permission_mode
        : undefined,
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
            system_prompt_override, permission_mode, api_tool_service_ids, enabled_tool_groups, mcp_server_ids, skill_resource_ids,
            daily_token_budget, deleted_at, created_at, updated_at)
         VALUES (@id, @owner_id, @name, @description, @provider_id, @default_model,
                 @system_prompt_override, @permission_mode, @api_tool_service_ids, @enabled_tool_groups, @mcp_server_ids, @skill_resource_ids,
                 @daily_token_budget, @deleted_at, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           name                   = excluded.name,
           description            = excluded.description,
           provider_id            = excluded.provider_id,
           default_model          = excluded.default_model,
           system_prompt_override = excluded.system_prompt_override,
           permission_mode        = excluded.permission_mode,
           api_tool_service_ids   = excluded.api_tool_service_ids,
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
        permission_mode: config.permissionMode ?? 'prompt',
        api_tool_service_ids: JSON.stringify(config.apiToolServiceIds ?? []),
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
           (id, owner_id, assistant_id, title, created_at, updated_at, last_message_at,
            permission_mode)
         VALUES (@id, @owner_id, @assistant_id, @title, @created_at, @updated_at,
                 @last_message_at, @permission_mode)
         ON CONFLICT(id) DO UPDATE SET
           title           = excluded.title,
           updated_at      = excluded.updated_at,
           last_message_at = excluded.last_message_at,
           permission_mode = excluded.permission_mode`,
      ).run({
        id: session.id,
        owner_id: session.ownerId,
        assistant_id: session.assistantId,
        title: session.title,
        created_at: session.createdAt,
        updated_at: session.updatedAt,
        last_message_at: session.lastMessageAt,
        permission_mode: session.permissionMode ?? null,
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

// ---- #88 — notes -----------------------------------------------------------------

interface NoteRow {
  id: string;
  owner_id: string;
  title: string;
  summary: string | null;
  content_md: string;
  content_version: number;
  category_id: string | null;
  tags: string;
  status: string;
  visibility: string;
  source: string;
  created_at: string;
  updated_at: string;
}

function mapNote(r: NoteRow): Note {
  return {
    id: r.id,
    ownerId: r.owner_id,
    title: r.title,
    summary: r.summary,
    contentMd: r.content_md,
    contentVersion: r.content_version,
    categoryId: r.category_id,
    tags: JSON.parse(r.tags) as string[],
    status: r.status as Note['status'],
    visibility: r.visibility as Note['visibility'],
    source: JSON.parse(r.source) as Note['source'],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function sqliteNoteRepository(db: Database): NoteRepository {
  const repo: NoteRepository = {
    async findById(id) {
      const row = db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | undefined;
      return row ? mapNote(row) : null;
    },
    async list(filter) {
      const conds: string[] = [];
      const args: (string | number | null)[] = [];
      if (filter?.ownerId !== undefined) {
        conds.push('owner_id = ?');
        args.push(filter.ownerId);
      }
      if (filter?.categoryId !== undefined) {
        conds.push('category_id = ?');
        args.push(filter.categoryId);
      }
      if (filter?.status !== undefined) {
        conds.push('status = ?');
        args.push(filter.status);
      }
      if (filter?.visibility !== undefined) {
        conds.push('visibility = ?');
        args.push(filter.visibility);
      }
      if (filter?.tag !== undefined) {
        conds.push('EXISTS (SELECT 1 FROM json_each(notes.tags) je WHERE je.value = ?)');
        args.push(filter.tag);
      }
      if (filter?.search !== undefined) {
        const like = `%${filter.search.toLowerCase()}%`;
        conds.push(
          "(LOWER(title) LIKE ? OR LOWER(COALESCE(summary, '')) LIKE ? OR LOWER(content_md) LIKE ?)",
        );
        args.push(like, like, like);
      }
      const where = conds.length > 0 ? 'WHERE ' + conds.join(' AND ') : '';
      const limit = filter?.limit ?? -1;
      const offset = filter?.offset ?? 0;
      const rows = db
        .prepare(
          'SELECT * FROM notes ' + where + ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
        )
        .all(...args, limit, offset) as NoteRow[];
      return rows.map(mapNote);
    },
    async listPublic(filter) {
      const conds = ['visibility = ?'];
      const args: (string | number)[] = ['public'];
      if (filter?.tag !== undefined) {
        conds.push('EXISTS (SELECT 1 FROM json_each(notes.tags) je WHERE je.value = ?)');
        args.push(filter.tag);
      }
      if (filter?.search !== undefined) {
        const like = `%${filter.search.toLowerCase()}%`;
        conds.push(
          "(LOWER(title) LIKE ? OR LOWER(COALESCE(summary, '')) LIKE ? OR LOWER(content_md) LIKE ?)",
        );
        args.push(like, like, like);
      }
      const limit = filter?.limit ?? -1;
      const offset = filter?.offset ?? 0;
      const rows = db
        .prepare(
          'SELECT * FROM notes WHERE ' +
            conds.join(' AND ') +
            ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?',
        )
        .all(...args, limit, offset) as NoteRow[];
      return rows.map(mapNote);
    },
    async save(note) {
      db.prepare(
        `INSERT INTO notes
         (id, owner_id, title, summary, content_md, content_version, category_id, tags,
          status, visibility, source, created_at, updated_at)
         VALUES (@id, @owner_id, @title, @summary, @content_md, @content_version, @category_id,
                 @tags, @status, @visibility, @source, @created_at, @updated_at)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           summary = excluded.summary,
           content_md = excluded.content_md,
           content_version = excluded.content_version,
           category_id = excluded.category_id,
           tags = excluded.tags,
           status = excluded.status,
           visibility = excluded.visibility,
           source = excluded.source,
           updated_at = excluded.updated_at`,
      ).run({
        id: note.id,
        owner_id: note.ownerId,
        title: note.title,
        summary: note.summary,
        content_md: note.contentMd,
        content_version: note.contentVersion,
        category_id: note.categoryId,
        tags: JSON.stringify(note.tags),
        status: note.status,
        visibility: note.visibility,
        source: JSON.stringify(note.source),
        created_at: note.createdAt,
        updated_at: note.updatedAt,
      });
      return note;
    },
    async saveVersion(version: NoteVersion) {
      db.prepare(
        `INSERT INTO note_versions (note_id, version, content_md, created_at)
         VALUES (@note_id, @version, @content_md, @created_at)
         ON CONFLICT(note_id, version) DO NOTHING`,
      ).run({
        note_id: version.noteId,
        version: version.version,
        content_md: version.contentMd,
        created_at: version.createdAt,
      });
    },
    async findVersion(noteId, version) {
      const row = db
        .prepare('SELECT * FROM note_versions WHERE note_id = ? AND version = ?')
        .get(noteId, version) as
        { note_id: string; version: number; content_md: string; created_at: string } | undefined;
      return row
        ? {
            noteId: row.note_id,
            version: row.version,
            contentMd: row.content_md,
            createdAt: row.created_at,
          }
        : null;
    },
    async delete(id) {
      db.prepare('DELETE FROM notes WHERE id = ?').run(id);
    },
  };
  return repo;
}

interface NoteAnnotationRow {
  id: string;
  note_id: string;
  note_version: number;
  quote: string;
  context_prefix: string;
  context_suffix: string;
  comment: string;
  state: string;
  author_id: string;
  created_at: string;
  resolved_at: string | null;
}

function mapNoteAnnotation(r: NoteAnnotationRow): NoteAnnotation {
  return {
    id: r.id,
    noteId: r.note_id,
    noteVersion: r.note_version,
    quote: r.quote,
    contextPrefix: r.context_prefix,
    contextSuffix: r.context_suffix,
    comment: r.comment,
    state: r.state === 'done' ? 'done' : 'open',
    authorId: r.author_id,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
  };
}

export function sqliteNoteAnnotationRepository(db: Database): NoteAnnotationRepository {
  const repo: NoteAnnotationRepository = {
    async findById(id) {
      const row = db.prepare('SELECT * FROM note_annotations WHERE id = ?').get(id) as
        NoteAnnotationRow | undefined;
      return row ? mapNoteAnnotation(row) : null;
    },
    async listByNote(noteId) {
      const rows = db
        .prepare('SELECT * FROM note_annotations WHERE note_id = ? ORDER BY created_at, id')
        .all(noteId) as NoteAnnotationRow[];
      return rows.map(mapNoteAnnotation);
    },
    async countsByOwner(ownerId) {
      const rows = db
        .prepare(
          `SELECT note_id AS noteId, COUNT(*) AS total,
                  SUM(CASE WHEN state = 'open' THEN 1 ELSE 0 END) AS open
           FROM note_annotations WHERE author_id = ? GROUP BY note_id`,
        )
        .all(ownerId) as { noteId: string; total: number; open: number | null }[];
      const counts: Record<string, { total: number; open: number }> = {};
      for (const r of rows) counts[r.noteId] = { total: r.total, open: r.open ?? 0 };
      return counts;
    },
    async save(annotation) {
      db.prepare(
        `INSERT INTO note_annotations
         (id, note_id, note_version, quote, context_prefix, context_suffix, comment, state,
          author_id, created_at, resolved_at)
         VALUES (@id, @note_id, @note_version, @quote, @context_prefix, @context_suffix,
                 @comment, @state, @author_id, @created_at, @resolved_at)
         ON CONFLICT(id) DO UPDATE SET
           quote = excluded.quote,
           context_prefix = excluded.context_prefix,
           context_suffix = excluded.context_suffix,
           comment = excluded.comment,
           state = excluded.state,
           resolved_at = excluded.resolved_at`,
      ).run({
        id: annotation.id,
        note_id: annotation.noteId,
        note_version: annotation.noteVersion,
        quote: annotation.quote,
        context_prefix: annotation.contextPrefix,
        context_suffix: annotation.contextSuffix,
        comment: annotation.comment,
        state: annotation.state,
        author_id: annotation.authorId,
        created_at: annotation.createdAt,
        resolved_at: annotation.resolvedAt,
      });
      return annotation;
    },
    async delete(id) {
      db.prepare('DELETE FROM note_annotations WHERE id = ?').run(id);
    },
  };
  return repo;
}

interface NoteCategoryRow {
  id: string;
  owner_id: string;
  parent_id: string | null;
  name: string;
  created_at: string;
}

function mapNoteCategory(r: NoteCategoryRow): NoteCategory {
  return {
    id: r.id,
    ownerId: r.owner_id,
    parentId: r.parent_id,
    name: r.name,
    createdAt: r.created_at,
  };
}

export function sqliteNoteCategoryRepository(db: Database): NoteCategoryRepository {
  const repo: NoteCategoryRepository = {
    async findById(id) {
      const row = db.prepare('SELECT * FROM note_categories WHERE id = ?').get(id) as
        NoteCategoryRow | undefined;
      return row ? mapNoteCategory(row) : null;
    },
    async listByOwner(ownerId) {
      const rows = db
        .prepare('SELECT * FROM note_categories WHERE owner_id = ? ORDER BY created_at, id')
        .all(ownerId) as NoteCategoryRow[];
      return rows.map(mapNoteCategory);
    },
    async findByParentAndName(ownerId, parentId, name) {
      const row = db
        .prepare('SELECT * FROM note_categories WHERE owner_id = ? AND parent_id IS ? AND name = ?')
        .get(ownerId, parentId, name) as NoteCategoryRow | undefined;
      return row ? mapNoteCategory(row) : null;
    },
    async save(category) {
      db.prepare(
        `INSERT INTO note_categories (id, owner_id, parent_id, name, created_at)
         VALUES (@id, @owner_id, @parent_id, @name, @created_at)
         ON CONFLICT(id) DO UPDATE SET
           parent_id = excluded.parent_id,
           name = excluded.name`,
      ).run({
        id: category.id,
        owner_id: category.ownerId,
        parent_id: category.parentId,
        name: category.name,
        created_at: category.createdAt,
      });
      return category;
    },
    async delete(id) {
      // Port contract: children fall to the deleted node's parent, its notes
      // fall to uncategorized — one transaction, no orphans.
      const node = db.prepare('SELECT * FROM note_categories WHERE id = ?').get(id) as
        NoteCategoryRow | undefined;
      if (!node) return;
      db.transaction(() => {
        db.prepare('UPDATE note_categories SET parent_id = ? WHERE parent_id = ?').run(
          node.parent_id,
          id,
        );
        db.prepare('UPDATE notes SET category_id = NULL WHERE category_id = ?').run(id);
        db.prepare('DELETE FROM note_categories WHERE id = ?').run(id);
      })();
    },
  };
  return repo;
}
