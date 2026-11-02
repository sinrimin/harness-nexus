// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { previewOf, readTextBounded, skillDirFiles, summarize } from '../common.js';
import type { TargetScanner } from '../types.js';

/** Global Agent Skills only; credentials and session stores are never scanned. */
export const roderScanner: TargetScanner = {
  target: 'roder',
  homeOf: (home) => join(home, '.roder'),
  discover(home) {
    // Roder's build_skills_registry uses ~/.codex/skills for user skills.
    const skills = join(dirname(home), '.codex', 'skills');
    if (!existsSync(skills)) return [];
    return readdirSync(skills, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => {
        const dir = join(skills, entry.name);
        const text = readTextBounded(join(dir, 'SKILL.md'));
        return {
          kind: 'skill' as const,
          name: entry.name,
          absPath: dir,
          relPath: `../.codex/skills/${entry.name}`,
          importable: text.ok,
          ...(text.ok
            ? {
                summary: summarize(text.content) ?? '(no description)',
                preview: previewOf(text.content) ?? '',
                meta: { multi: skillDirFiles(dir).length > 1 },
              }
            : { note: text.error }),
        };
      });
  },
  platformMarkers: () => [],
  async collect(_home, item) {
    const files: Record<string, string> = {};
    for (const rel of skillDirFiles(item.absPath)) {
      const text = readTextBounded(join(item.absPath, rel));
      if (!text.ok) return { kind: item.kind, name: item.name, ok: false, error: text.error };
      files[rel] = text.content;
    }
    if (!('SKILL.md' in files))
      return { kind: item.kind, name: item.name, ok: false, error: 'SKILL.md missing' };
    return { kind: 'skill', name: item.name, ok: true, artifact: { kind: 'skill', files } };
  },
};
