// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * Codex target adapter (Phase 8 C2 — lands here as the "trivial case" of the
 * stdio shim unification; absorbs roadmap 3.6).
 *
 * Codex layout (ground truth: `wiki research-phase-3-ecc-install-patterns.md`
 * § "Codex — concrete format"):
 *   A. skills      → `~/.codex/skills/<name>/SKILL.md` (+ bundle files)
 *   B. commands    → `~/.codex/prompts/<name>.md` (YAML frontmatter stripped)
 *   C. MCP         → TOML `~/.codex/config.toml` `[mcp_servers.*]` sections —
 *                    **stdio-only** (Codex refuses `url` keys), which is exactly
 *                    what the `hnx mcp serve` shim entry is.
 *
 * Deferred (unverified home-install shapes): rules (Codex wants AGENTS.md at a
 * PROJECT root; a global write is not established), sub_agents, hooks — all
 * surface as skipped warnings.
 *
 * The TOML merge is add/overwrite-only text surgery (like ECC's
 * merge-mcp-config.js): our `[mcp_servers.harness-nexus-<slug>]` section is
 * replaced idempotently; every other byte of the user's config is preserved.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createTargetAdapter } from '../adapter-factory.js';
import { hnxExecutablePath } from '../../config.js';
import type { Operation, ResolvedArtifact, ResolvedProfile, TargetAdapter } from '../types.js';

/** The install-state ledger filename inside the Codex home. */
const INSTALL_STATE_FILENAME = 'harness-nexus-install-state.json';

/** A resource kind this adapter cannot emit (yet). */
const SKIPPED_KINDS = new Set(['rule', 'sub_agent', 'hook']);

const SKIP_REASONS: Record<string, string> = {
  rule: 'Codex rules live in a project-root AGENTS.md — global install shape unverified',
  sub_agent: 'Codex has no file-based sub-agent format',
  hook: 'Codex has no declarative hooks format',
};

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'harness-nexus-profile'
  );
}

// ---- TOML text surgery (no TOML parser dependency — our payload is plain) ----

/** JSON string escaping is valid TOML basic-string escaping for our charset. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Replace (or append) one `[section]` in a TOML document, preserving every
 * other line. Re-running with the same section is idempotent — an overwrite,
 * unlike ECC's strictly add-only merge, matching our "plans are idempotent
 * overwrites" upgrade semantics.
 */
export function mergeTomlSection(existing: string, section: string, body: string): string {
  const headerRe = /^\s*\[[^\]]+\]\s*$/;
  const target = `[${section}]`;
  const kept: string[] = [];
  let skipping = false;
  for (const line of existing.split('\n')) {
    if (headerRe.test(line)) skipping = line.trim() === target;
    if (!skipping) kept.push(line);
  }
  const base = kept.join('\n').replace(/\s+$/, '');
  return `${base}${base.length > 0 ? '\n\n' : ''}${target}\n${body}`;
}

/** Serialize the shim entry's `[mcp_servers.<key>]` body. */
function shimSectionBody(resolved: ResolvedProfile, serverBase: string): string {
  const args = ['mcp', 'serve', '--profile', resolved.profile.id, '--server', serverBase];
  return [
    `command = ${tomlString(hnxExecutablePath())}`,
    `args = [${args.map(tomlString).join(', ')}]`,
  ].join('\n');
}

/** Strip a leading YAML frontmatter block (Codex prompts are plain markdown). */
function stripFrontmatter(content: string): string {
  if (!content.startsWith('---\n')) return content;
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return content;
  return content.slice(end + 5);
}

/** Extract a Resource's inline file set (same policy as the Hermes adapter). */
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

export const codexAdapter: TargetAdapter = createTargetAdapter({
  id: 'codex-home',
  target: 'codex',
  kind: 'home',
  rootSegments: ['.codex'],

  planOperations(resolved, input, adapter) {
    const root = adapter.resolveRoot(input);
    const slug = slugify(resolved.profile.name);
    const operations: Operation[] = [];
    const skipped: string[] = [];

    // ---- A. skills → ~/.codex/skills/<name>/ ----
    for (const a of resolved.artifacts) {
      if (a.kind !== 'skill') continue;
      const files = resourceFiles(a);
      if (files.length === 0) {
        skipped.push(`skill:${a.resource.key} (non-inline source not fetchable by CLI)`);
        continue;
      }
      for (const f of files) {
        operations.push({
          kind: 'write-file',
          content: f.content,
          destinationPath: path.join(root, 'skills', a.resource.name, f.relativePath),
        });
      }
    }

    // ---- B. commands → ~/.codex/prompts/<name>.md ----
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
        content: stripFrontmatter(content),
        destinationPath: path.join(root, 'prompts', `${a.resource.name}.md`),
      });
    }

    // ---- C. MCP → config.toml [mcp_servers.harness-nexus-<slug>] ----
    const serverBase = process.env.HN_SERVER ?? 'https://harness-nexus.example.com';
    const hasMcp = resolved.artifacts.some((a) => a.kind === 'mcp');
    let needsHnx = false;
    if (hasMcp) {
      const cfgPath = path.join(root, 'config.toml');
      const existing = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : '';
      const merged = mergeTomlSection(
        existing,
        `mcp_servers.harness-nexus-${slug}`,
        shimSectionBody(resolved, serverBase),
      );
      operations.push({ kind: 'write-file', content: merged, destinationPath: cfgPath });
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

/** Warnings from the most recent codex plan (read by the CLI for output). */
export interface CodexPlanWarnings {
  skipped: string[];
  needsHnx: boolean;
}
let lastPlanWarnings: CodexPlanWarnings = { skipped: [], needsHnx: false };
export function getCodexPlanWarnings(): CodexPlanWarnings {
  return lastPlanWarnings;
}
