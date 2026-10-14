import { z } from 'zod';
import type { RuntimeTarget } from './inventory.js';
import type { ProviderApi } from './runtime-config.js';

/**
 * LLM provider management (Phase 9 W10) — cc-switch-style reusable provider
 * routes for the W3 provider-config push. The provider is the ROUTE, never
 * the secret: the API key lives in the Credential store, referenced by name.
 * See wiki design-phase-9-w10-llm-providers.md.
 */

/**
 * The API kind the provider endpoint speaks — FINER-grained than the W3 spec
 * flavor, because the "openai" bucket splits at the wire: codex is
 * Responses-only (codex-rs removed chat), dsh's pi-ai speaks chat
 * completions (`openai-completions`) or Anthropic Messages.
 */
export const providerApiKindSchema = z.enum(['openai-chat', 'openai-responses', 'anthropic']);
export type ProviderApiKind = z.infer<typeof providerApiKindSchema>;

/**
 * Which provider api kinds each runtime target can be pointed at (machine
 * page filter + design §3.2):
 *   claude-code — Anthropic Messages only;
 *   codex       — Responses only;
 *   deepseek    — pi-ai KnownApi is anthropic-messages | openai-completions.
 */
export const PROVIDER_API_SUPPORT: Record<RuntimeTarget, readonly ProviderApiKind[]> = {
  'claude-code': ['anthropic'],
  codex: ['openai-responses'],
  deepseek: ['anthropic', 'openai-chat'],
  // 9 W12 — opencode's provider `npm` key: anthropic → @ai-sdk/anthropic,
  // openai-chat → @ai-sdk/openai-compatible. openai-responses is DELIBERATELY
  // excluded: the W3 spec snapshot carries only the coarse flavor
  // (anthropic-messages | openai), so the writer could not pick between
  // @ai-sdk/openai and @ai-sdk/openai-compatible deterministically — the
  // models.dev built-in 'openai' provider already covers OpenAI proper.
  opencode: ['anthropic', 'openai-chat'],
  // 9 W16 — pi's models.json `api` enum natively names all three wires
  // (anthropic-messages / openai-completions / openai-responses) — the FIRST
  // target with the full set; no flavor had to be excluded for writer
  // ambiguity. Unlike opencode above, the coarse 'openai' flavor still cannot
  // distinguish chat vs responses, so pi ALSO honors openai-responses only
  // when the fine kind is present (see applyPiConfig's mapping).
  pi: ['anthropic', 'openai-chat', 'openai-responses'],
};

/** Map a provider kind onto the W3 spec flavor (writers keyed on it stay untouched). */
export function providerApiToSpecApi(kind: ProviderApiKind): ProviderApi {
  return kind === 'anthropic' ? 'anthropic-messages' : 'openai';
}

/** Official endpoints used when a provider sets no baseUrl. */
export const PROVIDER_DEFAULT_BASE_URLS: Record<ProviderApiKind, string> = {
  'openai-chat': 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
};

/**
 * Issue #51 — one CONFIGURED model on a provider row. The registry is the
 * single source of truth: consumers (runtime-config form, the platform
 * assistant) pick from it, they never re-discover. `/v1/models` returns bare
 * ids at best — contextWindow/vision are NOT fetchable, they are curated
 * here. `type: 'embedding'` is RESERVED (pickers filter to 'chat'; no
 * consumer surface yet).
 */
export const providerModelTypeSchema = z.enum(['chat', 'embedding']);
export type ProviderModelType = z.infer<typeof providerModelTypeSchema>;

export const providerModelConfigSchema = z.object({
  id: z.string().min(1).max(128),
  type: providerModelTypeSchema.default('chat'),
  /** Display name → pi models.json `name`. */
  displayName: z.string().max(256).optional(),
  /** Context window in tokens → pi models.json `contextWindow`. */
  contextWindow: z.number().int().positive().max(10_000_000).optional(),
  /** Max output tokens → pi models.json `maxTokens`. */
  maxOutputTokens: z.number().int().positive().max(10_000_000).optional(),
  vision: z.boolean().optional(),
  // —— advanced: provider-level policy, applied per CONSUMER capability ——

  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  /**
   * ONLY meaningful for api='openai-responses' — the Responses API's
   * server-side tools (web_search / file_search / code_interpreter /
   * image_generation / mcp …). Deliberately an OPEN string list: the catalog
   * evolves server-side, an enum here would rot.
   */
  serverTools: z.array(z.string().min(1).max(64)).max(16).optional(),
  /**
   * ONLY meaningful for openai-compatible apis — merged verbatim into the
   * request body (gateway compat knobs: reasoning effort slots, forced
   * formats, vendor extras…).
   */
  extraBody: z.record(z.string(), z.unknown()).optional(),
});
export type ProviderModelConfigInput = z.input<typeof providerModelConfigSchema>;
export type ProviderModelConfig = z.infer<typeof providerModelConfigSchema>;

/**
 * A provider's model registry — ids unique within the row (refine gives the
 * route a 400 with a pointed message; the web dialog blocks dupes client-side
 * too, the refine covers direct API callers).
 */
export const providerModelsSchema = z
  .array(providerModelConfigSchema)
  .max(64)
  .refine((models) => new Set(models.map((m) => m.id)).size === models.length, {
    message: 'model ids must be unique within a provider',
  });

/**
 * Api-irrelevant combos WARN, never reject — gateway compat layers routinely
 * bend the rules (an openai-compatible gateway behind an 'anthropic' kind,
 * etc.). Pure: the web dialog computes these client-side from the same
 * shared code.
 */
export function providerModelConfigWarnings(
  api: ProviderApiKind,
  models: readonly ProviderModelConfig[],
): string[] {
  const warnings: string[] = [];
  for (const m of models) {
    if (m.serverTools !== undefined && api !== 'openai-responses') {
      warnings.push(`model "${m.id}": serverTools only applies to openai-responses providers`);
    }
    if (m.extraBody !== undefined && api === 'anthropic') {
      warnings.push(`model "${m.id}": extraBody only applies to openai-compatible providers`);
    }
  }
  return warnings;
}

/**
 * Candidate models-list URLs for a kind + base, in try order (pure — unit
 * tested without I/O). cc-switch semantics: request the endpoint's
 * `/v1/models`. Gateways exist in both shapes, so an openai base without a
 * trailing `/v1` tries `{base}/v1/models` first, then bare `{base}/models`;
 * Anthropic's listing lives at `{base}/v1/models`.
 */
export function providerModelsUrls(api: ProviderApiKind, baseUrl?: string): string[] {
  const base = (baseUrl ?? PROVIDER_DEFAULT_BASE_URLS[api]).replace(/\/+$/, '');
  if (api === 'anthropic') return [`${base}/v1/models?limit=1000`];
  return base.endsWith('/v1') ? [`${base}/models`] : [`${base}/v1/models`, `${base}/models`];
}

export const llmProviderCreateSchema = z.object({
  name: z.string().min(1).max(64),
  api: providerApiKindSchema,
  /** Omit = the kind's official endpoint. */
  baseUrl: z.string().url().max(512).optional(),
  /** Handle of the Credential carrying the API key. */
  credentialName: z.string().min(1).max(64),
  scope: z.enum(['global', 'personal']).default('personal'),
  /** #51 — the configured model registry (full replace; omit = empty). */
  models: providerModelsSchema.default([]),
});
export type LlmProviderCreateInput = z.input<typeof llmProviderCreateSchema>;

/**
 * PATCH body — `scope` is deliberately absent (immutable, like a resource's
 * kind/scope); `baseUrl: null` clears the override. Mutate-by-recreate to
 * re-scope. `models` is a full replace.
 */
export const llmProviderUpdateSchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    api: providerApiKindSchema.optional(),
    baseUrl: z.string().url().max(512).nullable().optional(),
    credentialName: z.string().min(1).max(64).optional(),
    models: providerModelsSchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'empty update' });
export type LlmProviderUpdateInput = z.input<typeof llmProviderUpdateSchema>;

/** REST view — echoes `credentialName`, never a secret. */
export const llmProviderViewSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(64),
  api: providerApiKindSchema,
  baseUrl: z.string().url().max(512).nullable(),
  credentialName: z.string().min(1).max(64),
  scope: z.enum(['global', 'personal']),
  ownerId: z.string().nullable(),
  models: providerModelsSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type LlmProviderView = z.infer<typeof llmProviderViewSchema>;

/** One discovered model id (cc-switch 获取模型). `name` is the display name when the endpoint offers one. */
export const llmModelInfoSchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().max(256).optional(),
});
export type LlmModelInfo = z.infer<typeof llmModelInfoSchema>;

export const PROVIDER_MODELS_MAX = 1000;

/**
 * Query body for model-list discovery: `{providerId}` (a stored row) OR
 * explicit `{api, baseUrl?, credentialName}` — the explicit arm serves the
 * create dialog and the machine page's manual mode BEFORE anything is saved.
 */
export const providerModelsQuerySchema = z
  .object({
    providerId: z.string().min(1).optional(),
    api: providerApiKindSchema.optional(),
    baseUrl: z.string().url().max(512).optional(),
    credentialName: z.string().min(1).max(64).optional(),
  })
  .refine(
    (v) => v.providerId !== undefined || (v.api !== undefined && v.credentialName !== undefined),
    { message: 'either providerId, or api + credentialName, is required' },
  );
export type ProviderModelsQueryInput = z.input<typeof providerModelsQuerySchema>;

export const providerModelsResultSchema = z.object({
  models: z.array(llmModelInfoSchema).max(PROVIDER_MODELS_MAX),
});
export type ProviderModelsResult = z.infer<typeof providerModelsResultSchema>;
