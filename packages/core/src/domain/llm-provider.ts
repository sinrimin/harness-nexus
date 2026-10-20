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

/** Finer-grained than the W3 spec flavor: codex is Responses-only, dsh speaks chat. */
export type LlmProviderApi = 'openai-chat' | 'openai-responses' | 'anthropic';

/**
 * Issue #51 — one CONFIGURED model on a provider row (the registry). The
 * regular fields feed every consumer's metadata (pi models.json on machines,
 * the assistant's in-process pi-ai Model); the advanced fields are
 * provider-level policy applied per consumer capability (the assistant uses
 * them all; machine pushes only carry the metadata subset). `type:
 * 'embedding'` is reserved — no consumer yet, pickers filter to 'chat'.
 */
export interface ProviderModelConfig {
  id: string;
  type: 'chat' | 'embedding';
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
  api: LlmProviderApi;
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
