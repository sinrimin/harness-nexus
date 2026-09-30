import { readFileSync } from 'node:fs';

/**
 * The CLI's own package version (#37) — what `hnx --version` prints and what
 * the daemon reports as `daemonVersion` in every `machine:hello`. Read from
 * the manifest next to the running file: `dist/version.js` and
 * `src/version.ts` both sit one level below `package.json`, so one relative
 * URL serves dev, build, and the published tarball alike.
 */
let cached: string | null = null;

export function cliVersion(): string {
  if (cached !== null) return cached;
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    cached = typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    cached = 'unknown';
  }
  return cached;
}
