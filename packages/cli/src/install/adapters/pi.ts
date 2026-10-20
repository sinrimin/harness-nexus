// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * pi target adapter (Phase 9 W16).
 *
 * pi layout (ground truth: `wiki research-phase-9-w16-pi-agent.md` §7 —
 * pi.dev docs "Skills" + "Prompt templates", verified 2026-09-17):
 *   A. skills   → `~/.pi/agent/skills/<name>/SKILL.md` (+ bundle files) —
 *                 the Agent Skills format; pi REQUIRES frontmatter `name` +
 *                 `description` (malformed files warn and do not load), name
 *                 ≤64 chars kebab-case. The adapter guarantees both
 *                 (frontmatter synthesis, same stance as dsh).
 *   B. commands → `~/.pi/agent/prompts/<name>.md` — pi's prompt-template
 *                 surface; the FILENAME is the `/name` command. Frontmatter
 *                 is optional (a missing `description` falls back to the
 *                 first non-empty line), so command bodies pass through
 *                 verbatim.
 *
 * Skipped (no declarative surface — research §7): mcp (extension-based
 * config, upstream issue #563 tracks a first-party example), sub_agents
 * (TS extensions), hooks (TS extensions), rules (pi loads AGENTS.md from
 * the project cwd — there is no home-level rules file to own).
 */
import path from 'node:path';
import { createTargetAdapter } from '../adapter-factory.js';
import type { Operation, ResolvedArtifact, TargetAdapter } from '../types.js';

/** The install-state ledger filename inside the pi home. */
const INSTALL_STATE_FILENAME = 'harness-nexus-install-state.json';

/** A resource kind this adapter cannot emit. */
const SKIPPED_KINDS = new Set(['rule', 'sub_agent', 'hook', 'mcp']);

const SKIP_REASONS: Record<string, string> = {
  rule: 'pi loads AGENTS.md from the project cwd — there is no home-level rules file hnx could own',
  sub_agent: 'pi sub-agents are TypeScript extensions, not files',
  hook: 'pi hooks are TypeScript extensions, not declarative bindings',
  mcp: 'pi has no declarative MCP config — servers ride TS extensions (upstream has no first-party format yet)',
};

/** pi skill names: lowercase letters, numbers, hyphens; ≤64 chars. */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 64);
  return slug === '' ? 'harness-nexus' : slug;
}

// ---- frontmatter (pi warns and skips skill files without name + description) ----

function splitFrontmatter(content: string): { lines: string[]; body: string } | null {
  const lines = content.split('\n');
  if (lines[0] === undefined || lines[0]!.trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) return null;
  return { lines: lines.slice(1, end), body: lines.slice(end + 1).join('\n') };
}

/**
 * Guarantee `name` + `description` frontmatter on a SKILL.md (pi ignores
 * files without both). Existing values win — the adapter only fills gaps.
 */
export function ensurePiFrontmatter(content: string, name: string, description: string): string {
  const fm = splitFrontmatter(content);
  const has = (key: string): boolean =>
    (fm?.lines ?? []).some((l) => l.trim().startsWith(`${key}:`));
  const additions: string[] = [];
  if (!has('name')) additions.push(`name: ${JSON.stringify(name)}`);
  if (!has('description')) additions.push(`description: ${JSON.stringify(description)}`);
  if (fm === null) {
    return `---\n${additions.join('\n')}\n---\n\n${content}`;
  }
  if (additions.length === 0) return content;
  return `${['---', ...fm.lines, ...additions, '---'].join('\n')}\n${fm.body}`;
}

/** Extract a Resource's inline file set (same policy as the other adapters). */
function resourceFiles(artifact: ResolvedArtifact): { relativePath: string; content: string }[] {
  if (artifact.kind === 'mcp') return [];
  const src = artifact.resource.source;
  if (src.type === 'inline') {
    return [{ relativePath: 'SKILL.md', content: src.content }];
  }
  if (src.type === 'inline-bundle') {
    return Object.entries(src.files).map(([rel, content]) => ({ relativePath: rel, content }));
  }
  return [];
}

export const piAdapter: TargetAdapter = createTargetAdapter({
  id: 'pi-home',
  target: 'pi',
  kind: 'home',
  rootSegments: ['.pi', 'agent'],
  installStateFilename: INSTALL_STATE_FILENAME,

  planOperations(resolved, input, adapter) {
    const root = adapter.resolveRoot(input);
    const operations: Operation[] = [];
    const skipped: string[] = [];

    // ---- A. skills → ~/.pi/agent/skills/<name>/ (+ bundle files) ----
    for (const a of resolved.artifacts) {
      if (a.kind !== 'skill') continue;
      const files = resourceFiles(a);
      if (files.length === 0) {
        skipped.push(`skill:${a.resource.key} (non-inline source not fetchable by CLI)`);
        continue;
      }
      const slug = slugify(a.resource.name);
      const description = a.resource.description ?? a.resource.name;
      if (!files.some((f) => f.relativePath === 'SKILL.md')) {
        skipped.push(`skill:${a.resource.key} (bundle has no SKILL.md at root)`);
        continue;
      }
      for (const f of files) {
        const content =
          f.relativePath === 'SKILL.md'
            ? ensurePiFrontmatter(f.content, slug, description)
            : f.content;
        operations.push({
          kind: 'write-file',
          content,
          destinationPath: path.join(root, 'skills', slug, f.relativePath),
        });
      }
    }

    // ---- B. commands → ~/.pi/agent/prompts/<name>.md (the /name surface) ----
    for (const a of resolved.artifacts) {
      if (a.kind !== 'command') continue;
      const files = resourceFiles(a);
      const content = files[0]?.content;
      if (content === undefined) {
        skipped.push(`command:${a.resource.key} (non-inline source not fetchable by CLI)`);
        continue;
      }
      operations.push({
        kind: 'write-file',
        content,
        destinationPath: path.join(root, 'prompts', `${slugify(a.resource.name)}.md`),
      });
    }

    // ---- skipped kinds ----
    for (const a of resolved.artifacts) {
      if (SKIPPED_KINDS.has(a.kind)) {
        const key = a.kind === 'mcp' ? a.mcpServer.name : a.resource.key;
        skipped.push(`${a.kind}:${key} (${SKIP_REASONS[a.kind]})`);
      }
    }

    lastPlanWarnings = { skipped };

    return {
      adapter: { id: adapter.id, target: adapter.target, kind: adapter.kind },
      targetRoot: root,
      installStatePath: path.join(root, INSTALL_STATE_FILENAME),
      operations,
      sensitive: false,
    };
  },
});

/** Warnings from the most recent pi plan (read by the CLI for output). */
export interface PiPlanWarnings {
  skipped: string[];
}
let lastPlanWarnings: PiPlanWarnings = { skipped: [] };
export function getPiPlanWarnings(): PiPlanWarnings {
  return lastPlanWarnings;
}
