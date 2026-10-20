// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { RuntimeConfigViewEvent, RuntimeTarget } from '@harness-nexus/shared';

/**
 * Redacted effective-config reader (Phase 9 W4) — the daemon half of
 * `runtime:config.get`. wiki design-phase-9-harness-runtime.md §5.
 *
 * Reads the target's NATIVE config files (the same slots W3 writes, user
 * content included — the point is the harness's EFFECTIVE state) and masks
 * secret-ish values BEFORE upload: a key-name-aware JSON walk, line-level
 * masking for TOML/YAML, and wholesale value masking for `.env` files (they
 * exist to hold credentials). Over-redaction is safe here; under-redaction is
 * not, so the key test is "the planted secret never survives".
 *
 * Paths are display paths (`~/.codex/auth.json`) — the daemon's real home
 * never leaks into a view.
 */

/** The config files shown per target (home-relative). */
export const TARGET_CONFIG_FILES: Record<RuntimeTarget, readonly string[]> = {
  'claude-code': ['.claude/settings.json'],
  codex: ['.codex/config.toml', '.codex/auth.json'],
  deepseek: ['.dsh/settings.yaml', '.dsh/cordis.patch.yml', '.dsh/.env'],
  // 9 W12 — the global config + OUR key file (the `{file:…}` target the
  // provider block references; a bare secret with no key names).
  opencode: ['.config/opencode/opencode.json', '.config/opencode/harness-nexus.key'],
  // 9 W16 — pi's three platform-relevant JSON files + our key file + the
  // user's own /login store. auth.json is wholesale-redacted (bare token
  // store); models.json's `!cat` apiKey masks by key name too.
  pi: [
    '.pi/agent/settings.json',
    '.pi/agent/models.json',
    '.pi/agent/trust.json',
    '.pi/agent/auth.json',
    '.pi/agent/harness-nexus.key',
  ],
};

/**
 * Bare-secret files — no `KEY=`/`"key":` shapes for the pair rules to catch,
 * so the WHOLE body masks (same stance as `.env`, minus the line format).
 */
const WHOLESALE_SECRET_FILES: ReadonlySet<string> = new Set([
  '.config/opencode/harness-nexus.key',
  '.pi/agent/harness-nexus.key',
  '.pi/agent/auth.json',
]);

function redactWholeFile(text: string, redacted: Redacted): string {
  if (text.trim().length === 0) return text;
  redacted.push('(whole file)');
  return `${REDACTED_PLACEHOLDER}\n`;
}

/** Cap per file — real harness configs are tiny; anything big is skipped. */
const MAX_FILE_BYTES = 128 * 1024;

export const REDACTED_PLACEHOLDER = '${redacted}';

/** Key names whose VALUES are treated as secrets regardless of file format. */
const SECRET_KEY_RE = /(token|key|secret|password|passwd|credential|authorization|bearer)/i;

type Redacted = string[];

function maskValue(value: unknown, keyPath: string, redacted: Redacted): unknown {
  if (typeof value === 'string' && value.length > 0) {
    redacted.push(keyPath);
    return REDACTED_PLACEHOLDER;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    redacted.push(keyPath);
    return REDACTED_PLACEHOLDER;
  }
  return value;
}

/** Walk a parsed JSON document, masking values under secret-ish keys (dot paths). */
function redactJsonTree(node: unknown, prefix: string, redacted: Redacted): unknown {
  if (Array.isArray(node)) {
    return node.map((item, i) => redactJsonTree(item, `${prefix}[${i}]`, redacted));
  }
  if (typeof node === 'object' && node !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      const path = prefix === '' ? k : `${prefix}.${k}`;
      out[k] = SECRET_KEY_RE.test(k)
        ? maskValue(v, path, redacted)
        : redactJsonTree(v, path, redacted);
    }
    return out;
  }
  return node;
}

/**
 * Line-level masking for TOML/YAML (and any line-ish fallback): mask the
 * VALUE wherever a secret-ish KEY sits before a `:`/`=` delimiter — including
 * inside inline maps (`headers = { Authorization: "…" }`). Unanchored on
 * purpose: an anchored match would miss quoted-JSON and inline shapes.
 */
export function redactLineConfig(text: string, redacted: Redacted): string {
  const pairRe = /([A-Za-z0-9_.-]+)(\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^,}\]\n]+)/g;
  return text
    .split('\n')
    .map((line) => {
      const keys: string[] = [];
      const masked = line.replace(pairRe, (full, key: string, gap: string, value: string) => {
        if (!SECRET_KEY_RE.test(key)) return full;
        if (value.trim() === '' || value.trim() === REDACTED_PLACEHOLDER) return full;
        keys.push(key);
        return `${key}${gap}${REDACTED_PLACEHOLDER}`;
      });
      for (const k of keys) redacted.push(k);
      return masked;
    })
    .join('\n');
}

/** Broken-JSON fallback: scrub `"key": "value"` pairs even mid-parse-error. */
function redactJsonishPairs(text: string, redacted: Redacted): string {
  return text.replace(
    /"([A-Za-z0-9_.-]+)"(\s*:\s*)"(?:[^"\\]|\\.)*"/g,
    (full, key: string, gap: string) => {
      if (!SECRET_KEY_RE.test(key)) return full;
      redacted.push(key);
      return `"${key}"${gap}"${REDACTED_PLACEHOLDER}"`;
    },
  );
}

/** `.env` files are credential storage by construction — mask EVERY value. */
export function redactEnvFile(text: string, redacted: Redacted): string {
  return text
    .split('\n')
    .map((line) => {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (m === null) return line;
      const [, key, value] = m as unknown as [string, string, string];
      if (value === REDACTED_PLACEHOLDER) return line;
      redacted.push(key);
      return `${key}=${REDACTED_PLACEHOLDER}`;
    })
    .join('\n');
}

function redactJsonFile(text: string, redacted: Redacted): string {
  try {
    const masked = redactJsonTree(JSON.parse(text), '', redacted);
    return `${JSON.stringify(masked, null, 2)}\n`;
  } catch {
    // Unparseable JSON — scrub quoted pairs AND line shapes so nothing slips
    // through on a file the platform couldn't rewrite anyway.
    return redactLineConfig(redactJsonishPairs(text, redacted), redacted);
  }
}

export interface RuntimeConfigFileView {
  path: string;
  content: string;
}

/** Read + redact one target's effective config. Unreadable/odd files skip honestly. */
export function readRuntimeConfigView(
  target: RuntimeTarget,
  homeDir: string = homedir(),
): { target: RuntimeTarget; files: RuntimeConfigFileView[]; redacted: Redacted } {
  const redacted: Redacted = [];
  const files: RuntimeConfigFileView[] = [];
  for (const rel of TARGET_CONFIG_FILES[target]) {
    const abs = join(homeDir, rel);
    const display = `~/${rel}`;
    let content: string;
    try {
      if (statSync(abs).size > MAX_FILE_BYTES) {
        files.push({ path: display, content: '[skipped: file larger than 128 KiB]' });
        continue;
      }
      content = readFileSync(abs, 'utf8');
    } catch {
      continue; // absent file — nothing this harness has configured there
    }
    if (content.includes('\0')) {
      files.push({ path: display, content: '[skipped: binary]' });
      continue;
    }
    const before = redacted.length;
    const masked = WHOLESALE_SECRET_FILES.has(rel)
      ? redactWholeFile(content, redacted)
      : rel.endsWith('.json')
        ? redactJsonFile(content, redacted)
        : rel.endsWith('.env')
          ? redactEnvFile(content, redacted)
          : redactLineConfig(content, redacted);
    // Attribute this file's entries: `"<display>:<key>"`.
    for (let i = before; i < redacted.length; i++) redacted[i] = `${display}:${redacted[i]}`;
    files.push({ path: display, content: masked });
  }
  return { target, files, redacted: [...new Set(redacted)].slice(0, 64) };
}

/** The `runtime:config.get` handler's reply payload (requestId stamped by the caller). */
export function runtimeConfigViewPayload(
  target: RuntimeTarget,
  homeDir?: string,
): Omit<RuntimeConfigViewEvent, 'requestId'> {
  const view = readRuntimeConfigView(target, homeDir);
  return { target: view.target, files: view.files, redacted: view.redacted };
}
