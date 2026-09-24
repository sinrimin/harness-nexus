import { useCallback, useEffect, useRef, useState } from 'react';
import type { Posture } from '@harness-nexus/sdk';
import { api } from '@/api';
import { appSocket } from '@/realtime';

/** Realtime pushes that can move a posture figure (D2). */
const POSTURE_EVENTS = ['machine:status', 'inventory:updated', 'job:update', 'chat:channels'];

/** Safety poll for a missed push / a socket that never came up. */
const FALLBACK_POLL_MS = 30_000;

export interface PostureState {
  /** `null` until the first answer lands — and after a failure: the strip
   *  renders nothing rather than a zero (D2: a number may be absent, never a lie). */
  posture: Posture | null;
  refresh: () => void;
}

/**
 * The readout's data source: fetch on mount, refetch on realtime pushes, plus a
 * slow poll as a backstop. The server holds its own 5s cache, invalidated by
 * the same events, so an immediate refetch is never wasted work.
 */
export function usePosture(): PostureState {
  const [posture, setPosture] = useState<Posture | null>(null);
  const cancelled = useRef(false);

  const load = useCallback(async () => {
    try {
      const next = await api.getPosture();
      if (!cancelled.current) setPosture(next);
    } catch {
      // Absent, not zero: a stale or fake readout is worse than none.
      if (!cancelled.current) setPosture(null);
    }
  }, []);

  useEffect(() => {
    cancelled.current = false;
    void load();

    const socket = appSocket();
    const onPush = (): void => void load();
    for (const event of POSTURE_EVENTS) socket.on(event, onPush);
    const timer = window.setInterval(() => void load(), FALLBACK_POLL_MS);
    // A background tab's socket can be throttled; refresh when it comes back.
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled.current = true;
      for (const event of POSTURE_EVENTS) socket.off(event, onPush);
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  return { posture, refresh: () => void load() };
}
