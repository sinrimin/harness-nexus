// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * #92 — the SystemOne decision-model call (TypeSafe Jev / Bailian
 * `decision-model-preview` share the wire). The platform's THIRD deliberate
 * outbound HTTP surface (after marketplace-fetch and the provider
 * query-models caller): POST-only, https-only, one bounded body, a hard
 * timeout — every failure mode maps to "uncertain" at the gate, never to a
 * decision. See wiki design-delegated-approvals.md.
 */

/** The typed questions of one call. `criteria` maps/lists option semantics. */
export interface SystemOneQuestion {
  type: 'choice' | 'noul' | 'score';
  instructions: string;
  /** choice: option name → description. score: 1..N level descriptions. */
  criteria?: Record<string, string> | string[];
}

export interface SystemOneCall {
  /** #95 — the RESOLVED endpoint URL (baseUrl + systemone path). */
  url: string;
  apiKey: string;
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, SystemOneQuestion>;
}

export interface SystemOneAnswer {
  /** Present for choice questions. */
  choice?: string;
  /** Present for noul questions (probability of yes, 0..1). */
  noul?: number;
  /** Present for score questions (probability-weighted value). */
  score?: number;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export type SystemOneResult = { answers: Record<string, SystemOneAnswer> };

export type SystemOneError =
  | { kind: 'timeout' }
  | { kind: 'http'; status: number; body: string }
  | { kind: 'shape'; message: string }
  | { kind: 'insecure-url' };

/** Injectable for tests; production uses the global fetch. */
export type SystemOneFetch = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

const defaultFetch: SystemOneFetch = (url, init) =>
  fetch(url, init) as unknown as Promise<{
    ok: boolean;
    status: number;
    text: () => Promise<string>;
  }>;

/** The bounded state body cap — context hygiene is enforced by the CALLER
 * (the gate never puts file bodies or tool outputs in); this is the belt. */
const STATE_JSON_CAP = 48_000;

export async function callSystemOne(
  call: SystemOneCall,
  opts: { timeoutMs: number; fetchImpl?: SystemOneFetch },
): Promise<SystemOneResult> {
  const url = call.url;
  if (!url.startsWith('https://')) {
    return Promise.reject({ kind: 'insecure-url' } as SystemOneError);
  }
  const body = JSON.stringify({
    model: call.model,
    state: call.state,
    questions: call.questions,
  });
  if (body.length > STATE_JSON_CAP) {
    return Promise.reject({ kind: 'shape', message: 'state body too large' } as SystemOneError);
  }
  const doFetch = opts.fetchImpl ?? defaultFetch;
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(), opts.timeoutMs);
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${call.apiKey}`,
      },
      body,
      signal: timer.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return Promise.reject({
        kind: 'http',
        status: res.status,
        body: text.slice(0, 512),
      } as SystemOneError);
    }
    const parsed: unknown = JSON.parse(text);
    const answers = (parsed as { answers?: unknown }).answers;
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      typeof answers !== 'object' ||
      answers === null
    ) {
      return Promise.reject({ kind: 'shape', message: 'missing answers' } as SystemOneError);
    }
    return { answers: answers as Record<string, SystemOneAnswer> };
  } catch (e) {
    if (e !== null && typeof e === 'object' && 'kind' in e) {
      return Promise.reject(e);
    }
    // AbortError (our timeout) and network errors both read as timeout-ish
    // "uncertain" at the gate; keep them distinguishable in the log shape.
    const aborted = e instanceof Error && e.name === 'AbortError';
    return Promise.reject({ kind: 'timeout', ...(aborted ? {} : {}) } as SystemOneError);
  } finally {
    clearTimeout(timeout);
  }
}

export function systemOneErrorMessage(err: SystemOneError): string {
  switch (err.kind) {
    case 'timeout':
      return 'decision model timed out';
    case 'http':
      return `decision model HTTP ${err.status}`;
    case 'shape':
      return `decision model bad response: ${err.message}`;
    case 'insecure-url':
      return 'decision provider baseUrl must be https';
  }
}
