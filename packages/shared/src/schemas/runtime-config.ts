import { z } from 'zod';
import { runtimeTargetSchema, type RuntimeTarget } from './inventory.js';

/**
 * Runtime provider-config schemas (Phase 9 W3) — the LLM route a harness
 * runtime should use. One spec per (machine, target), upserted over REST and
 * applied by the daemon into each harness's NATIVE config slots.
 * wiki design-phase-9-harness-runtime.md §4.3.
 *
 * The spec NEVER carries a secret — it references a distributable credential
 * by name. The plaintext is resolved server-side only for the daemon's
 * machine-PAT bundle fetch (`/api/client/runtime-config`), same blast-radius
 * rules as the deploy bundle.
 */

/**
 * The API flavor the provider endpoint speaks. How each harness consumes it:
 * claude-code always speaks Anthropic Messages (base URL + bearer token);
 * codex always speaks OpenAI (Responses-only in current builds); dsh's pi-ai
 * routes take either (`anthropic-messages` / `openai-completions`).
 */
export const providerApiSchema = z.enum(['anthropic-messages', 'openai']);
export type ProviderApi = z.infer<typeof providerApiSchema>;

/** Which api flavors each runtime target can be pointed at (form + route gate). */
export const RUNTIME_API_SUPPORT: Record<RuntimeTarget, readonly ProviderApi[]> = {
  'claude-code': ['anthropic-messages'],
  codex: ['openai'],
  deepseek: ['anthropic-messages', 'openai'],
  // 9 W12 — the provider's `npm` AI-SDK key covers both wires
  // (@ai-sdk/openai[-compatible] / @ai-sdk/anthropic).
  opencode: ['anthropic-messages', 'openai'],
  // 9 W16 — pi's models.json `api` values cover both coarse flavors
  // (anthropic-messages / openai-completions / openai-responses).
  pi: ['anthropic-messages', 'openai'],
};

/**
 * 9 W13 — the opencode provider id our writer owns inside
 * `~/.config/opencode/opencode.json` (single source: the W12 writer's block,
 * and the daemon's model-option filter, which keeps only
 * `${OPENCODE_PROVIDER_ID}/<model>` values). Codex uses `harness_nexus`
 * (underscore, TOML key) and dsh `harness-nexus` (YAML key) — separate slots,
 * not this constant.
 */
export const OPENCODE_PROVIDER_ID = 'harness-nexus';

/**
 * 9 W13 — dsh's pi-ai provider key in `~/.dsh/settings.yaml` (same spelling
 * as opencode's id, but a different slot). dsh's ACP model option values are
 * JSON `[provider, model]` tuples; the daemon-side filter allows exactly
 * `["harness-nexus", <model>]` for the configured set.
 */
export const DSH_PROVIDER_ID = 'harness-nexus';

/**
 * 9 W16 — pi's provider key in `~/.pi/agent/models.json` (again the same
 * spelling, again a different slot). pi's RPC model refs are
 * `provider/id`-shaped, so the daemon-side W13 rewrite keeps only
 * `${PI_PROVIDER_ID}/<model>` values for the configured set.
 */
export const PI_PROVIDER_ID = 'harness-nexus';

/**
 * #60 — the `[1m]` suffix claude-code reads on a model id (alias or full
 * name): sending is marker-stripped, the `context-1m` beta rides along, and
 * for ids it does not know it makes claude-code ASSUME a 1M window (in which
 * case `CLAUDE_CODE_MAX_CONTEXT_TOKENS` does not apply). The marker lives
 * INSIDE the model string end to end (cc-switch's representation); only
 * `availableModels` entries are written marker-stripped — the allowlist
 * matches plain ids, the marker is a /model-and-env-slot concept.
 */
export const CLAUDE_ONE_M_MARKER = '[1m]';

export function hasClaudeOneMarker(model: string): boolean {
  return model.trimEnd().toLowerCase().endsWith(CLAUDE_ONE_M_MARKER);
}

export function stripClaudeOneMarker(model: string): string {
  const trimmed = model.trimEnd();
  if (!trimmed.toLowerCase().endsWith(CLAUDE_ONE_M_MARKER)) return model;
  return trimmed.slice(0, -CLAUDE_ONE_M_MARKER.length).trimEnd();
}

export function setClaudeOneMarker(model: string, enabled: boolean): string {
  const base = stripClaudeOneMarker(model).trim();
  return enabled && base !== '' ? `${base}${CLAUDE_ONE_M_MARKER}` : base;
}

/** #60 — claude-code's alias tiers, in the panel's display order. */
export const CLAUDE_CODE_TIERS = ['sonnet', 'opus', 'fable', 'haiku'] as const;
export type ClaudeCodeTier = (typeof CLAUDE_CODE_TIERS)[number];

/**
 * #60 — claude-code's own configuration knobs (the per-target panel; ground
 * truth: claude-code 2.1.205 + the official env-vars/model-config docs).
 * ADDITIVE like `modelEntries` above: old daemons' zod parse strips the
 * unknown field, so the wire stays compatible. All knobs land in the
 * settings.json `env` block with revert semantics in the writer — a knob not
 * configured here REMOVES the key we manage; user keys are never touched.
 * NOTE: the capabilities vocabulary is open on purpose (the docs only give
 * `effort,thinking` as an example) — the UI suggests those two but accepts
 * custom tokens.
 */
export const claudeCodeConfigSchema = z.object({
  /** Which env slot carries the key: Bearer (default) vs x-api-key gateways. */
  authField: z.enum(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']).optional(),
  /** Alias-tier pins (`ANTHROPIC_DEFAULT_{TIER}_MODEL` + `_NAME`/`_SUPPORTED_CAPABILITIES`). */
  tiers: z
    .array(
      z.object({
        tier: z.enum(CLAUDE_CODE_TIERS),
        /** May carry the `[1m]` marker. */
        model: z.string().min(1).max(160),
        displayName: z.string().max(160).optional(),
        capabilities: z.array(z.string().min(1).max(32)).max(8).optional(),
      }),
    )
    .max(4)
    .optional(),
  /** `CLAUDE_CODE_SUBAGENT_MODEL` — may carry the `[1m]` marker. */
  subagentModel: z.string().min(1).max(160).optional(),
  /** `CLAUDE_CODE_MAX_OUTPUT_TOKENS` (claude-code default 32k, cap 128k). */
  maxOutputTokens: z.number().int().min(1).max(128000).optional(),
  /**
   * `CLAUDE_CODE_MAX_CONTEXT_TOKENS` — applies directly to non-`claude-`
   * gateway ids; mutually exclusive with the `[1m]` marker (which makes
   * claude-code assume 1M and defers to nothing).
   */
  maxContextTokens: z.number().int().positive().optional(),
  /** `CLAUDE_CODE_EXTRA_BODY` — JSON object merged into every request body. */
  extraBody: z.record(z.string(), z.unknown()).optional(),
});
export type ClaudeCodeConfig = z.infer<typeof claudeCodeConfigSchema>;

export const runtimeConfigSpecSchema = z.object({
  /** Display label only — surfaces in the harness's own config UI. */
  providerLabel: z.string().min(1).max(64),
  /** Omit = the provider's default endpoint (Anthropic / OpenAI proper). */
  baseUrl: z.string().url().max(512).optional(),
  api: providerApiSchema,
  model: z.string().min(1).max(128),
  /** Handle of the distributable credential carrying the API key. */
  credentialName: z.string().min(1).max(64),
  /**
   * W10 — provenance: the LlmProvider row this spec was filled from. The
   * spec stays a SNAPSHOT (a deleted provider never invalidates it); the
   * field only lets the machine form pre-select the provider.
   */
  providerId: z.string().min(1).optional(),
  /**
   * W10 — extra switchable model ids beyond the default `model` (≤16,
   * deduped route-side). Consumers: the dsh + opencode writers (native picker
   * catalogs), the claude-code writer's `availableModels` (9 W13), and the
   * server's `chat:session.start` hint for the daemon-side codex/opencode
   * picker rewrite (9 W13). Codex persists only the single root `model`.
   */
  models: z.array(z.string().min(1).max(128)).max(16).optional(),
  /**
   * #51 — metadata snapshot for `[model, ...models]`, filled from the
   * provider's model registry at PUT time (ids absent from the registry get
   * no entry — bare ids stay honest). ADDITIVE on purpose: old daemons'
   * zod parse strips the unknown field, so the wire stays compatible. The pi
   * writer turns entries into real models.json `contextWindow`/`maxTokens`/
   * `name`; temperature/topP/serverTools/extraBody never leave the server
   * (they are assistant-consumer params, fetched from the provider row).
   */
  modelEntries: z
    .array(
      z.object({
        id: z.string().min(1).max(128),
        displayName: z.string().max(256).optional(),
        contextWindow: z.number().int().positive().optional(),
        maxOutputTokens: z.number().int().positive().optional(),
        vision: z.boolean().optional(),
      }),
    )
    .max(17)
    .optional(),
  /**
   * #60 — claude-code's dedicated panel knobs (see `claudeCodeConfigSchema`).
   * Typed, not under the loose `extra` record: both ends validate the same
   * shape and the field strips cleanly off old daemons.
   */
  claudeCode: claudeCodeConfigSchema.optional(),
  /** Target-specific extras (kept schema-loose on purpose). */
  extra: z.record(z.string(), z.unknown()).optional(),
});
export type RuntimeConfigSpec = z.infer<typeof runtimeConfigSpecSchema>;

/** REST view of a stored runtime config — echoes `credentialName`, never a secret. */
export const runtimeConfigViewSchema = runtimeConfigSpecSchema.extend({
  machineId: z.string().min(1),
  target: runtimeTargetSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type RuntimeConfigView = z.infer<typeof runtimeConfigViewSchema>;

/**
 * The daemon's resolved bundle (`GET /api/client/runtime-config?target=` —
 * machine PAT only). The plaintext exists in this response and in the daemon's
 * memory, nowhere else on the wire.
 */
export const runtimeConfigBundleSchema = z.object({
  target: runtimeTargetSchema,
  spec: runtimeConfigSpecSchema,
  secret: z.string().min(1),
});
export type RuntimeConfigBundle = z.infer<typeof runtimeConfigBundleSchema>;

/**
 * Route-level spec policy (the zod schema is kind-agnostic on purpose, like
 * AVAILABLE_KINDS in the resources route). Returns a rejection reason or null.
 *  - api flavor must be one the target speaks;
 *  - deepseek routes are NOT in the pi-ai catalog — they must name an endpoint.
 */
export function runtimeSpecUnsupportedReason(
  target: RuntimeTarget,
  spec: RuntimeConfigSpec,
): string | null {
  if (!RUNTIME_API_SUPPORT[target].includes(spec.api)) {
    return `target '${target}' cannot speak the '${spec.api}' API (supported: ${RUNTIME_API_SUPPORT[
      target
    ].join(', ')})`;
  }
  if (target === 'deepseek' && spec.baseUrl === undefined) {
    return "deepseek provider routes must set a baseUrl (dsh's route is not in the installed catalog, so it has no default endpoint)";
  }
  // 9 W16 — the pi writer always defines the `harness-nexus` provider entry in
  // models.json; a custom provider with models REQUIRES a baseUrl there.
  if (target === 'pi' && spec.baseUrl === undefined) {
    return 'pi provider routes must set a baseUrl (the writer defines a custom models.json provider, which requires an endpoint)';
  }
  return null;
}
