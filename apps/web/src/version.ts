import { useEffect, useState } from 'react';
import { api } from '@/api';

/**
 * Server build version (#37) — fetched ONCE per session and shared by every
 * consumer (the account block's version line, the Machines page's stale-daemon
 * chip). It cannot change under a running tab, so a module-level cache serves
 * all mounts; `null` means "not (yet) known" and consumers render nothing.
 */
let cached: string | null = null;
let inflight: Promise<string | null> | null = null;

function load(): Promise<string | null> {
  if (cached !== null) return Promise.resolve(cached);
  inflight ??= api
    .getSystemInfo()
    .then((info) => {
      cached = info.version;
      return cached;
    })
    .catch(() => null)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** The resolved version, or `null` while unknown/failed. */
export function useServerVersion(): string | null {
  const [version, setVersion] = useState<string | null>(cached);
  useEffect(() => {
    let alive = true;
    void load().then((v) => {
      if (alive) setVersion(v);
    });
    return () => {
      alive = false;
    };
  }, []);
  return version;
}
