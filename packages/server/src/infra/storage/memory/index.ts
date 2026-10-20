// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type {
  UnitOfWork,
  User,
  Role,
  PersonalAccessToken,
  SystemSettings,
  Credential,
  McpServer,
  Profile,
  Resource,
  AssistantConfig,
  AssistantMessageRow,
  AssistantRepository,
  AssistantSession,
  AssistantToolCallAudit,
  Machine,
  MachineInventorySnapshot,
  InventoryRepository,
  Job,
  AgentInstance,
  RuntimeConfig,
  LlmProvider,
  JobRepository,
  AgentInstanceRepository,
  UserRepository,
  PersonalAccessTokenRepository,
  SystemSettingsRepository,
  CredentialRepository,
  McpServerRepository,
  ProfileRepository,
  ResourceRepository,
  MachineRepository,
  RuntimeConfigRepository,
  LlmProviderRepository,
  FileBlobRepository,
  FileObject,
} from '@harness-nexus/core';
import { DEFAULT_SYSTEM_SETTINGS } from '@harness-nexus/core';

/**
 * In-memory storage driver — used by tests and `STORAGE_DRIVER=memory`.
 * Fully functional for Phase 1 + 2.1 aggregates.
 */

export function createMemoryUnitOfWork(): UnitOfWork {
  const users = new Map<string, User>();
  const usernames = new Map<string, string>(); // username -> id
  const tokens = new Map<string, PersonalAccessToken>();
  const tokensByHash = new Map<string, string>(); // hash -> id
  const credentials = new Map<string, Credential>();
  const mcpServers = new Map<string, McpServer>();
  const profiles = new Map<string, Profile>();
  const resources = new Map<string, Resource>();
  const machines = new Map<string, Machine>();
  // key: `${machineId}\u0000${target}` — one latest snapshot per pair
  const inventories = new Map<string, MachineInventorySnapshot>();
  const jobs = new Map<string, Job>();
  // key: `${machineId}\u0000${profileId}` — one deployed instance per pair
  const agentInstances = new Map<string, AgentInstance>();
  const runtimeConfigs = new Map<string, RuntimeConfig>();
  const llmProviders = new Map<string, LlmProvider>();
  const assistantConfigs = new Map<string, AssistantConfig>();
  const assistantSessions = new Map<string, AssistantSession>();
  // key: `${sessionId}\u0000${seq}` — the append-only transcript.
  const assistantMessages = new Map<string, AssistantMessageRow>();
  const assistantAudits = new Map<string, AssistantToolCallAudit>();
  let settings: SystemSettings = {
    allowRegistration: DEFAULT_SYSTEM_SETTINGS.allowRegistration,
    imageRetentionDays: DEFAULT_SYSTEM_SETTINGS.imageRetentionDays,
    updatedAt: new Date(0).toISOString(),
  };

  const userRepo: UserRepository = {
    async findById(id) {
      return users.get(id) ?? null;
    },
    async findByUsername(username) {
      const id = usernames.get(username);
      return id ? (users.get(id) ?? null) : null;
    },
    async list() {
      return [...users.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async count() {
      return users.size;
    },
    async countByRole(role: Role) {
      let n = 0;
      for (const u of users.values()) if (u.role === role) n++;
      return n;
    },
    async save(user) {
      users.set(user.id, user);
      usernames.set(user.username, user.id);
      return user;
    },
    async delete(id) {
      const u = users.get(id);
      if (u) usernames.delete(u.username);
      users.delete(id);
    },
  };

  const tokenRepo: PersonalAccessTokenRepository = {
    async findById(id) {
      return tokens.get(id) ?? null;
    },
    async findByTokenHash(hash) {
      const id = tokensByHash.get(hash);
      return id ? (tokens.get(id) ?? null) : null;
    },
    async listByUser(userId) {
      return [...tokens.values()].filter((t) => t.userId === userId);
    },
    async save(token) {
      tokens.set(token.id, token);
      tokensByHash.set(token.tokenHash, token.id);
      return token;
    },
    async touchLastUsed(id, at) {
      const t = tokens.get(id);
      if (t) tokens.set(id, { ...t, lastUsedAt: at });
    },
    async delete(id) {
      const t = tokens.get(id);
      if (t) tokensByHash.delete(t.tokenHash);
      tokens.delete(id);
    },
  };

  const settingsRepo: SystemSettingsRepository = {
    async get() {
      return settings;
    },
    async save(next) {
      settings = next;
      return next;
    },
  };

  const credentialRepo: CredentialRepository = {
    async findById(id) {
      return credentials.get(id) ?? null;
    },
    async findByName(name, scope, ownerId) {
      return (
        [...credentials.values()].find(
          (c) =>
            c.name === name && c.scope === scope && (scope === 'global' || c.ownerId === ownerId),
        ) ?? null
      );
    },
    async list(filter) {
      return [...credentials.values()]
        .filter((c) => (filter?.scope ? c.scope === filter.scope : true))
        .filter((c) => (filter?.ownerId ? c.ownerId === filter.ownerId : true))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async save(credential) {
      credentials.set(credential.id, credential);
      return credential;
    },
    async delete(id) {
      credentials.delete(id);
    },
  };

  const mcpServerRepo: McpServerRepository = {
    async findById(id) {
      return mcpServers.get(id) ?? null;
    },
    async list(filter) {
      return [...mcpServers.values()]
        .filter((s) => (filter?.scope ? s.scope === filter.scope : true))
        .filter((s) => (filter?.ownerId ? s.ownerId === filter.ownerId : true))
        .filter((s) => (filter?.dialSite ? s.dialSite === filter.dialSite : true))
        .filter((s) => (filter?.includeDeleted ? true : s.deletedAt === undefined))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async save(server) {
      mcpServers.set(server.id, server);
      return server;
    },
    async delete(id) {
      mcpServers.delete(id);
    },
  };

  const profileRepo: ProfileRepository = {
    async findById(id) {
      return profiles.get(id) ?? null;
    },
    async findByName(name, scope, ownerId) {
      return (
        [...profiles.values()].find(
          (p) =>
            p.name === name && p.scope === scope && (scope === 'global' || p.ownerId === ownerId),
        ) ?? null
      );
    },
    async list(filter) {
      return [...profiles.values()]
        .filter((p) => (filter?.scope ? p.scope === filter.scope : true))
        .filter((p) => (filter?.ownerId ? p.ownerId === filter.ownerId : true))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async listAll() {
      return [...profiles.values()];
    },
    async save(profile) {
      profiles.set(profile.id, profile);
      return profile;
    },
    async delete(id) {
      profiles.delete(id);
    },
  };

  const resourceRepo: ResourceRepository = {
    async findById(id) {
      return resources.get(id) ?? null;
    },
    async findByKey(key, scope, ownerId) {
      return (
        [...resources.values()].find(
          (r) =>
            r.key === key &&
            r.scope === scope &&
            (scope === 'global' ? r.ownerId === null : r.ownerId === ownerId),
        ) ?? null
      );
    },
    async list(filter) {
      return [...resources.values()]
        .filter((r) => (filter?.kind ? r.kind === filter.kind : true))
        .filter((r) => (filter?.scope ? r.scope === filter.scope : true))
        .filter((r) => (filter?.ownerId ? r.ownerId === filter.ownerId : true))
        .filter((r) => (filter?.target ? r.targets.includes(filter.target) : true))
        .filter((r) => (filter?.includeDeleted ? true : r.deletedAt === undefined))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async save(resource) {
      resources.set(resource.id, resource);
      return resource;
    },
    async delete(id) {
      resources.delete(id);
    },
  };

  const machineRepo: MachineRepository = {
    async findById(id) {
      return machines.get(id) ?? null;
    },
    async findByEnrollmentPatId(patId) {
      return [...machines.values()].find((m) => m.enrollmentPatId === patId) ?? null;
    },
    async list(filter) {
      return [...machines.values()]
        .filter((m) => (filter?.ownerId ? m.ownerId === filter.ownerId : true))
        .sort((a, b) => a.enrolledAt.localeCompare(b.enrolledAt));
    },
    async save(machine) {
      machines.set(machine.id, machine);
      return machine;
    },
    async delete(id) {
      machines.delete(id);
    },
  };

  const inventoryRepo: InventoryRepository = {
    async findLatest(machineId, target) {
      return inventories.get(`${machineId}\u0000${target}`) ?? null;
    },
    async list(machineId) {
      return [...inventories.values()]
        .filter((s) => s.machineId === machineId)
        .sort((a, b) => a.target.localeCompare(b.target));
    },
    async save(snapshot) {
      inventories.set(`${snapshot.machineId}\u0000${snapshot.target}`, snapshot);
      return snapshot;
    },
    async deleteByMachine(machineId) {
      for (const key of [...inventories.keys()]) {
        if (key.split('\u0000')[0] === machineId) inventories.delete(key);
      }
    },
  };

  const jobRepo: JobRepository = {
    async findById(id) {
      return jobs.get(id) ?? null;
    },
    async listByMachine(machineId) {
      return [...jobs.values()]
        .filter((j) => j.machineId === machineId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    },
    async listRecoverable() {
      return [...jobs.values()]
        .filter((j) => j.status === 'queued' || j.status === 'dispatched' || j.status === 'running')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async save(job) {
      jobs.set(job.id, job);
      return job;
    },
    async deleteByMachine(machineId) {
      for (const [id, j] of [...jobs.entries()]) if (j.machineId === machineId) jobs.delete(id);
    },
  };

  const agentInstanceRepo: AgentInstanceRepository = {
    async findById(id) {
      return agentInstances.get(id) ?? null;
    },
    async listByMachine(machineId) {
      return [...agentInstances.values()]
        .filter((a) => a.machineId === machineId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    },
    async findByMachineAndProfile(machineId, profileId) {
      return (
        [...agentInstances.values()].find(
          (a) => a.machineId === machineId && a.profileId === profileId,
        ) ?? null
      );
    },
    async findByMachineAndTarget(machineId, target) {
      return (
        [...agentInstances.values()].find(
          (a) => a.machineId === machineId && a.target === target && a.source === 'detected',
        ) ?? null
      );
    },
    async save(instance) {
      agentInstances.set(instance.id, instance);
      return instance;
    },
    async delete(id) {
      agentInstances.delete(id);
    },
    async deleteByMachine(machineId) {
      for (const [id, a] of [...agentInstances.entries()]) {
        if (a.machineId === machineId) agentInstances.delete(id);
      }
    },
  };

  const runtimeConfigRepo: RuntimeConfigRepository = {
    async findByMachineAndTarget(machineId, target) {
      return (
        [...runtimeConfigs.values()].find(
          (c) => c.machineId === machineId && c.target === target,
        ) ?? null
      );
    },
    async save(config) {
      runtimeConfigs.set(config.id, config);
      return config;
    },
    async deleteByMachine(machineId) {
      for (const [id, c] of runtimeConfigs) {
        if (c.machineId === machineId) runtimeConfigs.delete(id);
      }
    },
  };

  const llmProviderRepo: LlmProviderRepository = {
    async findById(id) {
      return llmProviders.get(id) ?? null;
    },
    async findByName(name, scope, ownerId) {
      return (
        [...llmProviders.values()].find(
          (p) =>
            p.name === name && p.scope === scope && (scope === 'global' || p.ownerId === ownerId),
        ) ?? null
      );
    },
    async list(filter) {
      return [...llmProviders.values()]
        .filter((p) => (filter?.scope ? p.scope === filter.scope : true))
        .filter((p) => (filter?.ownerId ? p.ownerId === filter.ownerId : true))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async save(provider) {
      llmProviders.set(provider.id, provider);
      return provider;
    },
    async delete(id) {
      llmProviders.delete(id);
    },
  };

  const assistantRepo: AssistantRepository = {
    async findById(id) {
      return assistantConfigs.get(id) ?? null;
    },
    async listByOwner(ownerId) {
      return [...assistantConfigs.values()]
        .filter((c) => c.ownerId === ownerId && c.deletedAt === undefined)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async findByName(ownerId, name) {
      return (
        [...assistantConfigs.values()].find(
          (c) => c.ownerId === ownerId && c.name === name && c.deletedAt === undefined,
        ) ?? null
      );
    },
    async save(config) {
      assistantConfigs.set(config.id, config);
      return config;
    },
    async delete(id) {
      assistantConfigs.delete(id);
    },

    async findSessionById(id) {
      return assistantSessions.get(id) ?? null;
    },
    async listSessions(ownerId, assistantId) {
      return [...assistantSessions.values()]
        .filter(
          (s) =>
            s.ownerId === ownerId && (assistantId === undefined || s.assistantId === assistantId),
        )
        .sort(
          (a, b) =>
            (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt) ||
            b.createdAt.localeCompare(a.createdAt),
        );
    },
    async saveSession(session) {
      assistantSessions.set(session.id, session);
      return session;
    },
    async deleteSession(id) {
      assistantSessions.delete(id);
      for (const key of [...assistantMessages.keys()]) {
        if (key.split('\u0000')[0] === id) assistantMessages.delete(key);
      }
    },

    async appendMessage(sessionId, row) {
      assistantMessages.set(`${sessionId}\u0000${String(row.seq)}`, row);
    },
    async listMessages(sessionId) {
      return [...assistantMessages.entries()]
        .filter(([key]) => key.split('\u0000')[0] === sessionId)
        .map(([, row]) => row)
        .sort((a, b) => a.seq - b.seq);
    },
    async clearMessages(sessionId) {
      for (const key of [...assistantMessages.keys()]) {
        if (key.split('\u0000')[0] === sessionId) assistantMessages.delete(key);
      }
    },

    async appendToolCallAudit(audit) {
      assistantAudits.set(audit.id, audit);
    },
    async listToolCallAudits(sessionId) {
      return [...assistantAudits.values()]
        .filter((a) => a.sessionId === sessionId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    },
  };

  // #59 — image blobs: a map (the memory driver is ephemeral by design).
  const fileBlobs = new Map<string, { row: FileObject; data: Uint8Array }>();
  let blobSeq = 0;
  const fileBlobRepo: FileBlobRepository = {
    async put({ data, mimeType, expiresAt }) {
      blobSeq += 1;
      const now = new Date().toISOString();
      const row: FileObject = {
        id: `blob-${blobSeq}`,
        mimeType,
        size: data.byteLength,
        expiresAt,
        createdAt: now,
      };
      fileBlobs.set(row.id, { row, data });
      return row;
    },
    async get(id) {
      return fileBlobs.get(id) ?? null;
    },
    async delete(id) {
      fileBlobs.delete(id);
    },
    async purgeExpired(now) {
      let purged = 0;
      for (const [id, entry] of fileBlobs) {
        if (entry.row.expiresAt < now) {
          fileBlobs.delete(id);
          purged += 1;
        }
      }
      return purged;
    },
  };

  return {
    users: userRepo,
    tokens: tokenRepo,
    settings: settingsRepo,
    credentials: credentialRepo,
    mcpServers: mcpServerRepo,
    profiles: profileRepo,
    resources: resourceRepo,
    machines: machineRepo,
    inventories: inventoryRepo,
    jobs: jobRepo,
    agentInstances: agentInstanceRepo,
    runtimeConfigs: runtimeConfigRepo,
    llmProviders: llmProviderRepo,
    assistants: assistantRepo,
    fileBlobs: fileBlobRepo,
  };
}
