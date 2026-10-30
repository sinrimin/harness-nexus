// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

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
 * The API kind a wire speaks — FINER-grained than the W3 spec flavor, because
 * the "openai" bucket splits at the wire: codex is Responses-only (codex-rs
 * removed chat), dsh's pi-ai speaks chat completions (`openai-completions`) or
 * Anthropic Messages. `systemone` (#92) is the decision-model protocol (TypeSafe
 * Jev and Bailian's `decision-model-preview` share the wire): never
 * runtime-pushable, never in PROVIDER_API_SUPPORT, and it has NO official
 * default endpoint (baseUrl is required at save). `openai-embedding` (#95)
 * replaces the old reserved `type: 'embedding'` — embeddings ride an
 * openai-compatible `/embeddings` wire; also never runtime-pushable.
 */
export const providerApiKindSchema = z.enum([
  'openai-chat',
  'openai-responses',
  'anthropic',
  'systemone',
  'openai-embedding',
]);
export type ProviderApiKind = z.infer<typeof providerApiKindSchema>;

/** Kinds that are never runtime-pushable (no W3 spec flavor exists). */
export const NON_RUNTIME_KINDS: readonly ProviderApiKind[] = ['systemone', 'openai-embedding'];

/** True for the three chat wires (the assistant / runtime-push candidate set). */
export function isChatApiKind(
  kind: ProviderApiKind,
): kind is Exclude<ProviderApiKind, 'systemone' | 'openai-embedding'> {
  return kind === 'openai-chat' || kind === 'openai-responses' || kind === 'anthropic';
}

/**
 * #95 — one enabled wire on a provider. `path` overrides the kind's default
 * path: `null`/omitted = default; a value starting with `/` is appended to the
 * shared baseUrl; a FULL http(s) URL escapes the baseUrl entirely (wires
 * hosted off a different root, e.g. Bailian's systemone).
 */
export const providerApiPathSchema = z
  .string()
  .max(512)
  .refine((v) => v === '' || v.startsWith('/') || /^https?:\/\//.test(v), {
    message: 'path must start with "/" or be a full http(s) URL',
  });
export const providerApiEndpointSchema = z.object({
  kind: providerApiKindSchema,
  /** Explicit null (or '') = the kind's default path. */
  path: providerApiPathSchema.nullable(),
});
export type ProviderApiEndpointInput = z.input<typeof providerApiEndpointSchema>;
export type ProviderApiEndpoint = z.infer<typeof providerApiEndpointSchema>;

/** The provider's enabled wires — at least one, each kind at most once. */
export const providerApisSchema = z
  .array(providerApiEndpointSchema)
  .min(1)
  .max(5)
  .refine((apis) => new Set(apis.map((a) => a.kind)).size === apis.length, {
    message: 'api kinds must be unique within a provider',
  });

/**
 * #95 — default PATH per kind, appended to the provider's baseUrl. These match
 * what the official SDKs append today, so a stored row with `path: null`
 * behaves byte-identically to pre-#95 rows. `systemone` has no official base
 * (PROVIDER_DEFAULT_BASE_URLS.systemone === ''), so its endpoint is only
 * reachable with an explicit baseUrl or a full-URL path.
 */
export const PROVIDER_DEFAULT_PATHS: Record<ProviderApiKind, string> = {
  'openai-chat': '/chat/completions',
  'openai-responses': '/responses',
  anthropic: '/v1/messages',
  systemone: '/systemone',
  'openai-embedding': '/embeddings',
};

/**
 * #95 — resolve one wire's endpoint URL. `null` when unresolvable (systemone
 * with neither a baseUrl nor a full-URL path). Pure: web previews and the
 * server's outbound surfaces share it.
 */
export function providerEndpointUrl(
  kind: ProviderApiKind,
  input: { baseUrl?: string | null; path?: string | null; defaultBaseUrl?: string },
): string | null {
  const path = input.path ?? null;
  if (path !== null && /^https?:\/\//.test(path)) return path;
  const base = (input.baseUrl ?? input.defaultBaseUrl ?? PROVIDER_DEFAULT_BASE_URLS[kind]).replace(
    /\/+$/,
    '',
  );
  if (base === '') return null;
  const effective = path === null || path === '' ? PROVIDER_DEFAULT_PATHS[kind] : path;
  // A baseUrl that already ENDS with the effective path is the whole
  // endpoint, not a base: dashboards hand out full URLs (Bailian's dedicated
  // `…/compatible-mode/v1/systemone` gets pasted verbatim — appending the
  // default again produced `…/systemone/systemone` and a provider 400).
  if (effective !== '' && base.endsWith(effective)) return base;
  return base + effective;
}

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

/**
 * Map a provider kind onto the W3 spec flavor (writers keyed on it stay
 * untouched). `systemone` and `openai-embedding` have NO spec flavor — they
 * are never runtime-pushable, so reaching those arms is a programming error,
 * not a fallback.
 */
export function providerApiToSpecApi(kind: ProviderApiKind): ProviderApi {
  if (kind === 'systemone' || kind === 'openai-embedding') {
    throw new Error(`${kind} providers are not runtime-pushable`);
  }
  return kind === 'anthropic' ? 'anthropic-messages' : 'openai';
}

/**
 * Official endpoints used when a provider sets no baseUrl. `systemone` has
 * none — every decision-model provider names its endpoint explicitly (the
 * '' sentinel makes the record total; the service refuses the save without a
 * baseUrl, and no default-consuming path is reachable for the kind).
 */
export const PROVIDER_DEFAULT_BASE_URLS: Record<ProviderApiKind, string> = {
  'openai-chat': 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  systemone: '',
  'openai-embedding': 'https://api.openai.com/v1',
};

/**
 * Issue #51 — one CONFIGURED model on a provider row. The registry is the
 * single source of truth: consumers (runtime-config form, the platform
 * assistant) pick from it, they never re-discover. `/v1/models` returns bare
 * ids at best — contextWindow/vision are NOT fetchable, they are curated
 * here. #95 — the model carries its OWN `apiKind` (must be one of the
 * provider's enabled kinds); pickers filter by kind (chat consumers take the
 * three chat wires, the approvals gate takes `systemone`).
 */
export const providerModelConfigSchema = z.object({
  id: z.string().min(1).max(128),
  apiKind: providerApiKindSchema,
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
   * Server-side tool entries, appended VERBATIM as `{type}` into the wire
   * request's tools array (#56 — append, never replace). Meaningful for
   * api='openai-responses' (web_search / web_extractor / code_interpreter …)
   * AND api='anthropic' (the dated `web_search_20250305`); openai-chat has no
   * tools[]-shaped server tools (Bailian's chat-wire search rides extraBody).
   * Deliberately an OPEN string list: the catalog evolves server-side, an
   * enum here would rot — the curated presets live in SERVER_TOOL_PRESETS.
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
 * #56 — curated server-tool presets per api kind, baselined on Alibaba
 * Bailian/Model Studio (2026-10). Open lists: the web combobox offers these
 * AND accepts arbitrary typed values (the gateway-compat escape hatch — a
 * future dated alias, a vendor-specific tool name). The anthropic preset IS
 * the dated wire value; no alias mapping exists anywhere.
 */
export const SERVER_TOOL_PRESETS: Record<ProviderApiKind, readonly string[]> = {
  'openai-chat': [],
  'openai-responses': ['web_search', 'web_extractor', 'code_interpreter'],
  anthropic: ['web_search_20250305'],
  systemone: [],
  'openai-embedding': [],
};

/**
 * #56 — curated extraBody KEY presets per api kind (same Bailian baseline).
 * On the openai-chat wire this field is the primary carrier for
 * Bailian-style search (`enable_search` + `search_options`), not merely an
 * escape hatch.
 */
export const EXTRA_BODY_PRESETS: Record<ProviderApiKind, readonly string[]> = {
  'openai-chat': ['enable_search', 'search_options', 'enable_text_image_mixed', 'enable_thinking'],
  'openai-responses': ['enable_thinking'],
  anthropic: [],
  systemone: [],
  'openai-embedding': [],
};

/**
 * #56 — extraBody keys whose Bailian value is a plain boolean; the web
 * value editor renders these as toggles (everything else gets a JSON input).
 */
export const EXTRA_BODY_BOOLEAN_KEYS: ReadonlySet<string> = new Set([
  'enable_search',
  'enable_text_image_mixed',
  'enable_thinking',
]);

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
 * shared code. Structured `{ code, modelId }` (not prose) so the renderer
 * can translate — the machine reads the code, the human gets their locale.
 * #95 — the gate is the MODEL's own apiKind (the provider speaks several).
 */
export type ProviderModelConfigWarningCode = 'serverToolsIrrelevant' | 'extraBodyIrrelevant';

export interface ProviderModelConfigWarning {
  code: ProviderModelConfigWarningCode;
  modelId: string;
}

export function providerModelConfigWarnings(
  models: readonly ProviderModelConfig[],
): ProviderModelConfigWarning[] {
  const warnings: ProviderModelConfigWarning[] = [];
  for (const m of models) {
    const kind = m.apiKind;
    // #56 — serverTools ride BOTH openai-responses and anthropic wires
    // (append-injection); the other kinds have no tools[] surface.
    if (m.serverTools !== undefined && kind !== 'openai-responses' && kind !== 'anthropic') {
      warnings.push({ code: 'serverToolsIrrelevant', modelId: m.id });
    }
    if (m.extraBody !== undefined && (kind === 'anthropic' || kind === 'systemone')) {
      warnings.push({ code: 'extraBodyIrrelevant', modelId: m.id });
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
  // #92 — SystemOne has NO models-list endpoint; discovery is never offered
  // for the kind (the model id is curated by hand in the registry).
  if (api === 'systemone') return [];
  const base = (baseUrl ?? PROVIDER_DEFAULT_BASE_URLS[api]).replace(/\/+$/, '');
  if (api === 'anthropic') return [`${base}/v1/models?limit=1000`];
  // openai-chat / openai-responses / openai-embedding share the /models listing
  return base.endsWith('/v1') ? [`${base}/models`] : [`${base}/v1/models`, `${base}/models`];
}

export const llmProviderCreateSchema = z.object({
  name: z.string().min(1).max(64),
  /** #95 — the enabled wires (>=1, kinds unique); models must pick from them. */
  apis: providerApisSchema,
  /** Omit = each kind's official endpoint. */
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
    apis: providerApisSchema.optional(),
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
  apis: providerApisSchema,
  baseUrl: z.string().url().max(512).nullable(),
  credentialName: z.string().min(1).max(64),
  scope: z.enum(['global', 'personal']),
  ownerId: z.string().nullable(),
  models: providerModelsSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type LlmProviderView = z.infer<typeof llmProviderViewSchema>;

/**
 * #95 — one user-level default-model slot. `embedding`/`rerank` are reserved
 * (no consumer yet; the UI shows them disabled); `decision` feeds delegated
 * approvals (#92) when a machine's chatApprovals omits its own provider/model.
 */
export const defaultModelRefSchema = z.object({
  providerId: z.string().min(1).max(64),
  modelId: z.string().min(1).max(128),
});
export type DefaultModelRefInput = z.input<typeof defaultModelRefSchema>;
export type DefaultModelRef = z.infer<typeof defaultModelRefSchema>;

/** Full-replace PATCH body / stored shape — an empty object clears every slot. */
export const userDefaultModelsSchema = z.object({
  embedding: defaultModelRefSchema.optional(),
  rerank: defaultModelRefSchema.optional(),
  decision: defaultModelRefSchema.optional(),
});
export type UserDefaultModelsInput = z.input<typeof userDefaultModelsSchema>;
export type UserDefaultModels = z.infer<typeof userDefaultModelsSchema>;

/**
 * #100 — one default-model slot's DERIVED capability state (never stored):
 * `configured` re-validates the stored ref against the live provider
 * registry; `health` merges the decision-model circuit breaker (degraded
 * while it holds, with the epoch-ms `degradedUntil`, the last error and the
 * consecutive-failure count). Reserved slots report `ok` while unused.
 */
export const modelCapabilityStateSchema = z.object({
  configured: z.boolean(),
  health: z.enum(['ok', 'degraded']),
  degradedUntil: z.number().int().nonnegative().optional(),
  lastError: z.string().max(512).optional(),
  consecutiveFailures: z.number().int().nonnegative().optional(),
});
export type ModelCapabilityState = z.infer<typeof modelCapabilityStateSchema>;

/** The per-owner capability view — rides `GET /api/users/me/default-models`. */
export const modelCapabilitiesViewSchema = z.object({
  decision: modelCapabilityStateSchema,
  embedding: modelCapabilityStateSchema,
  rerank: modelCapabilityStateSchema,
});
export type ModelCapabilitiesView = z.infer<typeof modelCapabilitiesViewSchema>;

export const modelCapabilitySlotSchema = z.enum(['decision', 'embedding', 'rerank']);
export type ModelCapabilitySlot = z.infer<typeof modelCapabilitySlotSchema>;

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
