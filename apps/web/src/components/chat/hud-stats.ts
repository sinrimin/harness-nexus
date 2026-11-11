// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { buildDiffFiles } from './diff-model.js';
import { diffSources } from './tool-meta.js';
import type { FoldState, ToolCallNode } from './fold.js';

/**
 * #124 — edit totals for the session HUD. Walks the loaded transcript's tool
 * rows (and one level of sub-agent rows, which carry their own folds), asks
 * the SAME diff helpers the Edit card uses (`diffSources` → `buildDiffFiles`),
 * and dedupes by path. No syntax highlighting, no rendering: this is a diff
 * walk over at most the history ring (2000 items), cached per tool node so a
 * streamed text delta does not repay it.
 *
 * Scope is HONEST: the transcript is paged (HISTORY_SYNC_MAX), so the numbers
 * describe the loaded transcript, not necessarily the whole native session.
 * `pathless` marks hunk items that carried no path: their lines still count,
 * but the file count is a lower bound.
 */

export interface HudEditFile {
  path: string;
  added: number;
  removed: number;
}

export interface HudEditStats {
  /** Distinct paths with a known path. */
  files: number;
  added: number;
  removed: number;
  /** A diff item without a path contributed lines (file count is partial). */
  pathless: boolean;
  /** Per-path totals, largest change first. */
  list: HudEditFile[];
}

interface Contribution {
  path: string;
  added: number;
  removed: number;
}

/**
 * Keyed by the ToolCallNode object: the fold creates a new node on every tool
 * patch and leaves untouched nodes in place, so the cache invalidates exactly
 * the row that changed.
 */
const contributionCache = new WeakMap<ToolCallNode, Contribution[]>();

function contributionsFor(node: ToolCallNode): Contribution[] {
  const cached = contributionCache.get(node);
  if (cached !== undefined) return cached;
  const sources = diffSources(node);
  const out: Contribution[] = [];
  if (sources !== null) {
    for (const file of buildDiffFiles(sources)) {
      if (file.added === 0 && file.removed === 0) continue;
      out.push({ path: file.path, added: file.added, removed: file.removed });
    }
  }
  contributionCache.set(node, out);
  return out;
}

/**
 * Aggregate the loaded transcript's edit-class tool calls. Returns null when
 * nothing was edited (the HUD hides the FILES cell), never a zeroed row.
 */
export function sessionEditStats(rows: FoldState['rows']): HudEditStats | null {
  const byPath = new Map<string, HudEditFile>();
  let added = 0;
  let removed = 0;
  let pathless = false;
  let sawEdit = false;

  const visit = (list: FoldState['rows']): void => {
    for (const row of list) {
      if (row.row === 'tool') {
        const contributions = contributionsFor(row.root);
        if (contributions.length === 0) continue;
        sawEdit = true;
        for (const c of contributions) {
          added += c.added;
          removed += c.removed;
          if (c.path === '') {
            pathless = true;
            continue;
          }
          const entry = byPath.get(c.path);
          if (entry === undefined) {
            byPath.set(c.path, { path: c.path, added: c.added, removed: c.removed });
          } else {
            entry.added += c.added;
            entry.removed += c.removed;
          }
        }
      } else if (row.row === 'subagent') {
        // Sub-agent tool calls are part of the session's work. One level is
        // all the fold produces (children do not nest further).
        visit(row.agent.fold.rows);
      }
    }
  };
  visit(rows);

  if (!sawEdit) return null;
  const list = [...byPath.values()].sort(
    (a, b) => b.added + b.removed - (a.added + a.removed) || a.path.localeCompare(b.path),
  );
  return { files: list.length, added, removed, pathless, list };
}

/**
 * #128 — tool-call totals for the ASSISTANT HUD's fourth slot: the assistant
 * edits no files, but its tool calls (notes, dispatch, decision records, API
 * tools, …) are the session's work product. Walks the same rows as
 * `sessionEditStats` (tool rows + one level of sub-agent folds), counts every
 * call and groups by tool name for the tooltip. Null when nothing ran (the
 * TOOLS cell hides) — never a zeroed row.
 */
export interface HudToolStat {
  name: string;
  n: number;
}

export interface HudToolCalls {
  count: number;
  /** Per-tool totals, most-called first (the tooltip shows the top 5). */
  list: HudToolStat[];
}

export function sessionToolCallStats(rows: FoldState['rows']): HudToolCalls | null {
  const byName = new Map<string, number>();
  let count = 0;
  const visit = (list: FoldState['rows']): void => {
    for (const row of list) {
      if (row.row === 'tool') {
        count += 1;
        const name = row.root.toolName ?? row.root.title ?? row.root.kind ?? '?';
        byName.set(name, (byName.get(name) ?? 0) + 1);
      } else if (row.row === 'subagent') {
        visit(row.agent.fold.rows);
      }
    }
  };
  visit(rows);
  if (count === 0) return null;
  const list = [...byName.entries()]
    .map(([name, n]) => ({ name, n }))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  return { count, list };
}
