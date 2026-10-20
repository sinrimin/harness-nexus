// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * #66 — reconnect-only resubscription gate. A silent socket.io reconnect
 * (weak network, phone lock screen) is a NEW connection: every `chan:<id>`
 * room membership is gone while the SPA stays mounted with its listeners
 * attached — the pane looks alive but receives nothing. Pages register a
 * recovery action (re-join the open channel / re-sync the session); the
 * gate fires them on connect-after-disconnect, never on the first connect
 * (pages mount after it and run their own open flows).
 */
export interface ResubscribeGate {
  /** Called by the socket's connect handler on EVERY connect. */
  onConnect(): void;
  /** Register a recovery action; returns its unregister function. */
  subscribe(fn: () => void): () => void;
}

export function createResubscribeGate(): ResubscribeGate {
  const fns = new Set<() => void>();
  let hasConnectedOnce = false;
  return {
    onConnect(): void {
      if (hasConnectedOnce) for (const fn of [...fns]) fn();
      hasConnectedOnce = true;
    },
    subscribe(fn: () => void): () => void {
      fns.add(fn);
      return () => fns.delete(fn);
    },
  };
}
