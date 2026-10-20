// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_ITEM_BYTES,
  isPlatformMcpName,
  mcpMeta,
  previewOf,
  readTextBounded,
  skillDirFiles,
  summarize,
  type DiscoveredItem,
} from '../common.js';
import type { RawMcpEntry, TargetScanner } from '../types.js';

/**
 * DeepSeek Harness (dsh) scanner (Phase 8 T1). Ground truth mirrors the T1
 * adapter:
 *   skills   → ~/.dsh/skills/<name>/SKILL.md (+ bundle files)
 *   commands → flat ~/.dsh/skills/<name>.md (the /name invocation surface)
 *   mcp      → `- insert:` rows mounting '@deepseek-ai/dsh-mcp-client' in the
 *              home ~/.dsh/cordis.patch.yml (applies to every profile)
 * Rules (persona is a config row), sub-agents (programmatic providers) and
 * hooks (opt-in bridge packages) have no declarative home shape — not scanned.
 *
 * The patch parse is tolerant text surgery over the README field spellings,
 * not a YAML parser — same tradeoff as the Codex TOML parser.
 */

const MCP_BRIDGE = '@deepseek-ai/dsh-mcp-client';

/**
 * Extract dsh-mcp-client mount rows from a cordis patch document, keyed by
 * `serverName` (the user-meaningful server name; tools surface as
 * `mcp__<serverName>__<tool>`).
 */
export function parseDeepseekMcpServers(patch: string): Record<string, RawMcpEntry> {
  const out: Record<string, RawMcpEntry> = {};
  // Segment into items at every `- key:` list line; MCP mounts are the items
  // whose `name` key is the bridge package.
  const items: string[][] = [];
  let current: string[] | null = null;
  for (const line of patch.split('\n')) {
    if (/^\s*-\s+\w+:/.test(line)) {
      current = [];
      items.push(current);
    }
    if (current !== null && !/^\s*#/.test(line)) current.push(line);
  }
  for (const item of items) {
    const text = item.join('\n');
    const name = /(?:^|\n)\s*(?:-\s+)?name:\s*['"]?([^'"\n]+?)['"]?\s*$/m.exec(text)?.[1];
    if (name !== MCP_BRIDGE) continue;
    const serverName = /serverName:\s*['"]?([^'"\n]+?)['"]?\s*$/m.exec(text)?.[1];
    if (serverName === undefined || serverName === '') continue;
    const entry: RawMcpEntry = {};
    const command = /command:\s*['"]?([^'"\n]+?)['"]?\s*$/m.exec(text)?.[1];
    if (command !== undefined) entry.command = command;
    const url = /url:\s*['"]?([^'"\n]+?)['"]?\s*$/m.exec(text)?.[1];
    if (url !== undefined) entry.url = url;
    const argsLine = /args:\s*\[(.*)\]/.exec(text)?.[1];
    if (argsLine !== undefined) {
      const args = [...argsLine.matchAll(/'([^']*)'|"((?:[^"\\]|\\.)*)"/g)].map(
        (m) => m[1] ?? m[2]!.replace(/\\"/g, '"'),
      );
      if (args.length > 0) entry.args = args;
    }
    out[serverName] = entry;
  }
  return out;
}

function readPatch(home: string): string {
  try {
    return fs.readFileSync(path.join(home, 'cordis.patch.yml'), 'utf8');
  } catch {
    return '';
  }
}

export const deepseekScanner: TargetScanner = {
  target: 'deepseek',
  homeOf: (homeDir) => path.join(homeDir, '.dsh'),

  discover(home) {
    if (!fs.existsSync(home)) return null;
    const items: DiscoveredItem[] = [];

    const skillsDir = path.join(home, 'skills');
    if (fs.existsSync(skillsDir)) {
      for (const entry of fs
        .readdirSync(skillsDir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        // Bundles (<name>/SKILL.md) are skills; flat <name>.md files are the
        // /name command surface — the split our adapter emits, preserved on
        // the round trip.
        if (entry.isDirectory()) {
          const dir = path.join(skillsDir, entry.name);
          const files = skillDirFiles(dir);
          const skillMd = readTextBounded(path.join(dir, 'SKILL.md'));
          if (!skillMd.ok) {
            items.push({
              kind: 'skill',
              name: entry.name,
              absPath: dir,
              relPath: `skills/${entry.name}`,
              importable: false,
              note: files.length === 0 ? 'empty' : `SKILL.md ${skillMd.error}`,
            });
            continue;
          }
          const totalBytes = files.reduce((sum, f) => sum + fs.statSync(path.join(dir, f)).size, 0);
          items.push({
            kind: 'skill',
            name: entry.name,
            absPath: dir,
            relPath: `skills/${entry.name}`,
            importable: totalBytes <= MAX_ITEM_BYTES,
            ...(totalBytes > MAX_ITEM_BYTES ? { note: 'too-large' } : {}),
            summary: summarize(skillMd.content),
            preview: previewOf(skillMd.content),
            meta: { multi: files.length > 1 },
          });
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          const name = entry.name.slice(0, -3);
          const abs = path.join(skillsDir, entry.name);
          const text = readTextBounded(abs);
          items.push({
            kind: 'command',
            name,
            absPath: abs,
            relPath: `skills/${entry.name}`,
            importable: text.ok,
            ...(text.ok ? { summary: summarize(text.content) } : { note: text.error }),
            ...(text.ok ? { preview: previewOf(text.content) } : {}),
          });
        }
      }
    }

    for (const [serverName, entry] of Object.entries(parseDeepseekMcpServers(readPatch(home)))) {
      items.push({
        kind: 'mcp',
        name: serverName,
        absPath: path.join(home, 'cordis.patch.yml'),
        relPath: 'cordis.patch.yml#insert',
        importable: Boolean(entry.command ?? entry.url),
        ...((entry.command ?? entry.url) ? {} : { note: 'unsupported shape' }),
        meta: mcpMeta(entry),
        ...(isPlatformMcpName(serverName) ? { platform: true } : {}),
      });
    }

    return items;
  },

  platformMarkers(home) {
    return Object.keys(parseDeepseekMcpServers(readPatch(home))).filter(isPlatformMcpName);
  },

  async collect(home, item) {
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
    if (item.kind === 'command') {
      const text = readTextBounded(item.absPath);
      if (!text.ok) return { kind: 'command', name: item.name, ok: false, error: text.error };
      return {
        kind: 'command',
        name: item.name,
        ok: true,
        artifact: { kind: 'command', content: text.content },
      };
    }
    const entry = parseDeepseekMcpServers(readPatch(home))[item.name];
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
          },
        },
      };
    }
    if (entry.url) {
      return {
        kind: 'mcp',
        name: item.name,
        ok: true,
        artifact: { kind: 'mcp', transport: { type: 'streamable-http', url: entry.url } },
      };
    }
    return { kind: 'mcp', name: item.name, ok: false, error: 'unsupported shape' };
  },
};
