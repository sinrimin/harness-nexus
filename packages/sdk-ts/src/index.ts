/**
 * @harness-nexus/sdk — thin HTTP client for the Harness Nexus REST API.
 *
 * Used by the web SPA, the install CLI (when it talks to a running server),
 * and external scripts. Auth is via a JWT (from login/register) or a PAT
 * (`hnpat_…`), sent as `Authorization: Bearer <token>`.
 */
import type {
  Role,
  User,
  McpServer,
  DialSite,
  McpTransport,
  Profile,
  Resource,
  ResourceKind,
  AgentTarget,
  ResourceSource,
  TrustTier,
  SkillMeta,
  SkillBundle,
  Machine,
  ChatPrewarmSettings,
} from '@harness-nexus/core';
import type {
  JobView,
  MarketplaceCatalog,
  MarketplacePlugin,
  MarketplaceSource,
  PluginResourceSource,
  McpToolInfo,
  ClientMcpConfig,
  InventorySnapshot,
  InventoryDiff,
  RuntimeInfo,
  RuntimeTarget,
  HarnessAction,
  RuntimeConfigSpec,
  RuntimeConfigView,
  LlmProviderView,
  LlmModelInfo,
  ProviderApiKind,
  ProviderModelsQueryInput,
} from '@harness-nexus/shared';
export {
  SCANNABLE_TARGETS,
  RUNTIME_API_SUPPORT,
  PROVIDER_API_SUPPORT,
  PREWARM_ADAPTER_TARGETS,
  DEFAULT_CHAT_PREWARM_SETTINGS,
  providerApiToSpecApi,
  jobViewSchema,
  HOOK_EVENTS,
  HOOK_SUPPORT,
  resolveTrustTier,
  resolveDialSite,
  transportPlaceholderNames,
  marketplacePluginToResourceSource,
  skillMetaToResourceSource,
  type HookEvent,
} from '@harness-nexus/shared';
export type {
  ChatPrewarmSettings,
  JobView,
  InventorySnapshot,
  InventoryDiff,
  RuntimeInfo,
  RuntimeTarget,
  HarnessAction,
  RuntimeConfigSpec,
  RuntimeConfigView,
  LlmProviderView,
  LlmModelInfo,
  ProviderApiKind,
  MarketplaceCatalog,
  MarketplacePlugin,
  MarketplaceSource,
  PluginResourceSource,
  McpToolInfo,
  ClientMcpConfig,
};

export interface SdkOptions {
  baseUrl: string;
  /** Raw JWT or PAT, sent as `Authorization: Bearer <token>`. */
  token?: string;
  fetch?: typeof fetch;
}

export interface PublicUser extends Omit<User, 'passwordHash'> {}
export interface PatView {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}
/** Machine API view (Phase 8) — the domain Machine plus derived presence. */
export interface MachineView extends Machine {
  online: boolean;
}
/** #23 D2 — whether a posture figure counts the caller's rows or every tenant's. */
export type PostureScope = 'self' | 'all';
/**
 * #23 D2 — the readout aggregate. Each figure re-derives its row set with the
 * same visibility rule as the list page it links to, and `scopes` says which
 * rows each number counted (chat stays `self` even for admins — owner-only).
 */
export interface Posture {
  scope: PostureScope;
  scopes: {
    machines: PostureScope;
    agents: PostureScope;
    queuedJobs: PostureScope;
    mcp: PostureScope;
    llmProviders: PostureScope;
    channels: PostureScope;
  };
  generatedAt: string;
  machines: { online: number; total: number };
  agents: number;
  mcp: { connected: number; total: number };
  llmProviders: number;
  queuedJobs: number;
  channels: number;
}
/**
 * One of the agent's OWN persisted sessions (9 W7) — a LIVE read through the
 * daemon (`sessions:list`), never platform-persisted metadata.
 */
export interface NativeSessionView {
  sessionId: string;
  cwd: string;
  title?: string | null;
  updatedAt?: string | null;
  /** 9 W7 — the model route the session pinned at creation (dsh only). */
  model?: string | null;
  /** 9 W7 — set when the daemon knows this session cannot be resumed. */
  staleReason?: string;
  /** Post-W8 — server-computed: a live chat channel is attached to this session. */
  open?: boolean;
  /** With `open` — the channel id to REJOIN (`chat:session.open {sessionId}`). */
  openChannelId?: string;
}

/** Machine summary riding GET /api/agent-instances/:id (9 W6 session page). */
export interface AgentInstanceMachineView {
  id: string;
  name: string;
  online: boolean;
  remoteChatEnabled: boolean;
  baseWorkspace: string | null;
  capabilities: string[];
}

/**
 * One live adapter process the daemon owns (9 W11 C — the machine panel's
 * row; mirrors `adapterProcessViewSchema` in shared).
 */
export interface AdapterProcessView {
  wireSessionId: string;
  target: string;
  pgid: number;
  nativeSessionId?: string;
  startedAt: number;
  command: string;
}

/**
 * An agent on a machine (Phase 8 C4 deploy rows + Phase 9 W1 detected rows).
 * Detected instances have null profile/job ids — they came from a runtime
 * probe, not a deploy.
 */
export interface AgentInstanceView {
  id: string;
  machineId: string;
  ownerId: string;
  target: string;
  profileId: string | null;
  profileVersion: string | null;
  name: string;
  directory: string;
  jobId: string | null;
  source: 'deploy' | 'detected';
  createdAt: string;
  updatedAt: string;
}

/** Response of POST /api/machines/:id/inventory/import (Phase 8 C3). */
export interface ImportResult {
  profile: Profile;
  created: { kind: string; name: string; id: string; key?: string }[];
  reused: { kind: string; name: string; id: string; key?: string }[];
  failed: { kind: string; name: string; error: string }[];
  warnings: string[];
}

export interface CredentialView {
  id: string;
  name: string;
  secretPreview: string;
  scope: 'global' | 'personal';
  ownerId: string | null;
  /** Phase 8 C2 — may the plaintext reach a client shim (always true for personal). */
  distributable: boolean;
  createdAt: string;
  updatedAt: string;
}
// McpServer is re-exported directly from core (it carries no secret fields).
// McpTransport likewise, so callers can build typed transport objects.
// Profile is re-exported from core too (its entries reference McpServer ids).

/** Live connection state of a proxy-mode upstream MCP server. */
export interface McpServerStatus {
  id: string;
  name: string;
  status: 'connecting' | 'connected' | 'error' | 'disconnected';
  detail?: string;
  /** Cached tool count for this connection (Phase 2.4; absent on older servers). */
  toolCount?: number;
}

/**
 * Input shape for a profile entry — two arms (Phase 3.5):
 *  - `{ mcpServerId }` (2.2) — kind is implicitly 'mcp'.
 *  - `{ resourceId, kind }` — a Resource reference ('mcp' excluded: MCP
 *    servers are managed via /api/mcp-servers and enter via the other arm).
 */
export type ProfileEntryInput =
  | { mcpServerId: string; pinnedVersion?: string }
  | {
      resourceId: string;
      kind: Exclude<ResourceKind, 'mcp'>;
      pinnedVersion?: string;
      installOptions?: Record<string, unknown>;
    };

interface ApiErrorBody {
  error: string;
  message: string;
  statusCode?: number;
  details?: unknown;
}

export class HarnessNexusError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HarnessNexusError';
  }
}

export class HarnessNexusClient {
  private token: string | undefined;
  private readonly opts: SdkOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SdkOptions) {
    this.opts = opts;
    this.token = opts.token;
    // Bind fetch: in the browser `fetch` is a method on `window` and relies on
    // `this === window`. Taking it as a bare reference and calling it later
    // throws "does not implement interface Window". Bind it to globalThis so it
    // can be invoked as a free function. (Node 18+ also exposes fetch on
    // globalThis.)
    const bound = globalThis.fetch?.bind(globalThis);
    this.fetchImpl = opts.fetch ?? bound ?? fetch;
  }

  /** Update the token after login/register. */
  setToken(token: string | undefined): void {
    this.token = token;
  }

  getToken(): string | undefined {
    return this.token;
  }

  // ---- auth ----
  async login(username: string, password: string): Promise<{ token: string; user: PublicUser }> {
    const res = await this.request('POST', '/api/auth/login', { username, password }, true);
    this.token = res.token;
    return res;
  }

  async register(
    username: string,
    password: string,
    email?: string,
  ): Promise<{ token: string; user: PublicUser }> {
    const res = await this.request(
      'POST',
      '/api/auth/register',
      { username, password, email },
      true,
    );
    this.token = res.token;
    return res;
  }

  async getMe(): Promise<PublicUser> {
    const res = await this.request('GET', '/api/auth/me');
    return res.user;
  }

  // ---- users (admin) ----
  async listUsers(): Promise<PublicUser[]> {
    const res = await this.request('GET', '/api/users');
    return res.users;
  }

  async createUser(input: {
    username: string;
    password: string;
    email?: string;
    role?: Role;
  }): Promise<PublicUser> {
    const res = await this.request('POST', '/api/users', input);
    return res.user;
  }

  async deleteUser(id: string): Promise<void> {
    await this.request('DELETE', `/api/users/${id}`);
  }

  async updateUserRole(id: string, role: Role): Promise<PublicUser> {
    const res = await this.request('PATCH', `/api/users/${id}/role`, { role });
    return res.user;
  }

  // ---- PATs ----
  async createPat(input: {
    name: string;
    /**
     * Token purpose (Phase 3.5): `api` (default) powers the CLI/REST API;
     * `marketplace` is an emit token that ONLY authenticates the marketplace
     * emitter URL. For `marketplace`, the response additionally carries the
     * ready-to-paste `addCommand` + `marketplaceUrl` (shown once, like the token).
     */
    kind?: 'api' | 'marketplace';
    scopes?: string[];
    expiresAt?: string;
  }): Promise<{
    pat: PatView;
    token: string;
    marketplaceUrl?: string;
    addCommand?: string;
  }> {
    return this.request('POST', '/api/pats', input);
  }

  async listPats(): Promise<PatView[]> {
    const res = await this.request('GET', '/api/pats');
    return res.pats;
  }

  async revokePat(id: string): Promise<void> {
    await this.request('DELETE', `/api/pats/${id}`);
  }

  // ---- machines (Phase 8 C1) ----
  /** #23 D2 — the topbar readout: posture aggregate, scoped to the caller. */
  async getPosture(): Promise<Posture> {
    return this.request('GET', '/api/status/posture');
  }

  async createMachine(input: { name: string }): Promise<{ machine: MachineView; token: string }> {
    return this.request('POST', '/api/machines', input);
  }

  async listMachines(): Promise<MachineView[]> {
    const res = await this.request('GET', '/api/machines');
    return res.machines;
  }

  async getMachine(id: string): Promise<MachineView> {
    const res = await this.request('GET', `/api/machines/${id}`);
    return res.machine;
  }

  async updateMachine(
    id: string,
    input: {
      name?: string;
      remoteChatEnabled?: boolean;
      baseWorkspace?: string | null;
      /** Issue #3 — machine-scoped per-target pre-warm switches (replace semantics). */
      chatPrewarm?: ChatPrewarmSettings;
    },
  ): Promise<MachineView> {
    const res = await this.request('PATCH', `/api/machines/${id}`, input);
    return res.machine;
  }

  async deleteMachine(id: string): Promise<void> {
    await this.request('DELETE', `/api/machines/${id}`);
  }

  /** 9 W6 — one level of subdirectories under the machine's base workspace. */
  async listMachineWorkspace(
    machineId: string,
    path?: string,
  ): Promise<{
    path: string;
    directories: { name: string; path: string }[];
    /** 9 W9 C — regular files at the level (empty against old daemons). */
    files: { name: string; path: string }[];
  }> {
    const query = path !== undefined && path !== '' ? `?path=${encodeURIComponent(path)}` : '';
    return this.request('GET', `/api/machines/${machineId}/workspace${query}`);
  }

  // ---- machine inventory (Phase 8 C3; runtime arm Phase 9 W1) ----
  async getMachineInventory(machineId: string): Promise<
    {
      target: string;
      daemonVersion: string | null;
      reportedAt: string;
      scannedAt: string;
      agents: InventorySnapshot['agents'];
      runtime: RuntimeInfo | null;
    }[]
  > {
    const res = await this.request('GET', `/api/machines/${machineId}/inventory`);
    return res.inventory;
  }

  async scanMachineInventory(
    machineId: string,
    targets?: InventorySnapshot['target'][],
  ): Promise<
    {
      target: string;
      reportedAt: string;
      agents: InventorySnapshot['agents'];
      runtime: RuntimeInfo | null;
    }[]
  > {
    const res = await this.request('POST', `/api/machines/${machineId}/inventory/scan`, {
      ...(targets ? { targets } : {}),
    });
    return res.inventory;
  }

  async diffMachineInventory(machineId: string, profileId: string): Promise<InventoryDiff> {
    const res = await this.request(
      'GET',
      `/api/machines/${machineId}/inventory/diff?profile=${encodeURIComponent(profileId)}`,
    );
    return res.diff;
  }

  async importMachineInventory(
    machineId: string,
    input: {
      target: InventorySnapshot['target'];
      profileName: string;
      items: { kind: 'skill' | 'command' | 'sub_agent' | 'rule' | 'mcp'; name: string }[];
    },
  ): Promise<ImportResult> {
    return this.request('POST', `/api/machines/${machineId}/inventory/import`, input);
  }

  /** Capture the Agent's current state as a profile (Phase 9 W1 — no baseline). */
  async captureMachineInventory(
    machineId: string,
    input: { target: InventorySnapshot['target']; profileName: string },
  ): Promise<ImportResult> {
    return this.request('POST', `/api/machines/${machineId}/inventory/capture`, input);
  }

  // ---- jobs + agents (Phase 8 C4) ----
  async createMachineJob(
    machineId: string,
    input: { profileId: string; directory?: string },
  ): Promise<JobView> {
    const res = await this.request('POST', `/api/machines/${machineId}/jobs`, input);
    return res.job;
  }

  /** Queue a harness install/upgrade/pin job (Phase 9 W2 — owner-only server-side). */
  async createHarnessJob(
    machineId: string,
    input: { action: HarnessAction; target: RuntimeTarget; version?: string },
  ): Promise<JobView> {
    const res = await this.request('POST', `/api/machines/${machineId}/jobs`, {
      type: 'harness',
      ...input,
    });
    return res.job;
  }

  async listMachineJobs(machineId: string): Promise<JobView[]> {
    const res = await this.request('GET', `/api/machines/${machineId}/jobs`);
    return res.jobs;
  }

  async cancelJob(jobId: string): Promise<JobView> {
    const res = await this.request('POST', `/api/jobs/${jobId}/cancel`);
    return res.job;
  }

  async listMachineAgents(machineId: string): Promise<AgentInstanceView[]> {
    const res = await this.request('GET', `/api/machines/${machineId}/agents`);
    return res.agents;
  }

  /** 9 W11 C — live adapter processes the daemon owns (the machine panel). */
  async listMachineAdapters(machineId: string): Promise<AdapterProcessView[]> {
    const res = await this.request('GET', `/api/machines/${machineId}/adapters`);
    return res.adapters;
  }

  /** 9 W11 C — operator kill: closes the channel behind the adapter row. */
  async closeMachineAdapter(machineId: string, sessionId: string): Promise<{ closed: boolean }> {
    return this.request(
      'POST',
      `/api/machines/${machineId}/adapters/${encodeURIComponent(sessionId)}/close`,
    );
  }

  /** 9 W6 — the chat session page's agent + machine gating summary. */
  async getAgentInstance(
    agentInstanceId: string,
  ): Promise<{ agent: AgentInstanceView; machine: AgentInstanceMachineView }> {
    return this.request('GET', `/api/agent-instances/${agentInstanceId}`);
  }

  /** 9 W7 — the agent's OWN sessions, listed live from the target's native store. */
  async listAgentSessions(
    agentInstanceId: string,
    opts?: { refresh?: boolean },
  ): Promise<{
    agent: AgentInstanceView;
    supported: boolean;
    sessions: NativeSessionView[];
  }> {
    const qs = opts?.refresh === true ? '?refresh=1' : '';
    return this.request('GET', `/api/agent-instances/${agentInstanceId}/sessions${qs}`);
  }

  /** The resolved profile bundle a deploy fetches (machine PAT exception #2). */
  async getDeployBundle(profileId: string): Promise<{ profile: Profile; artifacts: unknown[] }> {
    return this.request(
      'GET',
      `/api/client/deploy-bundle?profile=${encodeURIComponent(profileId)}`,
    );
  }

  // ---- runtime provider config (Phase 9 W3; PUT queues the apply-config job) ----
  async getRuntimeConfig(machineId: string, target: RuntimeTarget): Promise<RuntimeConfigView> {
    const res = await this.request(
      'GET',
      `/api/machines/${machineId}/runtime-config/${encodeURIComponent(target)}`,
    );
    return res.config;
  }

  async putRuntimeConfig(
    machineId: string,
    target: RuntimeTarget,
    spec: RuntimeConfigSpec,
  ): Promise<{ config: RuntimeConfigView; job: JobView }> {
    return this.request(
      'PUT',
      `/api/machines/${machineId}/runtime-config/${encodeURIComponent(target)}`,
      spec,
    );
  }

  /** The redacted effective-config view (Phase 9 W4; requires the daemon online). */
  async getRuntimeConfigView(
    machineId: string,
    target: RuntimeTarget,
  ): Promise<{
    target: RuntimeTarget;
    files: { path: string; content: string }[];
    redacted: string[];
  }> {
    return this.request(
      'GET',
      `/api/machines/${machineId}/runtimes/${encodeURIComponent(target)}/config`,
    );
  }

  /** The resolved `{spec, secret}` bundle an apply-config job fetches (machine PAT only). */
  async getRuntimeConfigBundle(target: RuntimeTarget): Promise<{
    target: RuntimeTarget;
    spec: RuntimeConfigSpec;
    secret: string;
  }> {
    return this.request('GET', `/api/client/runtime-config?target=${encodeURIComponent(target)}`);
  }

  // ---- LLM providers (Phase 9 W10; cc-switch-style reusable routes) ----
  async listLlmProviders(): Promise<LlmProviderView[]> {
    const res = await this.request('GET', '/api/llm-providers');
    return res.providers;
  }

  async createLlmProvider(input: {
    name: string;
    api: ProviderApiKind;
    baseUrl?: string;
    credentialName: string;
    scope?: 'global' | 'personal';
  }): Promise<{ provider: LlmProviderView }> {
    return this.request('POST', '/api/llm-providers', input);
  }

  async updateLlmProvider(
    id: string,
    input: {
      name?: string;
      api?: ProviderApiKind;
      /** `null` clears the override back to the official endpoint. */
      baseUrl?: string | null;
      credentialName?: string;
    },
  ): Promise<{ provider: LlmProviderView }> {
    return this.request('PATCH', `/api/llm-providers/${id}`, input);
  }

  async deleteLlmProvider(id: string): Promise<void> {
    await this.request('DELETE', `/api/llm-providers/${id}`);
  }

  /** 获取模型 — discover the endpoint's model list (server-side fetch). */
  async queryProviderModels(
    query: ProviderModelsQueryInput | { providerId: string },
  ): Promise<LlmModelInfo[]> {
    const res = await this.request('POST', '/api/llm-providers/query-models', query);
    return res.models;
  }

  // ---- settings ----
  async getRegistration(): Promise<{ allowRegistration: boolean }> {
    return this.request('GET', '/api/settings/registration', undefined, true);
  }

  async setRegistration(allowRegistration: boolean): Promise<{ allowRegistration: boolean }> {
    return this.request('PUT', '/api/settings/registration', { allowRegistration });
  }

  // ---- credentials ----
  async createCredential(input: {
    name: string;
    secret: string;
    scope: 'global' | 'personal';
    distributable?: boolean;
  }): Promise<{ credential: CredentialView }> {
    return this.request('POST', '/api/credentials', input);
  }

  async listCredentials(): Promise<CredentialView[]> {
    const res = await this.request('GET', '/api/credentials');
    return res.credentials;
  }

  async updateCredential(
    id: string,
    input: { name?: string; secret?: string },
  ): Promise<{ credential: CredentialView }> {
    return this.request('PATCH', `/api/credentials/${id}`, input);
  }

  async deleteCredential(id: string): Promise<void> {
    await this.request('DELETE', `/api/credentials/${id}`);
  }

  // ---- mcp servers ----
  async createMcpServer(input: {
    name: string;
    transport: McpTransport;
    dialSite?: DialSite;
    scope: 'global' | 'personal';
  }): Promise<{ mcpServer: McpServer }> {
    return this.request('POST', '/api/mcp-servers', input);
  }

  /** `includeDeleted` also returns soft-deleted rows (profile editor greys them). */
  async listMcpServers(opts?: { includeDeleted?: boolean }): Promise<McpServer[]> {
    const q = opts?.includeDeleted ? '?includeDeleted=1' : '';
    const res = await this.request('GET', `/api/mcp-servers${q}`);
    return res.mcpServers;
  }

  async updateMcpServer(
    id: string,
    input: { name?: string; transport?: McpTransport; dialSite?: DialSite },
  ): Promise<{ mcpServer: McpServer }> {
    return this.request('PATCH', `/api/mcp-servers/${id}`, input);
  }

  /**
   * Two-stage delete: the first call soft-deletes (mode 'soft'); a second
   * call physically removes the row (mode 'hard') once no profile references
   * it — otherwise the server answers 409 ASSET_STILL_REFERENCED.
   */
  async deleteMcpServer(id: string): Promise<{ ok: boolean; mode: 'soft' | 'hard' }> {
    return this.request('DELETE', `/api/mcp-servers/${id}`);
  }

  /**
   * Client config fetch (Phase 8 C2) — the `hnx mcp serve` shim's world model.
   * Accepts an api PAT/JWT or a machine PAT; resolved transports (plaintext
   * included) appear for CLIENT-dialed servers only.
   */
  async getClientMcpConfig(profileId: string): Promise<ClientMcpConfig> {
    return this.request('GET', `/api/client/mcp-config?profile=${encodeURIComponent(profileId)}`);
  }

  // ---- mcp server status (live registry) ----
  async listMcpServerStatuses(): Promise<McpServerStatus[]> {
    const res = await this.request('GET', '/api/mcp-servers/status');
    return res.statuses;
  }

  // ---- mcp server connect/disconnect + tool inspection (Phase 2.4) ----
  // Operator control surface on the proxy registry pool. proxy-only servers.
  async connectMcpServer(id: string): Promise<McpServerStatus> {
    const res = await this.request('POST', `/api/mcp-servers/${id}/connect`);
    return res.status;
  }

  async disconnectMcpServer(id: string): Promise<McpServerStatus> {
    const res = await this.request('POST', `/api/mcp-servers/${id}/disconnect`);
    return res.status;
  }

  /** Cached tool list (original names). Empty when not connected. */
  async listMcpServerTools(id: string): Promise<McpToolInfo[]> {
    const res = await this.request('GET', `/api/mcp-servers/${id}/tools`);
    return res.tools;
  }

  /** Re-pull the tool list from the upstream. Requires an active connection. */
  async refreshMcpServerTools(id: string): Promise<McpToolInfo[]> {
    const res = await this.request('POST', `/api/mcp-servers/${id}/tools/refresh`);
    return res.tools;
  }

  // ---- profiles ----
  async createProfile(input: {
    name: string;
    description?: string;
    /** Single immutable target this profile is shaped for (Phase 3.2). */
    target: AgentTarget;
    scope: 'global' | 'personal';
    entries?: ProfileEntryInput[];
  }): Promise<{ profile: Profile }> {
    return this.request('POST', '/api/profiles', input);
  }

  async listProfiles(): Promise<Profile[]> {
    const res = await this.request('GET', '/api/profiles');
    return res.profiles;
  }

  async getProfile(id: string): Promise<{ profile: Profile }> {
    return this.request('GET', `/api/profiles/${id}`);
  }

  async updateProfile(
    id: string,
    input: {
      name?: string;
      description?: string;
      /**
       * #18: versions are server-assigned (auto-numbered; bumped when the
       * entries change). Sending a version is ignored/stripped.
       */
      entries?: ProfileEntryInput[];
    },
  ): Promise<{ profile: Profile }> {
    return this.request('PATCH', `/api/profiles/${id}`, input);
  }

  async deleteProfile(id: string): Promise<void> {
    await this.request('DELETE', `/api/profiles/${id}`);
  }

  // ---- resources ----
  async createResource(input: {
    key: string;
    kind: ResourceKind;
    name: string;
    description?: string;
    version?: string;
    source: ResourceSource;
    scope: 'global' | 'personal';
    targets?: AgentTarget[];
    labels?: Record<string, string>;
  }): Promise<{ resource: Resource }> {
    return this.request('POST', '/api/resources', input);
  }

  async listResources(filter?: {
    kind?: ResourceKind;
    scope?: 'global' | 'personal';
    target?: AgentTarget;
    /** Also return soft-deleted rows (profile editor greys them). */
    includeDeleted?: boolean;
  }): Promise<Resource[]> {
    const qs = new URLSearchParams();
    if (filter?.kind) qs.set('kind', filter.kind);
    if (filter?.includeDeleted) qs.set('includeDeleted', '1');
    if (filter?.scope) qs.set('scope', filter.scope);
    if (filter?.target) qs.set('target', filter.target);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const res = await this.request('GET', `/api/resources${suffix}`);
    return res.resources;
  }

  async getResource(id: string): Promise<{ resource: Resource }> {
    return this.request('GET', `/api/resources/${id}`);
  }

  async updateResource(
    id: string,
    input: {
      key?: string;
      name?: string;
      description?: string;
      version?: string;
      source?: ResourceSource;
      targets?: AgentTarget[];
      labels?: Record<string, string>;
    },
  ): Promise<{ resource: Resource }> {
    return this.request('PATCH', `/api/resources/${id}`, input);
  }

  /** Two-stage delete — see deleteMcpServer. */
  async deleteResource(id: string): Promise<{ ok: boolean; mode: 'soft' | 'hard' }> {
    return this.request('DELETE', `/api/resources/${id}`);
  }

  // ---- skills hub (Phase 7.2) ----

  /** List the configured marketplace allowlist (no fetch). */
  async listMarketplaces(): Promise<{ marketplaces: { id: string }[] }> {
    return this.request('GET', '/api/skills/marketplaces');
  }

  /**
   * List a marketplace's plugins (fetched + cached server-side). Optional
   * `category` and free-text `q` filters narrow the result.
   */
  async listMarketplacePlugins(
    id: string,
    filter?: { category?: string; q?: string },
  ): Promise<{ plugins: MarketplacePlugin[] }> {
    const params = new URLSearchParams();
    if (filter?.category) params.set('category', filter.category);
    if (filter?.q) params.set('q', filter.q);
    const qs = params.toString();
    return this.request('GET', `/api/skills/marketplaces/${id}/plugins${qs ? `?${qs}` : ''}`);
  }

  /**
   * Multi-source skill search (Phase 7.4). Dispatches to all configured
   * SkillSources in parallel, merges, dedupes by identifier, ranks by trust.
   * Returns the `timedOut` / `errored` source ids so the UI can surface a
   * partial-results notice.
   */
  async searchSkills(
    q: string,
    limit?: number,
  ): Promise<{ results: SkillMeta[]; timedOut: string[]; errored: string[] }> {
    const params = new URLSearchParams({ q });
    if (limit !== undefined) params.set('limit', String(limit));
    return this.request('GET', `/api/skills/search?${params.toString()}`);
  }

  // ---- core request helper ----
  private async request(
    method: string,
    path: string,
    body?: unknown,
    isPublic = false,
  ): Promise<any> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (!isPublic && this.token) headers.Authorization = `Bearer ${this.token}`;

    const url = this.opts.baseUrl.replace(/\/$/, '') + path;
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await this.fetchImpl(url, init);

    const text = await res.text();
    const parsed = text ? (JSON.parse(text) as unknown) : undefined;

    if (!res.ok) {
      const err = parsed as ApiErrorBody | undefined;
      throw new HarnessNexusError(
        err?.message ?? `request failed: ${res.status}`,
        err?.error ?? 'REQUEST_FAILED',
        err?.statusCode ?? res.status,
        err?.details,
      );
    }
    return parsed;
  }
}

export type {
  Role,
  McpServer,
  DialSite,
  McpTransport,
  Profile,
  Resource,
  ResourceKind,
  ResourceSource,
  AgentTarget,
  // Phase 7.1 — skill-sourcing domain types (back the SkillSource port).
  TrustTier,
  SkillMeta,
  SkillBundle,
};
