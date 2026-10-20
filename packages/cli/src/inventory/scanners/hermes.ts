// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  MAX_ITEM_BYTES,
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
 * Hermes scanner (Phase 8 C3). Ground truth mirrors the 3.4 adapter:
 *   skills → ~/.hermes/plugins/<slug>/skills/<name>/SKILL.md — BOTH ours
 *            (plugin.yaml author 'Harness Nexus') and third-party plugins
 *   mcp    → `mcp_servers:` map in ~/.hermes/config.yaml (YAML)
 *   rules  → ~/.hermes/AGENTS.md (Hermes auto-loads it; the adapter writes it)
 * sub_agents/hooks have no file format — not scanned.
 */

/** Read config.yaml's mcp_servers map, tolerating absence/garbage. */
function parseHermesMcpServers(home: string): Record<string, RawMcpEntry> {
  try {
    const parsed = yaml.load(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')) as {
      mcp_servers?: Record<string, RawMcpEntry>;
    } | null;
    return parsed?.mcp_servers ?? {};
  } catch {
    return {};
  }
}

/** True iff the plugin bundle is ours (plugin.yaml author). */
function isHarnessPlugin(pluginDir: string): boolean {
  try {
    const manifest = yaml.load(fs.readFileSync(path.join(pluginDir, 'plugin.yaml'), 'utf8')) as {
      author?: string;
    } | null;
    return manifest?.author === 'Harness Nexus';
  } catch {
    return false;
  }
}

function scanSkillDir(
  dir: string,
  relPath: string,
  platform: boolean,
): DiscoveredItem | { error: string } {
  const files = skillDirFiles(dir);
  const skillMd = readTextBounded(path.join(dir, 'SKILL.md'));
  if (!skillMd.ok) {
    return {
      error: files.length === 0 ? 'empty' : `SKILL.md ${skillMd.error}`,
    };
  }
  const totalBytes = files.reduce((sum, f) => sum + fs.statSync(path.join(dir, f)).size, 0);
  return {
    kind: 'skill',
    name: path.basename(dir),
    absPath: dir,
    relPath,
    importable: totalBytes <= MAX_ITEM_BYTES,
    ...(totalBytes > MAX_ITEM_BYTES ? { note: 'too-large' } : {}),
    summary: summarize(skillMd.content) ?? '(no description)',
    preview: previewOf(skillMd.content) ?? '',
    meta: { multi: files.length > 1 },
    ...(platform ? { platform: true } : {}),
  };
}

export const hermesScanner: TargetScanner = {
  target: 'hermes',
  homeOf: (homeDir) => path.join(homeDir, '.hermes'),

  discover(home) {
    if (!fs.existsSync(home)) return null;
    const items: DiscoveredItem[] = [];

    const pluginsDir = path.join(home, 'plugins');
    if (fs.existsSync(pluginsDir)) {
      for (const entry of fs
        .readdirSync(pluginsDir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory()) continue;
        const pluginDir = path.join(pluginsDir, entry.name);
        const ours = isHarnessPlugin(pluginDir);
        const skillsDir = path.join(pluginDir, 'skills');
        if (!fs.existsSync(skillsDir)) continue;
        for (const skill of fs
          .readdirSync(skillsDir, { withFileTypes: true })
          .sort((a, b) => a.name.localeCompare(b.name))) {
          if (!skill.isDirectory()) continue;
          const found = scanSkillDir(
            path.join(skillsDir, skill.name),
            `plugins/${entry.name}/skills/${skill.name}`,
            ours,
          );
          if ('error' in found) {
            items.push({
              kind: 'skill',
              name: skill.name,
              absPath: path.join(skillsDir, skill.name),
              relPath: `plugins/${entry.name}/skills/${skill.name}`,
              importable: false,
              note: found.error,
            });
          } else {
            items.push(found);
          }
        }
      }
    }

    for (const [key, entry] of Object.entries(parseHermesMcpServers(home))) {
      if (!entry || typeof entry !== 'object') continue;
      items.push({
        kind: 'mcp',
        name: key,
        absPath: path.join(home, 'config.yaml'),
        relPath: 'config.yaml#mcp_servers',
        importable: Boolean(entry.command ?? entry.url),
        ...((entry.command ?? entry.url) ? {} : { note: 'unsupported shape' }),
        meta: mcpMeta(entry),
        ...(isPlatformMcpName(key) ? { platform: true } : {}),
      });
    }

    const agentsMd = path.join(home, 'AGENTS.md');
    if (fs.existsSync(agentsMd)) {
      const text = readTextBounded(agentsMd);
      items.push({
        kind: 'rule',
        name: 'AGENTS',
        absPath: agentsMd,
        relPath: 'AGENTS.md',
        importable: text.ok,
        ...(text.ok
          ? {
              summary: summarize(text.content) ?? '(empty)',
              preview: previewOf(text.content) ?? '',
            }
          : { note: text.error }),
      });
    }

    return items;
  },

  platformMarkers(home) {
    return Object.keys(parseHermesMcpServers(home)).filter(isPlatformMcpName);
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
    if (item.kind === 'rule') {
      const text = readTextBounded(item.absPath);
      if (!text.ok) return { kind: 'rule', name: item.name, ok: false, error: text.error };
      return {
        kind: 'rule',
        name: item.name,
        ok: true,
        artifact: { kind: 'rule', content: text.content },
      };
    }
    const entry = parseHermesMcpServers(home)[item.name];
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
