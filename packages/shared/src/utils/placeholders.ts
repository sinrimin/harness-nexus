// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * Credential placeholder interpolation.
 *
 * A credential's secret is referenced by name via `${cred:NAME}` inside
 * transport string fields (url, command, args, env values, header values).
 * `resolvePlaceholders` scans a string for these tokens and substitutes the
 * value returned by `lookup(name)`. The lookup is expected to decrypt the
 * credential and return its plaintext; an unknown name lets the lookup throw,
 * which surfaces as a connection error (proxy) / install error (direct).
 *
 * Resolution timing:
 *   - proxy mode  — server-side at connect time (plaintext in memory only).
 *   - direct mode — install time, by the Phase 3.3 writer.
 *
 * See wiki design-phase-2.1-credentials.md.
 */

/** Matches `${cred:NAME}` where NAME is the credential name (non-} chars). */
export const CRED_PLACEHOLDER_RE = /\$\{cred:([^}]+)\}/g;

/** A default placeholder string for a credential name, for UI hints. */
export function credPlaceholder(name: string): string {
  return `\${cred:${name}}`;
}

/**
 * Replace every `${cred:NAME}` occurrence in `input` by awaiting `lookup(NAME)`.
 * The lookup receives the captured name and returns the substitution; throwing
 * aborts resolution (the error propagates to the caller).
 */
export async function resolvePlaceholders(
  input: string,
  lookup: (name: string) => Promise<string>,
): Promise<string> {
  // Collect matches first so we can resolve sequentially without regex state issues.
  const names: string[] = [];
  for (const m of input.matchAll(CRED_PLACEHOLDER_RE)) {
    const name = m[1];
    if (name) names.push(name);
  }
  if (names.length === 0) return input;
  const resolved = new Map<string, string>();
  for (const name of names) {
    if (!resolved.has(name)) {
      resolved.set(name, await lookup(name));
    }
  }
  return input.replace(CRED_PLACEHOLDER_RE, (_, name: string) => resolved.get(name) ?? '');
}
