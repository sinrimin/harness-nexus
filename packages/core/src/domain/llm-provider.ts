// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * Phase 9 W10 — a reusable LLM route (cc-switch-style provider catalog).
 * The provider is the ROUTE, never the secret: the API key lives in the
 * encrypted Credential store and is referenced by name, so the W3 apply path
 * (distributable credential → machine-PAT bundle) is reused verbatim.
 * See wiki design-phase-9-w10-llm-providers.md + design-provider-model-registry.md.
 */

/**
 * Finer-grained than the W3 spec flavor: codex is Responses-only, dsh speaks
 * chat. `systemone` (#92) is NOT a chat wire at all — it is the decision-model
 * protocol (TypeSafe Jev / Bailian `decision-model-preview` share it), consumed
 * ONLY by delegated approvals; it is never runtime-pushable and has no official
 * default endpoint (baseUrl is required). #95 — one provider speaks SEVERAL
 * kinds at once (Bailian serves every wire off one credential), so the kind
 * moved off the provider row onto the endpoint entry and the MODEL;
 * `openai-embedding` replaces the old reserved `type: 'embedding'`.
 */
export type LlmProviderApi =
  'openai-chat' | 'openai-responses' | 'anthropic' | 'systemone' | 'openai-embedding';

/**
 * #95 — one enabled protocol on a provider. `path` overrides the kind's
 * default path (`null` = default); a full http(s) URL escapes the shared
 * baseUrl for wires hosted off a different root (Bailian's systemone lives
 * off the compatible-mode root).
 */
export interface ProviderApiEndpoint {
  kind: LlmProviderApi;
  path: string | null;
}

/**
 * Issue #51 — one CONFIGURED model on a provider row (the registry). The
 * regular fields feed every consumer's metadata (pi models.json on machines,
 * the assistant's in-process pi-ai Model); the advanced fields are
 * provider-level policy applied per consumer capability (the assistant uses
 * them all; machine pushes only carry the metadata subset). #95 — the model
 * carries its OWN apiKind (one of the provider's enabled kinds); the chat-only
 * fields are meaningless on `systemone` / `openai-embedding` models and are
 * hidden by their editors.
 */
export interface ProviderModelConfig {
  id: string;
  apiKind: LlmProviderApi;
  displayName?: string | undefined;
  /** Context window in tokens. */
  contextWindow?: number | undefined;
  maxOutputTokens?: number | undefined;
  vision?: boolean | undefined;
  // —— advanced ——
  temperature?: number | undefined;
  topP?: number | undefined;
  /**
   * Server-side tool types appended verbatim into the wire request's tools
   * array (#56). Meaningful on openai-responses and anthropic (the dated
   * `web_search_20250305`); openai-chat has no tools[] surface.
   */
  serverTools?: string[] | undefined;
  /** openai-compatible only: merged verbatim into the request body. */
  extraBody?: Record<string, unknown> | undefined;
}

export interface LlmProvider {
  id: string;
  name: string;
  /** #95 — the enabled wires + per-kind path overrides (never empty). */
  apis: ProviderApiEndpoint[];
  /** null = the kind's official endpoint (Anthropic / OpenAI proper). */
  baseUrl: string | null;
  /** Handle of the Credential carrying the API key (not an id — like RuntimeConfig). */
  credentialName: string;
  scope: 'global' | 'personal';
  /** null iff scope === 'global'; otherwise the owning user id. */
  ownerId: string | null;
  /** #51 — the configured model registry (rows written before the feature read as []). */
  models: ProviderModelConfig[];
  createdAt: string;
  updatedAt: string;
}
