// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * Repository ports — the contracts storage drivers implement.
 *
 * The core package defines ONLY these interfaces. Concrete implementations
 * (SQLite default, in-memory for tests, a future Postgres adapter) live in
 * `@harness-nexus/server` under `src/infra/storage/*`. Nothing in `core` may
 * import a concrete driver.
 */

import type {
  Credential,
  AgentInstance,
  AssistantConfig,
  AssistantMessageRow,
  AssistantSession,
  AssistantToolCallAudit,
  FileObject,
  Job,
  LlmProvider,
  Machine,
  MachineInventorySnapshot,
  McpServer,
  PersonalAccessToken,
  Profile,
  Resource,
  RuntimeConfig,
  SystemSettings,
  User,
} from '../domain/index.js';

export interface ResourceRepository {
  findById(id: string): Promise<Resource | null>;
  findByKey(key: string, scope: 'global' | 'personal', ownerId?: string): Promise<Resource | null>;
  list(filter?: ResourceListFilter): Promise<Resource[]>;
  save(resource: Resource): Promise<Resource>;
  delete(id: string): Promise<void>;
}

export interface ResourceListFilter {
  kind?: Resource['kind'];
  scope?: 'global' | 'personal';
  ownerId?: string;
  target?: Resource['targets'][number];
  /** Soft-deleted rows are excluded unless set (two-stage delete). */
  includeDeleted?: boolean;
}

export interface ProfileRepository {
  findById(id: string): Promise<Profile | null>;
  findByName(name: string, scope: 'global' | 'personal', ownerId?: string): Promise<Profile | null>;
  list(filter?: { scope?: 'global' | 'personal'; ownerId?: string }): Promise<Profile[]>;
  /**
   * Every profile regardless of scope/owner — used by the two-stage delete to
   * decide whether an asset is still referenced. Not exposed over HTTP.
   */
  listAll(): Promise<Profile[]>;
  save(profile: Profile): Promise<Profile>;
  delete(id: string): Promise<void>;
}

export interface UserRepository {
  findById(id: string): Promise<User | null>;
  findByUsername(username: string): Promise<User | null>;
  list(): Promise<User[]>;
  /** Total user count — used to detect the bootstrap (first) registration. */
  count(): Promise<number>;
  /** Count users with a given role — used for last-admin protection. */
  countByRole(role: User['role']): Promise<number>;
  save(user: User): Promise<User>;
  delete(id: string): Promise<void>;
}

export interface PersonalAccessTokenRepository {
  findById(id: string): Promise<PersonalAccessToken | null>;
  findByTokenHash(tokenHash: string): Promise<PersonalAccessToken | null>;
  listByUser(userId: string): Promise<PersonalAccessToken[]>;
  save(token: PersonalAccessToken): Promise<PersonalAccessToken>;
  touchLastUsed(id: string, at: string): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface SystemSettingsRepository {
  /** Always returns a value; drivers seed defaults on first access. */
  get(): Promise<SystemSettings>;
  save(settings: SystemSettings): Promise<SystemSettings>;
}

/**
 * #59 — the assistant transcript's image blobs. Bytes are deliberately NOT a
 * repository-shaped concern beyond these four operations: no dedup (every
 * ingest is its own object), no cross-row queries — the sqlite driver keeps a
 * small registry table and the bytes on local disk; the memory driver keeps
 * them in a map.
 */
export interface FileBlobRepository {
  /** Store one blob; the id is generated. `expiresAt` is stamped by the caller. */
  put(input: { data: Uint8Array; mimeType: string; expiresAt: string }): Promise<FileObject>;
  /** The registry row + bytes; null when the id is unknown OR the payload is missing. */
  get(id: string): Promise<{ row: FileObject; data: Uint8Array } | null>;
  /** Idempotent — a missing row or payload is not an error. */
  delete(id: string): Promise<void>;
  /** Reclaim everything whose (stamped) `expiresAt` has passed; returns the count. */
  purgeExpired(now: string): Promise<number>;
}

export interface McpServerRepository {
  findById(id: string): Promise<McpServer | null>;
  /**
   * Soft-deleted rows (deletedAt set) are excluded unless `includeDeleted`.
   * `findById` still returns them so reference checks and profile editors can
   * see what a dangling entry points at.
   */
  list(filter?: {
    scope?: 'global' | 'personal';
    ownerId?: string;
    dialSite?: McpServer['dialSite'];
    includeDeleted?: boolean;
  }): Promise<McpServer[]>;
  save(server: McpServer): Promise<McpServer>;
  delete(id: string): Promise<void>;
}

export interface CredentialRepository {
  findById(id: string): Promise<Credential | null>;
  /**
   * Find by name within one scope (used to resolve `${cred:NAME}` placeholders).
   * Name uniqueness is per (name, scope, owner) — the route enforces it — so a
   * same-named credential in another tenant's namespace never resolves.
   */
  findByName(
    name: string,
    scope: 'global' | 'personal',
    ownerId?: string,
  ): Promise<Credential | null>;
  list(filter?: { scope?: 'global' | 'personal'; ownerId?: string }): Promise<Credential[]>;
  save(credential: Credential): Promise<Credential>;
  delete(id: string): Promise<void>;
}

export interface MachineRepository {
  findById(id: string): Promise<Machine | null>;
  /** Resolve a machine from its enrollment PAT — used by the /ctl auth middleware. */
  findByEnrollmentPatId(patId: string): Promise<Machine | null>;
  list(filter?: { ownerId?: string }): Promise<Machine[]>;
  save(machine: Machine): Promise<Machine>;
  delete(id: string): Promise<void>;
}

/**
 * Aggregate of all repositories. A storage driver provides one of these; the
 * server composes it into its modules via dependency injection.
 */
export interface InventoryRepository {
  findLatest(
    machineId: string,
    target: MachineInventorySnapshot['target'],
  ): Promise<MachineInventorySnapshot | null>;
  list(machineId: string): Promise<MachineInventorySnapshot[]>;
  /** Upsert — exactly one row per (machine, target); the latest snapshot wins. */
  save(snapshot: MachineInventorySnapshot): Promise<MachineInventorySnapshot>;
  deleteByMachine(machineId: string): Promise<void>;
}

export interface JobRepository {
  findById(id: string): Promise<Job | null>;
  listByMachine(machineId: string): Promise<Job[]>;
  /** Non-terminal jobs (queued | dispatched | running) — recovery input. */
  listRecoverable(): Promise<Job[]>;
  save(job: Job): Promise<Job>;
  deleteByMachine(machineId: string): Promise<void>;
}

export interface AgentInstanceRepository {
  findById(id: string): Promise<AgentInstance | null>;
  listByMachine(machineId: string): Promise<AgentInstance[]>;
  /** One instance per (machine, profile) — re-deploy upserts. */
  findByMachineAndProfile(machineId: string, profileId: string): Promise<AgentInstance | null>;
  /** The `source: 'detected'` instance for (machine, target) — W1 auto-registration. */
  findByMachineAndTarget(
    machineId: string,
    target: AgentInstance['target'],
  ): Promise<AgentInstance | null>;
  save(instance: AgentInstance): Promise<AgentInstance>;
  delete(id: string): Promise<void>;
  deleteByMachine(machineId: string): Promise<void>;
}

export interface RuntimeConfigRepository {
  /** Exactly one config per (machine, target) — the latest spec wins. */
  findByMachineAndTarget(
    machineId: string,
    target: RuntimeConfig['target'],
  ): Promise<RuntimeConfig | null>;
  /** Upsert by id — (machine, target) identity resolution belongs to the caller. */
  save(config: RuntimeConfig): Promise<RuntimeConfig>;
  /** Machine deletion cascade. */
  deleteByMachine(machineId: string): Promise<void>;
}

export interface LlmProviderRepository {
  findById(id: string): Promise<LlmProvider | null>;
  /** Name uniqueness is per (name, scope, owner) — the route enforces it read-then-write. */
  findByName(
    name: string,
    scope: 'global' | 'personal',
    ownerId?: string,
  ): Promise<LlmProvider | null>;
  list(filter?: { scope?: 'global' | 'personal'; ownerId?: string }): Promise<LlmProvider[]>;
  save(provider: LlmProvider): Promise<LlmProvider>;
  delete(id: string): Promise<void>;
}

/**
 * Issue #52 — the platform assistant's stores. Every row is owner-only; the
 * service layer enforces that (404 existence-hiding). Soft-deleted configs
 * (`deletedAt` set) are excluded from `listByOwner` but still readable by id
 * so their sessions stay openable.
 */
export interface AssistantRepository {
  findById(id: string): Promise<AssistantConfig | null>;
  /** The owner's live configs (soft-deleted excluded). */
  listByOwner(ownerId: string): Promise<AssistantConfig[]>;
  /** Name uniqueness is per owner — the service enforces it read-then-write. */
  findByName(ownerId: string, name: string): Promise<AssistantConfig | null>;
  save(config: AssistantConfig): Promise<AssistantConfig>;
  delete(id: string): Promise<void>;

  findSessionById(id: string): Promise<AssistantSession | null>;
  /** The owner's sessions for one assistant (or every assistant when omitted), newest activity first. */
  listSessions(ownerId: string, assistantId?: string): Promise<AssistantSession[]>;
  saveSession(session: AssistantSession): Promise<AssistantSession>;
  deleteSession(id: string): Promise<void>;

  /** Append-only transcript in `seq` order (the caller allocates seq). */
  appendMessage(sessionId: string, row: AssistantMessageRow): Promise<void>;
  listMessages(sessionId: string): Promise<AssistantMessageRow[]>;
  clearMessages(sessionId: string): Promise<void>;

  appendToolCallAudit(audit: AssistantToolCallAudit): Promise<void>;
  listToolCallAudits(sessionId: string): Promise<AssistantToolCallAudit[]>;
}

export interface UnitOfWork {
  resources: ResourceRepository;
  profiles: ProfileRepository;
  users: UserRepository;
  tokens: PersonalAccessTokenRepository;
  settings: SystemSettingsRepository;
  mcpServers: McpServerRepository;
  credentials: CredentialRepository;
  machines: MachineRepository;
  inventories: InventoryRepository;
  jobs: JobRepository;
  agentInstances: AgentInstanceRepository;
  runtimeConfigs: RuntimeConfigRepository;
  llmProviders: LlmProviderRepository;
  assistants: AssistantRepository;
  fileBlobs: FileBlobRepository;
}
