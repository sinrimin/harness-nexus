// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import fs from 'node:fs';
import path from 'node:path';
import {
  isPlatformMcpName,
  mcpMeta,
  previewOf,
  readTextBounded,
  redactSecretMap,
  skillDirFiles,
  summarize,
  type DiscoveredItem,
} from '../common.js';
import type { RawMcpEntry, TargetScanner } from '../types.js';

/**
 * OpenCode scanner (Phase 9 W12). Ground truth:
 * wiki research-phase-9-w12-opencode.md §4 — the agent's global home is
 * XDG-shaped (~/.config/opencode):
 *   mcp      → top-level `mcp` map in opencode.json (local: `command` —
 *              ARRAY in opencode's docs, string tolerated — with optional
 *              `environment`/`env`; remote: `url` with optional `headers`)
 *   commands → command/<name>.md (frontmatter description)
 *   agents   → agent/<name>.md (our `sub_agent` kind)
 *   skills   → skill/<name>/SKILL.md (+ bundle files) when the dir exists
 *              (newer installs only — absent is normal, skipped cleanly)
 * A JSONC (commented) opencode.json parses as nothing here — same honest
 * stance as the W3 writer: hand-managed files are out of bounds.
 */

/** opencode's raw `mcp.<name>` shape (both documented spellings tolerated). */
interface OpencodeMcpEntry {
  type?: string;
  command?: string[] | string;
  environment?: Record<string, string>;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

function toRawEntry(entry: OpencodeMcpEntry): RawMcpEntry {
  const command = Array.isArray(entry.command) ? entry.command[0] : entry.command;
  const args = Array.isArray(entry.command) ? entry.command.slice(1) : undefined;
  const env = entry.environment ?? entry.env;
  return {
    ...(entry.type !== undefined ? { type: entry.type } : {}),
    ...(command !== undefined && command !== '' ? { command } : {}),
    ...(args !== undefined && args.length > 0 ? { args } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(entry.url !== undefined ? { url: entry.url } : {}),
    ...(entry.headers !== undefined ? { headers: entry.headers } : {}),
  };
}

/** Read opencode.json's `mcp` map, tolerating absence/garbage/JSONC. */
export function parseOpencodeMcpServers(home: string): Record<string, RawMcpEntry> {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(home, 'opencode.json'), 'utf8');
  } catch {
    return {};
  }
  let parsed: { mcp?: Record<string, OpencodeMcpEntry> } | null;
  try {
    parsed = JSON.parse(raw) as { mcp?: Record<string, OpencodeMcpEntry> } | null;
  } catch {
    return {};
  }
  const out: Record<string, RawMcpEntry> = {};
  for (const [name, entry] of Object.entries(parsed?.mcp ?? {})) {
    if (!entry || typeof entry !== 'object') continue;
    out[name] = toRawEntry(entry);
  }
  return out;
}

/** One markdown surface (commands / agents) — flat `*.md` files. */
function scanMarkdownDir(
  dir: string,
  relDir: string,
  kind: 'command' | 'sub_agent',
): DiscoveredItem[] {
  if (!fs.existsSync(dir)) return [];
  const items: DiscoveredItem[] = [];
  for (const entry of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const abs = path.join(dir, entry.name);
    const text = readTextBounded(abs);
    items.push({
      kind,
      name: entry.name.replace(/\.md$/, ''),
      absPath: abs,
      relPath: `${relDir}/${entry.name}`,
      importable: text.ok,
      ...(text.ok
        ? {
            summary: summarize(text.content) ?? '(no description)',
            preview: previewOf(text.content) ?? '',
          }
        : { note: text.error }),
    });
  }
  return items;
}

export const opencodeScanner: TargetScanner = {
  target: 'opencode',
  homeOf: (homeDir) => path.join(homeDir, '.config', 'opencode'),

  discover(home) {
    if (!fs.existsSync(home)) return null;
    const items: DiscoveredItem[] = [];

    for (const [key, entry] of Object.entries(parseOpencodeMcpServers(home))) {
      items.push({
        kind: 'mcp',
        name: key,
        absPath: path.join(home, 'opencode.json'),
        relPath: 'opencode.json#mcp',
        importable: Boolean(entry.command ?? entry.url),
        ...((entry.command ?? entry.url) ? {} : { note: 'unsupported shape' }),
        meta: mcpMeta(entry),
        ...(isPlatformMcpName(key) ? { platform: true } : {}),
      });
    }

    items.push(...scanMarkdownDir(path.join(home, 'command'), 'command', 'command'));
    items.push(...scanMarkdownDir(path.join(home, 'agent'), 'agent', 'sub_agent'));

    const skillsDir = path.join(home, 'skill');
    if (fs.existsSync(skillsDir)) {
      for (const entry of fs
        .readdirSync(skillsDir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(skillsDir, entry.name);
        const skillMd = readTextBounded(path.join(dir, 'SKILL.md'));
        items.push({
          kind: 'skill',
          name: entry.name,
          absPath: dir,
          relPath: `skill/${entry.name}`,
          importable: skillMd.ok,
          ...(skillMd.ok
            ? {
                summary: summarize(skillMd.content) ?? '(no description)',
                preview: previewOf(skillMd.content) ?? '',
                meta: { multi: skillDirFiles(dir).length > 1 },
              }
            : { note: skillMd.error }),
        });
      }
    }

    return items;
  },

  platformMarkers(home) {
    return Object.keys(parseOpencodeMcpServers(home)).filter(isPlatformMcpName);
  },

  async collect(_home, item) {
    if (item.kind === 'skill') {
      const files: Record<string, string> = {};
      for (const rel of skillDirFiles(item.absPath)) {
        const text = readTextBounded(path.join(item.absPath, rel));
        if (!text.ok)
          return { kind: 'skill', name: item.name, ok: false, error: `${rel}: ${text.error}` };
        files[rel] = text.content;
      }
      if (!('SKILL.md' in files)) {
        return { kind: 'skill', name: item.name, ok: false, error: 'SKILL.md missing' };
      }
      return { kind: 'skill', name: item.name, ok: true, artifact: { kind: 'skill', files } };
    }
    if (item.kind === 'command' || item.kind === 'sub_agent') {
      const text = readTextBounded(item.absPath);
      if (!text.ok) return { kind: item.kind, name: item.name, ok: false, error: text.error };
      return {
        kind: item.kind,
        name: item.name,
        ok: true,
        artifact: { kind: item.kind, content: text.content },
      };
    }
    // mcp — re-derive from the config (discover re-runs on every collect).
    const entry = parseOpencodeMcpServers(path.dirname(item.absPath))[item.name];
    if (!entry) return { kind: 'mcp', name: item.name, ok: false, error: 'entry missing' };
    if (entry.command) {
      return {
        kind: 'mcp',
        name: item.name,
        ok: true,
        artifact: {
          kind: 'mcp',
          transport: {
            type: 'stdio',
            command: entry.command,
            ...(entry.args ? { args: entry.args } : {}),
            ...(entry.env ? { env: redactSecretMap(entry.env) } : {}),
          },
        },
      };
    }
    if (entry.url) {
      return {
        kind: 'mcp',
        name: item.name,
        ok: true,
        artifact: {
          kind: 'mcp',
          transport: {
            type: entry.type === 'sse' ? 'sse' : 'streamable-http',
            url: entry.url,
            ...(entry.headers ? { headers: redactSecretMap(entry.headers) } : {}),
          },
        },
      };
    }
    return { kind: 'mcp', name: item.name, ok: false, error: 'unsupported shape' };
  },
};
