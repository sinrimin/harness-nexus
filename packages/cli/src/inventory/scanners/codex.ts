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
 * Codex scanner (Phase 8 C3). Ground truth mirrors the C2 adapter:
 *   skills → ~/.codex/skills/<name>/SKILL.md (+ bundle files)
 *   commands → ~/.codex/prompts/<name>.md
 *   mcp → `[mcp_servers.<name>]` sections in ~/.codex/config.toml (stdio-only
 *         in practice, but url sections parse too)
 * Rules (project-root AGENTS.md), sub-agents and hooks have no verified global
 * home shape — not scanned.
 */

/** Parse `[mcp_servers.<name>]` sections: our payloads are plain strings / string arrays. */
export function parseCodexMcpServers(toml: string): Record<string, RawMcpEntry> {
  const out: Record<string, RawMcpEntry> = {};
  let current: { name: string; entry: RawMcpEntry } | null = null;
  for (const raw of toml.split('\n')) {
    const line = raw.trim();
    const section = /^\[([^\]]+)\]$/.exec(line);
    if (section) {
      const parts = section[1]!.split('.');
      if (parts.length === 2 && parts[0] === 'mcp_servers') {
        const name = parts[1]!.replace(/^"|"$/g, '');
        const entry: RawMcpEntry = {};
        out[name] = entry;
        current = { name, entry };
      } else {
        current = null;
      }
      continue;
    }
    if (!current || !line || line.startsWith('#')) continue;
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    const value = rawValue!.trim();
    if (value.startsWith('"')) {
      const str = /^"((?:[^"\\]|\\.)*)"/.exec(value)?.[1];
      if (str === undefined) continue;
      const unescaped = str.replace(/\\(["\\])/g, '$1');
      if (key === 'command') current.entry.command = unescaped;
      else if (key === 'url') current.entry.url = unescaped;
    } else if (value.startsWith('[')) {
      const items = value.match(/"((?:[^"\\]|\\.)*)"/g) ?? [];
      const arr = items.map((q) => q.slice(1, -1).replace(/\\(["\\])/g, '$1'));
      if (key === 'args') current.entry.args = arr;
    }
  }
  return out;
}

function readConfigToml(home: string): string {
  try {
    return fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
  } catch {
    return '';
  }
}

export const codexScanner: TargetScanner = {
  target: 'codex',
  homeOf: (homeDir) => path.join(homeDir, '.codex'),

  discover(home) {
    if (!fs.existsSync(home)) return null;
    const items: DiscoveredItem[] = [];

    const skillsDir = path.join(home, 'skills');
    if (fs.existsSync(skillsDir)) {
      for (const entry of fs
        .readdirSync(skillsDir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory()) continue;
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
      }
    }

    const promptsDir = path.join(home, 'prompts');
    if (fs.existsSync(promptsDir)) {
      for (const entry of fs
        .readdirSync(promptsDir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const name = entry.name.slice(0, -3);
        const abs = path.join(promptsDir, entry.name);
        const text = readTextBounded(abs);
        items.push({
          kind: 'command',
          name,
          absPath: abs,
          relPath: `prompts/${entry.name}`,
          importable: text.ok,
          ...(text.ok ? { summary: summarize(text.content) } : { note: text.error }),
          ...(text.ok ? { preview: previewOf(text.content) } : {}),
        });
      }
    }

    for (const [key, entry] of Object.entries(parseCodexMcpServers(readConfigToml(home)))) {
      items.push({
        kind: 'mcp',
        name: key,
        absPath: path.join(home, 'config.toml'),
        relPath: 'config.toml#mcp_servers',
        importable: Boolean(entry.command ?? entry.url),
        ...((entry.command ?? entry.url) ? {} : { note: 'unsupported shape' }),
        meta: mcpMeta(entry),
        ...(isPlatformMcpName(key) ? { platform: true } : {}),
      });
    }

    return items;
  },

  platformMarkers(home) {
    return Object.keys(parseCodexMcpServers(readConfigToml(home))).filter(isPlatformMcpName);
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
    const entry = parseCodexMcpServers(readConfigToml(home))[item.name];
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
