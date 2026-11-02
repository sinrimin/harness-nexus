// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useCallback, useEffect, useState } from 'react';
import { sessionPinKeyOf, type SessionPinPut } from '@harness-nexus/sdk';
import { api } from '@/api';
import { useAuth, withAuthGuard } from '@/auth';

/**
 * #110 — the pin truth for one rail mount: the owner's pins (BOTH axes in
 * one listing — callers match keys against their own live rows, so a pin
 * from the other axis simply never matches). Toggles are optimistic; a
 * failure rolls back by refetching rather than guessing the prior
 * `pinnedAt` (the timestamp orders the pinned block).
 */
const EMPTY_PINS = new Map<string, string>();

export function useSessionPins(): {
  /** sessionKey → pinnedAt (ISO), newest-pinned first. */
  pins: Map<string, string>;
  toggle: (input: SessionPinPut, on: boolean) => Promise<void>;
} {
  const { logout } = useAuth();
  const [pins, setPins] = useState<Map<string, string>>(EMPTY_PINS);

  useEffect(() => {
    let alive = true;
    void withAuthGuard(() => api.listSessionPins(), logout)
      .then((res) => {
        if (alive) setPins(new Map(res.pins.map((p) => [p.sessionKey, p.pinnedAt])));
      })
      .catch(() => undefined); // a failed fetch = an unpinned rail, not a page error
    return () => {
      alive = false;
    };
  }, [logout]);

  const toggle = useCallback(
    async (input: SessionPinPut, on: boolean) => {
      const key = sessionPinKeyOf(input);
      setPins((prev) => {
        const next = new Map(prev);
        if (on) next.set(key, new Date().toISOString());
        else next.delete(key);
        return next;
      });
      try {
        await withAuthGuard(() => (on ? api.pinSession(input) : api.unpinSession(input)), logout);
      } catch (e) {
        // Roll back with the server's truth — the optimistic delete already
        // lost the original `pinnedAt`.
        void withAuthGuard(() => api.listSessionPins(), logout)
          .then((res) => setPins(new Map(res.pins.map((p) => [p.sessionKey, p.pinnedAt]))))
          .catch(() => undefined);
        throw e;
      }
    },
    [logout],
  );

  return { pins, toggle };
}
