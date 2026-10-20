// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import {
  providerModelsUrls,
  type LlmModelInfo,
  type ProviderApiKind,
  PROVIDER_MODELS_MAX,
} from '@harness-nexus/shared';

/**
 * Server-side model-list discovery (Phase 9 W10) — the cc-switch 获取模型
 * button. The browser CANNOT do this itself: the credential plaintext exists
 * only server-side (and gateways rarely allow cross-origin reads anyway).
 *
 * This is the platform's SECOND deliberate outbound HTTP surface (the
 * marketplace fetch is the first, the MCP registry's dialing third in
 * spirit). Bounds: GET only, http(s) only, a hard timeout, a 2 MiB response
 * cap, and results reduced to model ids + display names.
 */

export interface ProviderModelsInput {
  api: ProviderApiKind;
  /** Omit = the kind's official endpoint. */
  baseUrl?: string;
  apiKey: string;
}

export interface ProviderModelsOptions {
  /** Injectable for tests — never touch the network there. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Route-mappable failure (mirrors the registry's RegistryError stance — no HTTP here). */
export class ProviderModelsError extends Error {
  constructor(
    public readonly kind: 'failed' | 'timeout',
    message: string,
  ) {
    super(message);
    this.name = 'ProviderModelsError';
  }
}

function headersFor(api: ProviderApiKind, apiKey: string): Record<string, string> {
  return api === 'anthropic'
    ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    : { authorization: `Bearer ${apiKey}` };
}

interface RawModelEntry {
  id?: unknown;
  display_name?: unknown;
  name?: unknown;
}

/** Parse `{data: [...]}` (or a bare array, a common gateway quirk) into model infos. */
export function parseProviderModels(body: string): LlmModelInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new ProviderModelsError('failed', 'provider models response was not JSON');
  }
  const entries: RawModelEntry[] = Array.isArray(parsed)
    ? (parsed as RawModelEntry[])
    : Array.isArray((parsed as { data?: unknown }).data)
      ? (parsed as { data: RawModelEntry[] }).data
      : [];
  const seen = new Set<string>();
  const models: LlmModelInfo[] = [];
  for (const e of entries) {
    if (typeof e?.id !== 'string' || e.id.length === 0 || e.id.length > 256) continue;
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const display = typeof e.display_name === 'string' ? e.display_name : undefined;
    const altName = typeof e.name === 'string' ? e.name : undefined;
    const name = display ?? altName;
    models.push({ id: e.id, ...(name !== undefined && name !== e.id ? { name } : {}) });
    if (models.length >= PROVIDER_MODELS_MAX) break;
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

/** Fetch the provider's model list. Throws `ProviderModelsError` on failure. */
export async function fetchProviderModels(
  input: ProviderModelsInput,
  options: ProviderModelsOptions = {},
): Promise<LlmModelInfo[]> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const candidates = providerModelsUrls(input.api, input.baseUrl);
  const headers = headersFor(input.api, input.apiKey);

  let lastStatus = 0;
  for (const url of candidates) {
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'GET',
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new ProviderModelsError('timeout', `model list fetch timed out after ${timeoutMs}ms`);
      }
      throw new ProviderModelsError('failed', `model list fetch failed: ${(err as Error).message}`);
    }
    // A 404 on the FIRST candidate just advances to the next URL shape; the
    // last candidate's status is the reported one.
    lastStatus = res.status;
    if (res.status === 404 && url !== candidates[candidates.length - 1]) continue;
    if (!res.ok) {
      throw new ProviderModelsError(
        'failed',
        `model list endpoint answered ${res.status} (${safeHost(url)})`,
      );
    }
    const body = (await res.text()).slice(0, MAX_BODY_BYTES);
    return parseProviderModels(body);
  }
  throw new ProviderModelsError('failed', `model list endpoint answered ${lastStatus}`);
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'provider';
  }
}
