// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import fs from 'node:fs';
import path from 'node:path';
import type { InventoryItemKind } from '@harness-nexus/shared';

/**
 * Shared scanner plumbing (Phase 8 C3). Each target scanner discovers items
 * from the same ground-truth locations its install adapter writes; this module
 * owns the cross-target conventions: bounded text reads, summaries/previews,
 * install-ledger platform detection, and MCP secret redaction.
 * See wiki design-phase-8-c3.md.
 */

/** Hard cap for one importable artifact body (per item). */
export const MAX_ITEM_BYTES = 256 * 1024;

/** Platform-written MCP entry names start with this (shim + emitter convention). */
export const PLATFORM_MCP_PREFIX = 'harness-nexus';

/** True iff the MCP entry name is one we wrote (shim entries, marketplaces). */
export function isPlatformMcpName(name: string): boolean {
  return name === PLATFORM_MCP_PREFIX || name.startsWith(`${PLATFORM_MCP_PREFIX}-`);
}

/** Wire `meta` for a normalized MCP config entry (undefined-free per target). */
export function mcpMeta(entry: RawMcpEntryLike): {
  transport?: 'stdio' | 'sse' | 'http';
  command?: string;
  url?: string;
} {
  const transport = entry.command ? 'stdio' : entry.type === 'sse' ? 'sse' : 'http';
  return {
    transport,
    ...(entry.command ? { command: entry.command } : {}),
    ...(entry.url ? { url: entry.url } : {}),
  };
}

/** Minimal structural shape the scanners normalize config entries to. */
export interface RawMcpEntryLike {
  type?: string;
  command?: string;
  url?: string;
}

/** An item as discovered by a scanner, before wire-shaping (scan.ts does that). */
export interface DiscoveredItem {
  kind: InventoryItemKind;
  name: string;
  /** Absolute file path (content kinds) or skill directory (skills). */
  absPath: string;
  /** Display path relative to the agent home. */
  relPath: string;
  importable: boolean;
  note?: string | undefined;
  summary?: string | undefined;
  preview?: string | undefined;
  meta?:
    | {
        multi?: boolean | undefined;
        transport?: 'stdio' | 'sse' | 'http' | undefined;
        command?: string | undefined;
        url?: string | undefined;
        /** claude-code plugin-cache items: `<marketplace>/<plugin>/<version>`. */
        plugin?: string | undefined;
      }
    | undefined;
  /** Extra evidence for origin:'platform' beyond the ledger (scanner-specific). */
  platform?: boolean | undefined;
}

export type BoundedText = { ok: true; content: string } | { ok: false; error: string };

/** Read a text file with size + binary guards (an artifact that fails is never importable). */
export function readTextBounded(file: string): BoundedText {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return { ok: false, error: 'unreadable' };
  }
  if (!stat.isFile()) return { ok: false, error: 'not-a-file' };
  if (stat.size > MAX_ITEM_BYTES) return { ok: false, error: 'too-large' };
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return { ok: false, error: 'unreadable' };
  }
  if (content.slice(0, 512).includes('\u0000')) return { ok: false, error: 'binary' };
  return { ok: true, content };
}

/** List a skill directory's files (recursive, relative paths, sorted, dirs skipped). */
export function skillDirFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of fs
      .readdirSync(path.join(dir, rel), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) walk(path.join(rel, entry.name));
      else if (entry.isFile()) out.push(path.join(rel, entry.name));
    }
  };
  walk('');
  return out;
}

/** Strip YAML frontmatter if present. */
export function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return content;
  return content.slice(content.indexOf('\n', end + 1) + 1);
}

/** First meaningful line of a markdown doc (after frontmatter), ≤120 chars. */
export function summarize(content: string): string | undefined {
  const body = stripFrontmatter(content);
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line === '---') continue;
    return line.slice(0, 120);
  }
  return undefined;
}

/** ≤200-char single-line preview (after frontmatter). */
export function previewOf(content: string): string | undefined {
  const body = stripFrontmatter(content).trim();
  if (!body) return undefined;
  return body.replace(/\s+/g, ' ').slice(0, 200);
}

/**
 * The install-state ledger hnx writes into each agent home. Its operation
 * destination paths are the authoritative "platform wrote this" set — origin
 * detection never guesses from content.
 */
export interface LedgerInfo {
  platformPaths: Set<string>;
  installedProfile: string | null;
}

export function readLedger(home: string): LedgerInfo {
  const info: LedgerInfo = { platformPaths: new Set(), installedProfile: null };
  const ledgerPath = path.join(home, 'harness-nexus-install-state.json');
  try {
    const raw = JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) as {
      profile?: { name?: string };
      operations?: { destinationPath?: string }[];
    };
    for (const op of raw.operations ?? []) {
      if (op.destinationPath) info.platformPaths.add(path.resolve(op.destinationPath));
    }
    info.installedProfile = raw.profile?.name ?? null;
  } catch {
    // absent or unreadable — no ledger evidence
  }
  return info;
}

/**
 * True iff the item and a ledger-written path overlap in either direction —
 * the item is a skill DIR while ledger operations record the FILEs inside it.
 */
export function isPlatformPath(absPath: string, ledger: LedgerInfo): boolean {
  for (const p of ledger.platformPaths) {
    if (
      absPath === p ||
      absPath.startsWith(`${p}${path.sep}`) ||
      p.startsWith(`${absPath}${path.sep}`)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Redact a secret-carrying map (MCP env values, header values) to
 * `${cred:<KEY>}` placeholders — the KEY survives so the user can fill the
 * credential in; the plaintext NEVER crosses the wire to the server.
 */
export function redactSecretMap(
  values: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!values) return undefined;
  const out: Record<string, string> = {};
  for (const key of Object.keys(values)) out[key] = `\${cred:${key}}`;
  return out;
}
