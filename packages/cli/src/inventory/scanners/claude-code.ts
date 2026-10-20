// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import fs from 'node:fs';
import path from 'node:path';
import type { DiscoveredItem } from '../common.js';
import {
  MAX_ITEM_BYTES,
  isPlatformMcpName,
  mcpMeta,
  previewOf,
  readTextBounded,
  redactSecretMap,
  skillDirFiles,
  summarize,
} from '../common.js';
import type { RawMcpEntry, TargetScanner } from '../types.js';

/**
 * Claude Code scanner (Phase 8 C3). Ground truth mirrors what our adapters and
 * the marketplace emitter write:
 *   skills   → ~/.claude/skills/<name>/SKILL.md (+ bundle files)
 *   commands → ~/.claude/commands/<name>.md
 *   agents   → ~/.claude/agents/<name>.md
 *   mcp      → `mcpServers` in ~/.claude.json (user scope — OUTSIDE ~/.claude)
 *   plugins  → ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/
 *              {skills,commands,agents} — the 3.5 marketplace emitter IS the
 *              claude-code install path, so its artifacts must be visible.
 *              Items from a `harness-nexus*` marketplace carry platform origin
 *              (the emitter names its marketplace exactly
 *              `harness-nexus-<username>`); third-party plugins are local.
 * Rules and hooks are not scanned (no established global rules dir; CC's hook
 * matcher format is lossy vs the 4.5 event map).
 */

const CLAUDE_JSON_LIMIT = 4 * 1024 * 1024;

function parseClaudeJson(homeDir: string): Record<string, RawMcpEntry> {
  // NB: ~/.claude.json holds CC's full state (projects, history) — bound the
  // read and tolerate garbage; MCP absence is not an error.
  const file = path.join(homeDir, '.claude.json');
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > CLAUDE_JSON_LIMIT) return {};
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      mcpServers?: Record<string, RawMcpEntry>;
    };
    return parsed.mcpServers ?? {};
  } catch {
    return {};
  }
}

/** The emitter's marketplace name — the platform marker for plugin-cache items. */
export function isPlatformMarketplace(name: string): boolean {
  return name === 'harness-nexus' || name.startsWith('harness-nexus-');
}

/** Every versioned plugin root in the CC marketplace cache. */
function pluginCacheRoots(home: string): { dir: string; marketplace: string; relBase: string }[] {
  const cacheDir = path.join(home, 'plugins', 'cache');
  if (!fs.existsSync(cacheDir)) return [];
  const roots: { dir: string; marketplace: string; relBase: string }[] = [];
  const dnts = (dir: string) =>
    fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const market of dnts(cacheDir)) {
    if (!market.isDirectory()) continue;
    const marketDir = path.join(cacheDir, market.name);
    for (const plugin of dnts(marketDir)) {
      if (!plugin.isDirectory()) continue;
      const pluginDir = path.join(marketDir, plugin.name);
      for (const version of dnts(pluginDir)) {
        if (!version.isDirectory()) continue;
        roots.push({
          dir: path.join(pluginDir, version.name),
          marketplace: market.name,
          relBase: `plugins/cache/${market.name}/${plugin.name}/${version.name}`,
        });
      }
    }
  }
  return roots;
}

/** Extra discovery context for plugin-cache items (merged into item meta). */
interface PluginCtx {
  platform: boolean;
  plugin: string;
}

/** Scan a skills directory of `<name>/SKILL.md` (+ bundle files). */
function scanSkillsDir(skillsDir: string, relBase: string, ctx?: PluginCtx): DiscoveredItem[] {
  if (!fs.existsSync(skillsDir)) return [];
  const items: DiscoveredItem[] = [];
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
        relPath: `${relBase}/${entry.name}`,
        importable: false,
        note: files.length === 0 ? 'empty' : `SKILL.md ${skillMd.error}`,
        ...(ctx ? { platform: ctx.platform } : {}),
        ...(ctx ? { meta: { plugin: ctx.plugin } } : {}),
      });
      continue;
    }
    const totalBytes = files.reduce((sum, f) => sum + fs.statSync(path.join(dir, f)).size, 0);
    items.push({
      kind: 'skill',
      name: entry.name,
      absPath: dir,
      relPath: `${relBase}/${entry.name}`,
      importable: totalBytes <= MAX_ITEM_BYTES,
      ...(totalBytes > MAX_ITEM_BYTES ? { note: 'too-large' } : {}),
      summary: summarize(skillMd.content),
      preview: previewOf(skillMd.content),
      meta: { multi: files.length > 1, ...(ctx ? { plugin: ctx.plugin } : {}) },
      ...(ctx?.platform ? { platform: true } : {}),
    });
  }
  return items;
}

/** Scan one directory of sibling markdown artifacts (commands/, agents/). */
function scanMarkdownDir(
  dir: string,
  relBase: string,
  kind: 'command' | 'sub_agent',
  ext: '.md',
  ctx?: PluginCtx,
): DiscoveredItem[] {
  if (!fs.existsSync(dir)) return [];
  const items: DiscoveredItem[] = [];
  for (const entry of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(ext)) continue;
    const name = entry.name.slice(0, -ext.length);
    if (!name) continue;
    const abs = path.join(dir, entry.name);
    const text = readTextBounded(abs);
    items.push({
      kind,
      name,
      absPath: abs,
      relPath: `${relBase}/${entry.name}`,
      importable: text.ok,
      ...(text.ok ? { summary: summarize(text.content) } : { note: text.error }),
      ...(text.ok ? { preview: previewOf(text.content) } : {}),
      ...(ctx ? { meta: { plugin: ctx.plugin } } : {}),
      ...(ctx?.platform ? { platform: true } : {}),
    });
  }
  return items;
}

export const claudeCodeScanner: TargetScanner = {
  target: 'claude-code',
  homeOf: (homeDir) => path.join(homeDir, '.claude'),

  discover(home) {
    // ~/.claude.json lives at HOME root; the home dir itself may be absent
    // while user-scope MCP servers still exist — scan both independently.
    const homeDir = path.dirname(home);
    const items: DiscoveredItem[] = [];
    const homeExists = fs.existsSync(home);

    if (homeExists) {
      items.push(...scanSkillsDir(path.join(home, 'skills'), 'skills'));
      items.push(...scanMarkdownDir(path.join(home, 'commands'), 'commands', 'command', '.md'));
      items.push(...scanMarkdownDir(path.join(home, 'agents'), 'agents', 'sub_agent', '.md'));

      // Marketplace plugin cache — the 3.5 install path. User-level items win
      // the (kind, name) dedupe in scan.ts, so a same-named user skill
      // shadows the plugin copy.
      for (const root of pluginCacheRoots(home)) {
        const ctx: PluginCtx = {
          platform: isPlatformMarketplace(root.marketplace),
          plugin: root.relBase.replace(/^plugins\/cache\//, ''),
        };
        items.push(...scanSkillsDir(path.join(root.dir, 'skills'), `${root.relBase}/skills`, ctx));
        items.push(
          ...scanMarkdownDir(
            path.join(root.dir, 'commands'),
            `${root.relBase}/commands`,
            'command',
            '.md',
            ctx,
          ),
        );
        items.push(
          ...scanMarkdownDir(
            path.join(root.dir, 'agents'),
            `${root.relBase}/agents`,
            'sub_agent',
            '.md',
            ctx,
          ),
        );
      }
    }

    for (const [key, entry] of Object.entries(parseClaudeJson(homeDir))) {
      if (!entry || typeof entry !== 'object') continue;
      items.push({
        kind: 'mcp',
        name: key,
        absPath: path.join(homeDir, '.claude.json'),
        relPath: '~/.claude.json#mcpServers',
        importable: Boolean(entry.command ?? entry.url),
        ...((entry.command ?? entry.url) ? {} : { note: 'unsupported shape' }),
        meta: mcpMeta(entry),
        ...(isPlatformMcpName(key) ? { platform: true } : {}),
      });
    }

    return homeExists || items.length > 0 ? items : null;
  },

  platformMarkers(home) {
    const homeDir = path.dirname(home);
    const markers = Object.keys(parseClaudeJson(homeDir)).filter(isPlatformMcpName);
    for (const root of pluginCacheRoots(home)) {
      if (isPlatformMarketplace(root.marketplace)) markers.push(root.marketplace);
    }
    return markers;
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
    // mcp — re-read ~/.claude.json, redact env/header values daemon-side.
    const homeDir = path.dirname(home);
    const entry = parseClaudeJson(homeDir)[item.name];
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
      const type = entry.type === 'sse' ? 'sse' : 'streamable-http';
      return {
        kind: 'mcp',
        name: item.name,
        ok: true,
        artifact: {
          kind: 'mcp',
          transport: {
            type,
            url: entry.url,
            ...(entry.headers ? { headers: redactSecretMap(entry.headers) } : {}),
          },
        },
      };
    }
    return { kind: 'mcp', name: item.name, ok: false, error: 'unsupported shape' };
  },
};
