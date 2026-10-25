// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify, type TomlTable } from 'smol-toml';
import type { RuntimeConfigSpec } from '@harness-nexus/shared';

/** Roder custom providers use the Responses engine; configuration is native TOML. */
export function applyRoderConfig(spec: RuntimeConfigSpec, secret: string, home: string): string[] {
  if (spec.api !== 'openai' || spec.baseUrl === undefined) {
    throw new Error('roder requires an OpenAI Responses provider with a baseUrl');
  }
  if (
    ['RODER_CONFIG_DIR', 'RODER_DATA_DIR', 'RODER_PROVIDER', 'RODER_MODEL'].some(
      (key) => (process.env[key] ?? '').trim() !== '',
    )
  ) {
    throw new Error(
      'Roder provider push requires the default home without RODER_CONFIG_DIR, RODER_DATA_DIR, RODER_PROVIDER, or RODER_MODEL overrides',
    );
  }
  const dir = join(home, '.roder');
  const file = join(dir, 'config.toml');
  let doc: TomlTable = {};
  try {
    doc = parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(
        'Roder config.toml could not be read as valid TOML; fix it before applying a route',
      );
    }
  }
  const providers = doc.providers ?? {};
  if (
    typeof providers !== 'object' ||
    providers === null ||
    Array.isArray(providers) ||
    providers instanceof Date
  ) {
    throw new Error('roder config providers must be a TOML table');
  }
  // Preserve unrelated settings and provider routes. The serializer preserves
  // TOML values, including multiline strings; comments are not retained.
  const next = stringify({
    ...doc,
    provider: 'harness-nexus',
    model: spec.model,
    providers: {
      ...providers,
      'harness-nexus': { base_url: spec.baseUrl, api_key: secret },
    },
  });
  mkdirSync(dir, { recursive: true });
  // Apply the mode before replacing an existing file's contents.
  try {
    chmodSync(file, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  writeFileSync(file, next, { encoding: 'utf8', mode: 0o600 });
  return ['~/.roder/config.toml'];
}
