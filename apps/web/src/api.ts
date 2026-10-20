// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { HarnessNexusClient } from '@harness-nexus/sdk';

// Vite dev server proxies /api to the Fastify backend (see vite.config.ts),
// so we just call same-origin. In production, set VITE_API_BASE_URL.
const baseUrl = import.meta.env.VITE_API_BASE_URL ?? '';

export const TOKEN_KEY = 'harnessnexus.token';

export const api = new HarnessNexusClient({
  baseUrl,
  token: localStorage.getItem(TOKEN_KEY) ?? undefined,
});

/**
 * The central 401 interceptor: on any request returning 401, clear stored auth
 * and bounce to /login. Implemented here as a post-call check used by the auth
 * context rather than monkey-patching fetch, so it stays explicit.
 */
export function isUnauthorized(status: number): boolean {
  return status === 401;
}
