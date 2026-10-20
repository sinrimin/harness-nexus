// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

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
  /**
   * Behavior switches (#60) — checked writes the managed key, unchecked
   * removes it (claude-code's own default). Ground truth: the 2.1.205 binary
   * + cc-switch's live writer. `attribution` is the settings-object form (the
   * successor of the deprecated `includeCoAuthoredBy`); the rest are env
   * vars, several deliberately UNPREFIXED (that is their documented spelling).
   */
  switches: z
    .object({
      /** settings `attribution = {commit:'', pr:'', sessionUrl:false}` */
      attributionHidden: z.boolean().optional(),
      /** env CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 */
      teammates: z.boolean().optional(),
      /** env ENABLE_TOOL_SEARCH=true (unprefixed on purpose) */
      toolSearch: z.boolean().optional(),
      /** env CLAUDE_CODE_EFFORT_LEVEL=max (the top of low..max) */
      maxEffort: z.boolean().optional(),
      /** env DISABLE_AUTOUPDATER=1 (unprefixed on purpose) */
      autoUpgradeDisabled: z.boolean().optional(),
      /** env CLAUDE_CODE_DISABLE_ARTIFACT=1 */
      artifactsDisabled: z.boolean().optional(),
    })
    .optional(),
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

/**
 * #62 — opencode's dedicated panel knobs. Ground truth: research §3.3
 * (opencode 1.18.31 schema, rig-verified) + the official config docs.
 * Per-model detail rides the SAME entry map the writer already owns
 * (`provider['harness-nexus'].models.<id>`); precedence per field is
 * panel value > #51 modelEntries seed > conservative fallback — `limit.*`
 * are REQUIRED by opencode's schema, so an unset field means the seed or
 * fallback, never a deleted key. `small_model`/`autoupdate` are top-level
 * keys with BASE_URL-style ownership (configured → write, cleared → remove
 * ours).
 */
export const opencodeModelDetailSchema = z.object({
  /** `name` — display name in opencode's model picker. */
  name: z.string().max(256).optional(),
  /** `limit.context` — informational: context-remaining UI + auto-compaction. */
  contextWindow: z.number().int().positive().optional(),
  /** `limit.output` — a real request cap; opencode clamps globally to 32k. */
  maxOutputTokens: z.number().int().positive().optional(),
  /** `reasoning: true` — capability declaration. */
  reasoning: z.boolean().optional(),
  /**
   * `temperature: true` — BOOLEAN GATE on the model entry (the sampling VALUE
   * lives per-agent in opencode and is out of scope): only when true does
   * opencode send an agent's temperature at all.
   */
  temperatureEnabled: z.boolean().optional(),
  /** `attachment: true` — vision capability. */
  vision: z.boolean().optional(),
  /**
   * `options` — model-level body keys, merged into the providerOptions
   * namespace and spread verbatim on the openai-compatible wire ONLY (no
   * passthrough on the anthropic flavor).
   */
  options: z.record(z.string(), z.unknown()).optional(),
});
export type OpencodeModelDetail = z.infer<typeof opencodeModelDetailSchema>;

export const opencodeConfigSchema = z.object({
  /** Per-model detail, keyed against the switchable set (default + extras). */
  models: z
    .array(opencodeModelDetailSchema.extend({ id: z.string().min(1).max(128) }))
    .max(17)
    .optional(),
  /**
   * Top-level `small_model` — opencode's background model for lightweight
   * tasks (title generation etc.). Stored as the BARE id; the writer prefixes
   * `harness-nexus/`.
   */
  smallModel: z.string().min(1).max(128).optional(),
  /**
   * Top-level `autoupdate: false`. Docs caveat: may not apply to
   * package-manager installs (incl. npm — our channel); the panel hints it.
   */
  autoupdateDisabled: z.boolean().optional(),
});
export type OpencodeConfig = z.infer<typeof opencodeConfigSchema>;

/**
 * #63 — codex's dedicated panel knobs. Ground truth: codex-cli 0.154.0 on the
 * rig (root keys verified in `config/src/config_toml.rs` at that tag) + the
 * official config reference. Every knob is a TOP-LEVEL `~/.codex/config.toml`
 * key (single global value per install) with the claude-code revert semantic:
 * configured → the writer writes ours, unset → the writer REMOVES ours (the
 * one layered exception: `contextWindow` falls back to the #51 `modelEntries`
 * seed of the default model before removing).
 *
 * Explicitly NOT here (source-verified dead or missing at 0.154.0):
 * `model_max_output_tokens` (key never existed), `disable_response_storage`
 * (removed from codex — cc-switch still writes the dead key), temperature /
 * top_p / arbitrary body merge (no surface), `model_catalog_json` (the
 * catalog replaces codex's model metadata INCLUDING the system-prompt
 * instructions template — owning it means owning the prompt; stays a research
 * design question).
 */
/** #63 — `model_reasoning_effort` (docs: minimal–xhigh, xhigh model-dependent). */
export const CODEX_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

/** #63 — `model_reasoning_summary` (auto is codex's default). */
export const CODEX_REASONING_SUMMARIES = ['auto', 'concise', 'detailed', 'none'] as const;
export type CodexReasoningSummary = (typeof CODEX_REASONING_SUMMARIES)[number];

/** #63 — `model_verbosity`. */
export const CODEX_VERBOSITIES = ['low', 'medium', 'high'] as const;
export type CodexVerbosity = (typeof CODEX_VERBOSITIES)[number];

export const codexConfigSchema = z.object({
  reasoningEffort: z.enum(CODEX_REASONING_EFFORTS).optional(),
  reasoningSummary: z.enum(CODEX_REASONING_SUMMARIES).optional(),
  verbosity: z.enum(CODEX_VERBOSITIES).optional(),
  /**
   * `model_context_window` — overrides the catalog's window (single global
   * value; codex assumes 272k for slugs it does not know). Writer precedence:
   * this value > the #51 seed of the default model > key removed.
   */
  contextWindow: z.number().int().positive().max(10_000_000).optional(),
  /** `model_auto_compact_token_limit` — unset uses the model's default. */
  autoCompactTokenLimit: z.number().int().positive().max(10_000_000).optional(),
  switches: z
    .object({
      /** `check_for_update_on_startup = false` while switched on. */
      updateCheckDisabled: z.boolean().optional(),
    })
    .optional(),
});
export type CodexConfig = z.infer<typeof codexConfigSchema>;

/**
 * #64 — dsh's dedicated panel knobs. Ground truth: dsh 0.2.0-rc.2 on the rig
 * (the `llm-pi-ai` plugin's `PiAiModelProfile`, typings re-verified 2026-10-17
 * — same shape the research §3.5 baseline recorded). dsh's per-model surface
 * is the detail below ONLY: the `reasoningEfforts` dict and the route-level
 * `reasoning` dial need per-gateway wire spellings we cannot guess (v1
 * follow-ups), `compat` is wire machinery dsh's own UI gates, and NO sampling
 * knobs exist anywhere in dsh's settings schema — so there is no behavior
 * section; the panel is honestly thin. Writer precedence per field is the
 * opencode contract: panel value > #51 modelEntries seed > key OMITTED (the
 * route's own defaults 262,144/32,768 apply — the pi-writer stance, never a
 * guessed value). A configured `maxTokens` additionally becomes that model's
 * per-request default (a catalog/fallback-inherited one does not).
 */
export const deepseekModelDetailSchema = z.object({
  /** `name` — display name for dsh's model selectors. */
  name: z.string().max(256).optional(),
  /** `contextWindow` — maximum combined request+response context. */
  contextWindow: z.number().int().positive().optional(),
  /** `maxTokens` — max output tokens; configured ⇒ also the per-request default. */
  maxOutputTokens: z.number().int().positive().optional(),
  /** `input: ["text","image"]` while true; absent stays text (no catalog entry to inherit for unknown ids). */
  vision: z.boolean().optional(),
});
export type DeepseekModelDetail = z.infer<typeof deepseekModelDetailSchema>;

export const deepseekConfigSchema = z.object({
  /** Per-model detail, keyed against the switchable set (default + extras). */
  models: z
    .array(deepseekModelDetailSchema.extend({ id: z.string().min(1).max(128) }))
    .max(17)
    .optional(),
});
export type DeepseekConfig = z.infer<typeof deepseekConfigSchema>;

/**
 * #65 — pi's dedicated panel knobs. Ground truth: pi-coding-agent 0.85.1 on
 * the rig (`ModelDefinitionSchema` in core/model-config.js, re-verified
 * 2026-10-17). The W16 writer already lands name/contextWindow/maxTokens/
 * input from the #51 `modelEntries` seed; the panel overlays per field
 * (panel value > seed > omitted — the family contract) and adds pi's OWN
 * knob vocabulary: `reasoning` (a simple BOOLEAN capability declaration)
 * and `samplingParams` (free `Record<string, unknown>` — pi-ai merges
 * `{...model.samplingParams, ...byLevel[level], ...requestParams}`).
 * samplingParams is effective on the openai wires and silently ignored on
 * anthropic (the registry's documented warn-not-reject stance);
 * `serverTools` deliberately does NOT ride `samplingParams.tools` (the
 * research §4.2 clobber risk). OUT of v1 (same class as dsh's wire-dict
 * gaps): thinkingLevelMap, samplingParamsByThinkingLevel, cost, headers,
 * compat.
 */
export const piModelDetailSchema = z.object({
  /** `name` — display name in pi's model picker. */
  name: z.string().max(256).optional(),
  /** `contextWindow` — context size pi assumes for the model. */
  contextWindow: z.number().int().positive().optional(),
  /** `maxTokens` — max output tokens. */
  maxOutputTokens: z.number().int().positive().optional(),
  /** `input: ["text","image"]` while true; absent stays pi's text default. */
  vision: z.boolean().optional(),
  /** `reasoning: true` — thinking-capability declaration (panel-only). */
  reasoning: z.boolean().optional(),
  /** `samplingParams` — free request-body keys, openai wires only. */
  samplingParams: z.record(z.string(), z.unknown()).optional(),
});
export type PiModelDetail = z.infer<typeof piModelDetailSchema>;

export const piConfigSchema = z.object({
  /** Per-model detail, keyed against the switchable set (default + extras). */
  models: z
    .array(piModelDetailSchema.extend({ id: z.string().min(1).max(128) }))
    .max(17)
    .optional(),
});
export type PiConfig = z.infer<typeof piConfigSchema>;

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
  /**
   * #62 — opencode's dedicated panel knobs (see `opencodeConfigSchema`),
   * same additive contract as `claudeCode`.
   */
  opencode: opencodeConfigSchema.optional(),
  /**
   * #63 — codex's dedicated panel knobs (see `codexConfigSchema`),
   * same additive contract as `claudeCode`/`opencode`.
   */
  codex: codexConfigSchema.optional(),
  /**
   * #64 — dsh's dedicated panel knobs (see `deepseekConfigSchema`),
   * same additive contract as the panels above.
   */
  deepseek: deepseekConfigSchema.optional(),
  /**
   * #65 — pi's dedicated panel knobs (see `piConfigSchema`),
   * same additive contract as the panels above.
   */
  pi: piConfigSchema.optional(),
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
