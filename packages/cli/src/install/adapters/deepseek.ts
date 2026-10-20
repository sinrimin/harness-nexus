// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * DeepSeek Harness (dsh) target adapter (Phase 8 T1).
 *
 * dsh layout (ground truth: `wiki research-phase-8-t1-deepseek-harness.md`,
 * pinned to dsh v0.1.2-rc.1):
 *   A. skills   → `~/.dsh/skills/<name>/SKILL.md` (+ bundle files) — the Agent
 *                 Skills format, but dsh REQUIRES YAML frontmatter
 *                 `name` + `description` (files without it are ignored) and
 *                 kebab-case names `^[a-z0-9]+(?:-[a-z0-9]+)*$`; the adapter
 *                 guarantees both (frontmatter synthesis).
 *   B. commands → flat `~/.dsh/skills/<name>.md` — dsh's slash-command
 *                 surface IS the skill surface (`/name`); frontmatter is kept
 *                 and completed, unlike the Codex adapter which strips it.
 *   C. MCP      → home-level `~/.dsh/cordis.patch.yml` — a managed
 *                 `- insert:` row per profile mounting
 *                 `'@deepseek-ai/dsh-mcp-client'` with the stdio
 *                 `hnx mcp serve` shim. The row sits between per-profile
 *                 marker comments; re-planning replaces only THIS profile's
 *                 marked region (idempotent overwrite — other profiles'
 *                 regions and user rows stay byte-for-byte), and dsh
 *                 hot-reloads the home patch without a restart.
 *
 * Deferred (no verified declarative shape — see research): rules (the dsh
 * persona is a config row; overwriting a user's is destructive), sub_agents
 * (programmatic provider registry), hooks (CC/Codex bridges are opt-in
 * packages) — all surface as skipped warnings.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createTargetAdapter } from '../adapter-factory.js';
import { hnxExecutablePath } from '../../config.js';
import type { Operation, ResolvedArtifact, ResolvedProfile, TargetAdapter } from '../types.js';

/** The install-state ledger filename inside the dsh home. */
const INSTALL_STATE_FILENAME = 'harness-nexus-install-state.json';

/** dsh home patch file — applied to EVERY profile and hot-reloaded live. */
const PATCH_FILENAME = 'cordis.patch.yml';

/** dsh `serverName` constraint: `[A-Za-z0-9_-]{1,32}`. */
const MAX_SERVER_NAME = 32;
const SERVER_NAME_PREFIX = 'harness-nexus';

/** A resource kind this adapter cannot emit (yet). */
const SKIPPED_KINDS = new Set(['rule', 'sub_agent', 'hook']);

const SKIP_REASONS: Record<string, string> = {
  rule: 'dsh has no user-scope rules file — the persona is a config row hnx will not overwrite',
  sub_agent: 'dsh sub-agents are programmatic providers, not files',
  hook: 'dsh hook bridges are opt-in per-profile packages an install cannot wire',
};

/** dsh skill names are kebab-case `^[a-z0-9]+(?:-[a-z0-9]+)*$`. */
const KEBAB_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 64);
  return slug === '' ? 'harness-nexus' : slug;
}

/** Cap a `harness-nexus-<slug>` server name to dsh's 32-char constraint. */
function serverNameFor(slug: string): string {
  return `${SERVER_NAME_PREFIX}-${slug}`.slice(0, MAX_SERVER_NAME);
}

// ---- frontmatter (dsh ignores skill files without name + description) ----

function splitFrontmatter(content: string): { lines: string[]; body: string } | null {
  const lines = content.split('\n');
  if (lines[0] === undefined || lines[0]!.trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) return null;
  return { lines: lines.slice(1, end), body: lines.slice(end + 1).join('\n') };
}

/** Value of a `key: value` scalar line, surrounding quotes stripped. */
function scalarValue(line: string, key: string): string {
  const v = line.slice(key.length + 1).trim();
  return v.replace(/^['"]|['"]$/g, '');
}

/**
 * Guarantee the frontmatter dsh requires. Existing frontmatter lines are kept
 * verbatim (dsh tolerates extra metadata keys); only `name` (must be kebab)
 * and `description` (non-empty) are completed or corrected. JSON string
 * quoting is valid YAML 1.2 double-quoting — the escape hatch for arbitrary
 * description text.
 */
export function ensureDshFrontmatter(content: string, slug: string, description: string): string {
  const fallback = JSON.stringify(description.trim().split('\n')[0] || slug);
  const fm = splitFrontmatter(content);
  if (fm === null) {
    return `---\nname: ${slug}\ndescription: ${fallback}\n---\n\n${content}`;
  }
  const lines = [...fm.lines];

  const nameIdx = lines.findIndex((l) => /^name:/.test(l));
  if (nameIdx === -1) {
    lines.unshift(`name: ${slug}`);
  } else if (!KEBAB_NAME.test(scalarValue(lines[nameIdx]!, 'name'))) {
    lines[nameIdx] = `name: ${slug}`;
  }

  const descIdx = lines.findIndex((l) => /^description:/.test(l));
  if (descIdx === -1) {
    const afterName = lines.findIndex((l) => /^name:/.test(l)) + 1;
    lines.splice(afterName, 0, `description: ${fallback}`);
  } else if (scalarValue(lines[descIdx]!, 'description') === '') {
    // Block indicators (`>-`, `|`) count as present — only truly empty loses.
    lines[descIdx] = `description: ${fallback}`;
  }

  return `---\n${lines.join('\n')}\n---\n${fm.body}`;
}

// ---- cordis patch surgery (per-profile managed region, no YAML parser) ----

/** dsh home patch file — applied to EVERY profile and hot-reloaded live. */
export const DSH_PATCH_FILENAME = PATCH_FILENAME;

export const beginMarker = (slug: string): string => `# BEGIN harness-nexus:${slug} (managed)`;
export const endMarker = (slug: string): string => `# END harness-nexus:${slug} (managed)`;

/**
 * Replace (or append) this profile's managed region in the home patch,
 * preserving every other byte — including other profiles' regions. Re-running
 * with the same slug is idempotent, matching "plans are idempotent
 * overwrites" upgrade semantics.
 */
export function mergeManagedPatchRegion(existing: string, slug: string, block: string): string {
  const begin = beginMarker(slug);
  const end = endMarker(slug);
  let base = existing;
  const b = base.indexOf(begin);
  if (b !== -1) {
    const e = base.indexOf(end, b);
    if (e !== -1) {
      base = base.slice(0, b) + base.slice(e + end.length).replace(/^\n+/, '');
    }
  }
  base = base.replace(/\s+$/, '');
  return `${base}${base.length > 0 ? '\n\n' : ''}${block}\n`;
}

/** Serialize this profile's `- insert:` block for the home patch. */
export function managedPatchBlock(resolved: ResolvedProfile, serverBase: string): string {
  const slug = slugify(resolved.profile.name);
  const args = ['mcp', 'serve', '--profile', resolved.profile.id, '--server', serverBase];
  return [
    `${beginMarker(slug)} — rewritten by hnx; keep edits outside the markers`,
    `- insert:`,
    `    - id: hnx-mcp-${slug}`,
    `      name: '@deepseek-ai/dsh-mcp-client'`,
    `      config:`,
    `        serverName: ${serverNameFor(slug)}`,
    `        transport: stdio`,
    `        command: ${JSON.stringify(hnxExecutablePath())}`,
    `        args: [${args.map((a) => JSON.stringify(a)).join(', ')}]`,
    endMarker(slug),
  ].join('\n');
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

export const deepseekAdapter: TargetAdapter = createTargetAdapter({
  id: 'deepseek-home',
  target: 'deepseek',
  kind: 'home',
  rootSegments: ['.dsh'],

  planOperations(resolved, input, adapter) {
    const root = adapter.resolveRoot(input);
    const operations: Operation[] = [];
    const skipped: string[] = [];

    // ---- A. skills → ~/.dsh/skills/<name>/ (+ bundle files) ----
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
            ? ensureDshFrontmatter(f.content, slug, description)
            : f.content;
        operations.push({
          kind: 'write-file',
          content,
          destinationPath: path.join(root, 'skills', slug, f.relativePath),
        });
      }
    }

    // ---- B. commands → flat ~/.dsh/skills/<name>.md (the /name surface) ----
    for (const a of resolved.artifacts) {
      if (a.kind !== 'command') continue;
      const files = resourceFiles(a);
      const content = files[0]?.content;
      if (content === undefined) {
        skipped.push(`command:${a.resource.key} (non-inline source not fetchable by CLI)`);
        continue;
      }
      const slug = slugify(a.resource.name);
      operations.push({
        kind: 'write-file',
        content: ensureDshFrontmatter(content, slug, a.resource.description ?? a.resource.name),
        destinationPath: path.join(root, 'skills', `${slug}.md`),
      });
    }

    // ---- C. MCP → home cordis.patch.yml managed region ----
    const serverBase = process.env.HN_SERVER ?? 'https://harness-nexus.example.com';
    const hasMcp = resolved.artifacts.some((a) => a.kind === 'mcp');
    let needsHnx = false;
    if (hasMcp) {
      const patchPath = path.join(root, PATCH_FILENAME);
      const existing = fs.existsSync(patchPath) ? fs.readFileSync(patchPath, 'utf8') : '';
      const merged = mergeManagedPatchRegion(
        existing,
        slugify(resolved.profile.name),
        managedPatchBlock(resolved, serverBase),
      );
      operations.push({ kind: 'write-file', content: merged, destinationPath: patchPath });
      needsHnx = true;
    }

    // ---- skipped kinds ----
    for (const a of resolved.artifacts) {
      if (a.kind === 'mcp') continue;
      if (SKIPPED_KINDS.has(a.kind)) {
        skipped.push(`${a.kind}:${a.resource.key} (${SKIP_REASONS[a.kind]})`);
      }
    }

    lastPlanWarnings = { skipped, needsHnx };

    return {
      adapter: { id: adapter.id, target: adapter.target, kind: adapter.kind },
      targetRoot: root,
      installStatePath: path.join(root, INSTALL_STATE_FILENAME),
      operations,
      sensitive: false,
    };
  },
});

/** Warnings from the most recent deepseek plan (read by the CLI for output). */
export interface DeepseekPlanWarnings {
  skipped: string[];
  needsHnx: boolean;
}
let lastPlanWarnings: DeepseekPlanWarnings = { skipped: [], needsHnx: false };
export function getDeepseekPlanWarnings(): DeepseekPlanWarnings {
  return lastPlanWarnings;
}
