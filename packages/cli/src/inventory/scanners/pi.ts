// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import fs from 'node:fs';
import path from 'node:path';
import {
  previewOf,
  readTextBounded,
  skillDirFiles,
  summarize,
  type DiscoveredItem,
} from '../common.js';
import type { TargetScanner } from '../types.js';

/**
 * pi scanner (Phase 9 W16). Ground truth: wiki research-phase-9-w16-pi-agent.md
 * §7 — the agent's global home is `~/.pi/agent`:
 *   skills   → skills/<name>/SKILL.md (+ bundle files) — Agent Skills format;
 *              the DISPLAY name comes from frontmatter `name` (pi allows it
 *              to differ from the directory), falling back to the dirname
 *   commands → prompts/<name>.md — prompt templates; the FILENAME is the
 *              `/name` command (frontmatter optional)
 *   mcp      → NO arm — pi has no declarative MCP surface (extension-based)
 */

/** Read frontmatter `name` from a SKILL.md (null when absent/invalid). */
export function piSkillName(text: string): string | null {
  const lines = text.split('\n');
  if (lines[0] === undefined || lines[0]!.trim() !== '---') return null;
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break;
    const hit = /^name:\s*(.+)$/.exec(line);
    if (hit !== null) {
      const raw = hit[1]!.trim().replace(/^["']|["']$/g, '');
      return raw.length > 0 ? raw : null;
    }
  }
  return null;
}

export const piScanner: TargetScanner = {
  target: 'pi',
  homeOf: (homeDir) => path.join(homeDir, '.pi', 'agent'),

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
        const skillMd = readTextBounded(path.join(dir, 'SKILL.md'));
        items.push({
          kind: 'skill',
          // Frontmatter wins — pi tolerates name ≠ dirname (unlike the strict
          // Agent Skills standard), so the dirname alone would misreport.
          name: (skillMd.ok ? piSkillName(skillMd.content) : null) ?? entry.name,
          absPath: dir,
          relPath: `skills/${entry.name}`,
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

    const promptsDir = path.join(home, 'prompts');
    if (fs.existsSync(promptsDir)) {
      for (const entry of fs
        .readdirSync(promptsDir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const abs = path.join(promptsDir, entry.name);
        const text = readTextBounded(abs);
        items.push({
          kind: 'command',
          name: entry.name.replace(/\.md$/, ''),
          absPath: abs,
          relPath: `prompts/${entry.name}`,
          importable: text.ok,
          ...(text.ok
            ? {
                summary: summarize(text.content) ?? '(no description)',
                preview: previewOf(text.content) ?? '',
              }
            : { note: text.error }),
        });
      }
    }

    return items;
  },

  platformMarkers() {
    return []; // no declarative MCP surface — nothing platform-marked
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
    return { kind: item.kind, name: item.name, ok: false, error: 'kind not collectable for pi' };
  },
};
