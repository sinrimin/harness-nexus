/** Runtime configuration, resolved from environment with sane defaults. */

export interface ServerConfig {
  port: number;
  host: string;
  /** Storage driver to activate. Defaults to sqlite. */
  storageDriver: 'sqlite' | 'memory';
  /** SQLite database file path. Ignored unless storageDriver === 'sqlite'. */
  sqlitePath: string;
  /** Directory for resource/profile artifacts pulled at install time. */
  dataDir: string;
  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  /** Secret used to sign JWT access tokens. Required. */
  jwtSecret: string;
  /** JWT issuer claim (`iss`). */
  jwtIssuer: string;
  /** JWT access-token lifetime, as a jose-compatible string/number. */
  jwtAccessTtl: string;
  /** Key material for encrypting Credential secrets (AES-256-GCM). */
  credentialEncryptionKey: string;
  /**
   * Phase 3.5 — the absolute origin this server is reachable at from Agent
   * tools' perspective (e.g. the public Caddy HTTPS front door). Used to build
   * the archive URLs inside the emitted marketplace.json and the `/mcp`
   * endpoint inside plugin `.mcp.json` blocks. Claude Code enforces
   * `https://` + non-loopback on archive URLs, so production MUST set this to
   * the public HTTPS origin.
   */
  publicBaseUrl: string;
  /**
   * Phase 7.2 — comma-separated marketplace allowlist (`name=owner/repo` or
   * `name=url`). The server's only outbound-fetch surface. See
   * `infra/source-fetchers/allowlist.ts`.
   */
  marketplaceAllowlist: string;
  /** Phase 7.2 — marketplace catalog cache TTL, in milliseconds. */
  marketplaceFetchTtlMs: number;
  /** Phase 7.2 — per-fetch timeout, in milliseconds. */
  marketplaceFetchTimeoutMs: number;
  /**
   * Phase 7.2 — if set, the marketplace fetcher reads this local file instead
   * of making HTTP requests (test/fixture mode; production leaves it unset).
   */
  marketplaceFixturePath?: string;
  /**
   * Phase 7.4 — optional GitHub PAT for `GitHubSource` (5000 req/hr
   * authenticated vs 60/hr anonymous). Unset ⇒ anonymous.
   */
  skillGithubToken?: string;
  /**
   * Phase 7.4 — comma-separated `owner/repo` taps for `GitHubSource`. Defaults
   * to the 4 `TRUSTED_REPOS`.
   */
  skillGithubTaps: string;
  /** Phase 7.4 — overall multi-source search timeout in ms. */
  skillSearchTimeoutMs: number;
  /**
   * Phase 7.4 — comma-separated source ids to disable (test mode: e.g.
   * `github,well-known,url` to search marketplace-only against a fixture).
   */
  skillDisabledSources?: string;
  /**
   * Phase 8 — max realtime (Socket.IO) message size in bytes. Bounds ACP
   * payloads and job envelopes; see wiki design-phase-8-client.md.
   */
  socketMaxHttpBufferSize: number;
  /** How long a scan/collect REST handler waits for the daemon's reply (C3). */
  inventoryRequestTimeoutMs: number;
  /** `runtime:config.get` round-trip budget (Phase 9 W4). */
  runtimeConfigViewTimeoutMs: number;
  /** W10 — model-list discovery fetch budget (`/api/llm-providers/query-models`). */
  providerModelsTimeoutMs: number;
  /** `workspace:list` round-trip budget (Phase 9 W6 chat directory picker). */
  workspaceListTimeoutMs: number;
  /**
   * #23 D2 — upper bound on the posture aggregate cache, in milliseconds. The
   * topbar readout polls it; 0 disables caching (tests).
   */
  postureCacheTtlMs: number;
  /** `sessions:list` round-trip budget (Phase 9 W7 native session rail; an `npx` adapter spawn is slow cold). */
  sessionsListTimeoutMs: number;
  /** 9 W11 C — `adapters:report` round-trip budget (instant daemon-side; only old daemons wait it out). */
  adaptersReportTimeoutMs: number;
  jobAckTimeoutMs: number;
  jobSweepIntervalMs: number;
  jobMaxAttempts: number;
  /** C5 — max concurrently OPEN chat sessions per machine (concurrency cap). */
  chatMaxSessionsPerMachine: number;
  chatMaxActiveSessionsPerMachine: number;
  /** C5 — how long a permission request may wait for the user's answer. */
  chatPermissionTimeoutMs: number;
  /** C5 — spawn+initialize+session/new watchdog for `chat:session.start`. */
  chatReadyTimeoutMs: number;
  /**
   * 9 W11 E — how long a daemon's /ctl disconnect delays the channel reap
   * (a sub-second transport blip must not kill every channel; a reconnect
   * within the window reconciles instead). 0 = reap immediately (pre-W11).
   */
  chatReconnectGraceMs: number;
  /**
   * 9 W11 D6 — close a user's idle chat channels after this long without a
   * turn (measured from the last turn's END). 0 (the default) NEVER
   * auto-closes: enabling it may close a tab the user still wanted — pair
   * it with the tab bar's idle-age label.
   */
  chatIdleTtlMs: number;
  /**
   * Phase 8 C2 — marketplace emitter `.mcp.json` shape. `client` (default):
   * one stdio `hnx mcp serve` entry per profile. `server`: the pre-C2
   * aggregated-endpoint + PAT-env output (the no-`hnx` fallback).
   */
  emitterMode: 'client' | 'server';
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const jwtSecret = env.JWT_SECRET ?? '';
  if (!jwtSecret || jwtSecret.length < 16) {
    throw new ConfigError(
      'JWT_SECRET is required and must be at least 16 characters. ' +
        'Generate one with, e.g.: openssl rand -base64 48',
    );
  }
  // #21: falling back to JWT_SECRET makes one secret both forge tokens and
  // decrypt the credential store — allowed for dev convenience, but never
  // silently in production.
  if (!env.CREDENTIAL_ENCRYPTION_KEY && env.NODE_ENV === 'production') {
    // eslint-disable-next-line no-console
    console.warn(
      '[config] CREDENTIAL_ENCRYPTION_KEY is not set — reusing JWT_SECRET as the ' +
        'credential AES key. Set a distinct key; rotating JWT_SECRET would render ' +
        'every stored credential undecryptable.',
    );
  }

  return {
    port: Number(env.PORT ?? '8080'),
    host: env.HOST ?? '0.0.0.0',
    storageDriver: (env.STORAGE_DRIVER as ServerConfig['storageDriver']) ?? 'sqlite',
    sqlitePath: env.SQLITE_PATH ?? './data/harnessnexus.sqlite',
    dataDir: env.DATA_DIR ?? './data',
    logLevel: (env.LOG_LEVEL as ServerConfig['logLevel']) ?? 'info',
    jwtSecret,
    jwtIssuer: env.JWT_ISSUER ?? 'harnessnexus',
    jwtAccessTtl: env.JWT_ACCESS_TTL ?? '7d',
    credentialEncryptionKey: env.CREDENTIAL_ENCRYPTION_KEY ?? jwtSecret,
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? 'http://localhost:8080').replace(/\/$/, ''),
    marketplaceAllowlist:
      env.MARKETPLACE_ALLOWLIST ?? 'claude-plugins-official=anthropics/claude-plugins-official',
    marketplaceFetchTtlMs: Number(env.MARKETPLACE_FETCH_TTL_MS ?? '3600000'),
    marketplaceFetchTimeoutMs: Number(env.MARKETPLACE_FETCH_TIMEOUT_MS ?? '10000'),
    ...(env.MARKETPLACE_FIXTURE_PATH
      ? { marketplaceFixturePath: env.MARKETPLACE_FIXTURE_PATH }
      : {}),
    ...(env.GITHUB_TOKEN ? { skillGithubToken: env.GITHUB_TOKEN } : {}),
    skillGithubTaps:
      env.SKILL_GITHUB_TAPS ?? 'openai/skills,anthropics/skills,huggingface/skills,NVIDIA/skills',
    skillSearchTimeoutMs: Number(env.SKILL_SEARCH_TIMEOUT_MS ?? '30000'),
    ...(env.SKILL_DISABLED_SOURCES ? { skillDisabledSources: env.SKILL_DISABLED_SOURCES } : {}),
    socketMaxHttpBufferSize: Number(env.SOCKET_MAX_HTTP_BUFFER ?? String(8 * 1024 * 1024)),
    inventoryRequestTimeoutMs: Number(env.INVENTORY_REQUEST_TIMEOUT_MS ?? '60000'),
    runtimeConfigViewTimeoutMs: Number(env.RUNTIME_CONFIG_VIEW_TIMEOUT_MS ?? '5000'),
    providerModelsTimeoutMs: Number(env.PROVIDER_MODELS_TIMEOUT_MS ?? '10000'),
    workspaceListTimeoutMs: Number(env.WORKSPACE_TIMEOUT_MS ?? '10000'),
    postureCacheTtlMs: Number(env.POSTURE_CACHE_TTL_MS ?? '5000'),
    sessionsListTimeoutMs: Number(env.SESSIONS_TIMEOUT_MS ?? '30000'),
    adaptersReportTimeoutMs: Number(env.ADAPTERS_REPORT_TIMEOUT_MS ?? '30000'),
    jobAckTimeoutMs: Number(env.JOB_ACK_TIMEOUT_MS ?? '60000'),
    jobSweepIntervalMs: Number(env.JOB_SWEEP_INTERVAL_MS ?? '15000'),
    jobMaxAttempts: Number(env.JOB_MAX_ATTEMPTS ?? '3'),
    /**
     * Chat channel budget per machine (the post-W8 redesign): a channel costs
     * one TOTAL slot; a mid-turn session additionally costs one ACTIVE slot.
     * Opening at the total cap EVICTS the oldest non-busy channel instead of
     * rejecting — the cap only bites (SESSION_LIMIT_REACHED) when every
     * channel is mid-turn. Prompting past the active cap answers MACHINE_BUSY.
     */
    chatMaxSessionsPerMachine: Number(env.CHAT_MAX_SESSIONS_PER_MACHINE ?? '12'),
    chatMaxActiveSessionsPerMachine: Number(env.CHAT_MAX_ACTIVE_SESSIONS_PER_MACHINE ?? '5'),
    chatPermissionTimeoutMs: Number(env.CHAT_PERMISSION_TIMEOUT_MS ?? '60000'),
    chatReadyTimeoutMs: Number(env.CHAT_READY_TIMEOUT_MS ?? '30000'),
    chatReconnectGraceMs: Number(env.CHAT_RECONNECT_GRACE_MS ?? '8000'),
    chatIdleTtlMs: Number(env.CHAT_IDLE_TTL_MS ?? '0'),
    emitterMode: (env.EMITTER_MODE as ServerConfig['emitterMode']) ?? 'client',
  };
}
