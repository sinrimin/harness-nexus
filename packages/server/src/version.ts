import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

/**
 * The server build version (#37) — read from `@harness-nexus/shared`'s
 * manifest, because the five publishable packages version in LOCKSTEP and
 * `packages/server` itself is not one of them (its manifest stays `0.0.0`).
 * Reporting the lockstep version is what makes the web stale-daemon chip and
 * the daemon's connect-time warning meaningful: daemons report their CLI
 * package version, which rolls on the same releases.
 */
let cached: string | null = null;

export function serverVersion(): string {
  if (cached !== null) return cached;
  try {
    const manifest = createRequire(import.meta.url).resolve('@harness-nexus/shared/package.json');
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string };
    cached = typeof pkg.version === 'string' && pkg.version !== '0.0.0' ? pkg.version : 'unknown';
  } catch {
    cached = 'unknown';
  }
  return cached;
}
