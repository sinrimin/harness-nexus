// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import type { SystemOneError, SystemOneFetch } from '../infra/systemone.js';
import type { ServiceDeps } from './principal.js';

/**
 * #100 — the decision-model circuit breaker: per-owner runtime state over the
 * `decision` default-model slot. Transient call failures (timeout, network,
 * HTTP 5xx — anything the SystemOne fetch rejects with) count; consecutive
 * failures past the threshold degrade the slot for a cooldown, during which
 * delegated approvals behave as manual (fail-closed escalation to the human
 * card is already the per-call failure path — the breaker only stops paying
 * the timeout on every card and makes the state visible).
 *
 * Config-class failures never reach this class: a ref that no longer
 * resolves in the provider registry reads as UNCONFIGURED at resolve time
 * (#98's self-heal family), not as breaker trips.
 *
 * State is process memory by design: a restart clears it (nothing to heal),
 * and it NEVER rewrites the user's stored slot. Cooldown expiry is half-open
 * — the next real call probes; success closes the breaker, a failure
 * re-opens it with a fresh cooldown (the counter still holds the history, so
 * a failed probe trips immediately).
 */
export class ModelCapabilities {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  /** Consecutive-failure count + the open window, per owner. */
  private readonly owners = new Map<
    string,
    { failures: number; until: number; lastError: string }
  >();

  constructor(opts: { threshold: number; cooldownMs: number; now?: () => number }) {
    this.threshold = opts.threshold;
    this.cooldownMs = opts.cooldownMs;
    this.now = opts.now ?? Date.now;
  }

  /** A fetch outcome observation. `ok` closes the breaker; a rejection counts. */
  record(ownerId: string, ok: boolean, error?: string): void {
    const state = this.owners.get(ownerId);
    if (ok) {
      this.owners.delete(ownerId);
      return;
    }
    const failures = (state?.failures ?? 0) + 1;
    this.owners.set(ownerId, {
      failures,
      // Below the threshold the entry only carries the count (no window);
      // reaching it opens the window from NOW, also on a failed probe.
      until: failures >= this.threshold ? this.now() + this.cooldownMs : (state?.until ?? 0),
      lastError: error ?? state?.lastError ?? '',
    });
  }

  /** The degraded state, or null while healthy / probing / unconfigured. */
  degraded(ownerId: string): { until: number; lastError: string; failures: number } | null {
    const state = this.owners.get(ownerId);
    if (state === undefined) return null;
    if (state.until <= this.now()) return null; // half-open: a probe may run
    return { until: state.until, lastError: state.lastError, failures: state.failures };
  }

  /** Manual clear ("clear & retry"): the next real use is the probe. */
  reset(ownerId: string): void {
    this.owners.delete(ownerId);
  }

  /**
   * The seam both gate axes thread: while degraded the wrapper rejects with
   * the same error shape the gate already maps to "uncertain ⇒ human", so
   * the pure `decideApproval` stays untouched. The synthetic rejection is
   * NOT recorded — the breaker only observes real calls.
   */
  wrapFetch(ownerId: string, inner?: SystemOneFetch): SystemOneFetch {
    return async (url, init) => {
      const degraded = this.degraded(ownerId);
      if (degraded !== null) {
        return Promise.reject({
          kind: 'shape',
          message: `decision model degraded (circuit open until ${new Date(degraded.until).toISOString()}; last: ${degraded.lastError})`,
        } as SystemOneError);
      }
      const fetchImpl = inner ?? globalFetch;
      try {
        const res = await fetchImpl(url, init);
        if (!res.ok) this.record(ownerId, false, `HTTP ${res.status}`);
        else this.record(ownerId, true);
        return res;
      } catch (e) {
        this.record(ownerId, false, e instanceof Error ? e.message : String(e));
        throw e;
      }
    };
  }
}

/** callSystemOne's default fetch — surfaced so the wrapper can fall back. */
export const globalFetch: SystemOneFetch = (url, init) =>
  fetch(url, init) as unknown as Promise<{
    ok: boolean;
    status: number;
    text: () => Promise<string>;
  }>;

/** The api kind each slot must point at; `rerank` has no wire yet (reserved). */
const SLOT_KIND = {
  embedding: 'openai-embedding',
  decision: 'systemone',
} as const;

/** One slot's derived state — the shape `GET default-models` returns. */
export interface ModelCapabilityState {
  configured: boolean;
  health: 'ok' | 'degraded';
  /** Epoch ms — present only while degraded. */
  degradedUntil?: number;
  lastError?: string;
  consecutiveFailures?: number;
}

/**
 * The per-owner capability view: each slot's ref re-validated against the
 * live provider registry (a deleted provider/model reads `configured: false`
 * — the same self-heal stance as #98's dead references), merged with the
 * breaker's runtime health. Health is only meaningful for slots with a live
 * consumer — `decision` today; the reserved slots report `ok` while unused.
 */
export async function listModelCapabilities(
  deps: ServiceDeps,
  userId: string,
  breaker: ModelCapabilities,
): Promise<{
  decision: ModelCapabilityState;
  embedding: ModelCapabilityState;
  rerank: ModelCapabilityState;
}> {
  const user = await deps.uow.users.findById(userId);
  const slots = user?.defaultModels ?? {};
  const view = async (
    ref: { providerId: string; modelId: string } | undefined,
    kind?: string,
  ): Promise<ModelCapabilityState> => {
    if (ref === undefined) return { configured: false, health: 'ok' };
    const provider = await deps.uow.llmProviders.findById(ref.providerId);
    const configured =
      provider !== null &&
      (provider.scope === 'global' || provider.ownerId === userId) &&
      provider.models.some(
        (m) => m.id === ref.modelId && (kind === undefined || m.apiKind === kind),
      );
    if (!configured) return { configured: false, health: 'ok' };
    const degraded = breaker.degraded(userId);
    if (degraded === null) return { configured: true, health: 'ok' };
    return {
      configured: true,
      health: 'degraded',
      degradedUntil: degraded.until,
      lastError: degraded.lastError,
      consecutiveFailures: degraded.failures,
    };
  };
  return {
    decision: await view(slots.decision, SLOT_KIND.decision),
    embedding: await view(slots.embedding, SLOT_KIND.embedding),
    // rerank has no wire: existence-only validation, never degraded.
    rerank: await view(slots.rerank),
  };
}
