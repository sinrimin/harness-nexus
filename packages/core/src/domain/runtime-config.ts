/**
 * Phase 9 W3 — the provider/model route ONE harness runtime on ONE machine
 * should use. Pure spec: the API key itself never lives here; the spec names
 * a distributable credential, resolved to plaintext only inside the daemon's
 * machine-PAT bundle fetch. Applied by the daemon into each harness's native
 * config slots (claude-code settings.json env, codex config.toml + auth.json,
 * dsh cordis patch + `~/.dsh/.env`). See wiki design-phase-9-harness-runtime.md §4.3.
 */

/** Plain mirror of `RuntimeConfigSpec` in shared (core stays framework-free). */
export interface RuntimeConfigSpecData {
  providerLabel: string;
  baseUrl: string | null;
  api: 'anthropic-messages' | 'openai';
  model: string;
  credentialName: string;
  /**
   * W10 — provenance only: the LlmProvider this spec was filled from. The
   * spec stays a snapshot; a deleted provider never invalidates the row.
   */
  providerId: string | null;
  /**
   * W10 — extra switchable model ids beyond the default `model`. Consumers:
   * the dsh + opencode writers' native picker catalogs, the claude-code
   * writer's `availableModels` (9 W13), and the server's
   * `chat:session.start` hint for the daemon-side codex/opencode picker
   * rewrite (9 W13). Codex persists only the single root `model`.
   */
  models: string[] | null;
  /**
   * #51 — metadata snapshot for `[model, ...models]`, filled from the
   * provider's registry at PUT time (null = none known; ids absent from the
   * registry stay bare). The pi writer turns entries into real models.json
   * contextWindow/maxTokens/name. Metadata only — temperature/topP/
   * serverTools/extraBody never leave the server.
   */
  modelEntries: RuntimeModelEntry[] | null;
  /**
   * #60 — claude-code's dedicated panel knobs (see `ClaudeCodeConfigData`).
   * null = panel untouched (the row keeps its pre-#60 shape); the daemon
   * writes each present knob into settings.json with revert semantics.
   */
  claudeCode: ClaudeCodeConfigData | null;
  extra: Record<string, unknown> | null;
}

/** #60 — plain mirror of `claudeCodeConfigSchema` in shared (kept in sync). */
export interface ClaudeCodeConfigData {
  authField?: 'ANTHROPIC_AUTH_TOKEN' | 'ANTHROPIC_API_KEY' | undefined;
  switches?: ClaudeCodeSwitchData | undefined;
  tiers?: ClaudeCodeTierPin[] | undefined;
  subagentModel?: string | undefined;
  maxOutputTokens?: number | undefined;
  maxContextTokens?: number | undefined;
  extraBody?: Record<string, unknown> | undefined;
}

export interface ClaudeCodeSwitchData {
  attributionHidden?: boolean | undefined;
  teammates?: boolean | undefined;
  toolSearch?: boolean | undefined;
  maxEffort?: boolean | undefined;
  autoUpgradeDisabled?: boolean | undefined;
  artifactsDisabled?: boolean | undefined;
}

export interface ClaudeCodeTierPin {
  tier: 'sonnet' | 'opus' | 'fable' | 'haiku';
  /** May carry the `[1m]` marker. */
  model: string;
  displayName?: string | undefined;
  capabilities?: string[] | undefined;
}

/** #51 — the metadata subset of a ProviderModelConfig that may ride a spec. */
export interface RuntimeModelEntry {
  id: string;
  displayName?: string | undefined;
  contextWindow?: number | undefined;
  maxOutputTokens?: number | undefined;
  vision?: boolean | undefined;
}

export interface RuntimeConfig {
  id: string;
  machineId: string;
  ownerId: string;
  /** Runtime-managed target only (claude-code | codex | deepseek | opencode | pi). */
  target: 'claude-code' | 'codex' | 'deepseek' | 'opencode' | 'pi';
  spec: RuntimeConfigSpecData;
  createdAt: string;
  updatedAt: string;
}
