// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { readFileSync } from 'node:fs';
import type { MarketplaceFetcher } from './types.js';

/**
 * Phase 7.2 — construct the marketplace fetcher for the running config.
 *
 * - Production (`fixturePath` unset): returns `globalThis.fetch`.
 * - Test/fixture (`fixturePath` set): returns a fetcher that reads the local
 *   file once and responds 200 with its contents, regardless of URL. This is
 *   how the smoke script exercises the catalog pipeline without hitting GitHub.
 *
 * The fixture fetcher caches the file content in memory; the smoke script's
 * call-count assertions rely on the service cache (not on re-reading the file).
 */
export function createMarketplaceFetcher(fixturePath?: string): MarketplaceFetcher {
  if (!fixturePath) return globalThis.fetch;

  let cached: string | undefined;
  return async () => {
    if (cached === undefined) cached = readFileSync(fixturePath, 'utf8');
    return new Response(cached, { status: 200, headers: { 'content-type': 'application/json' } });
  };
}
