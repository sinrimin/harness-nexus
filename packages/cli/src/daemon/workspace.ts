// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkspaceDirectory, WorkspaceFile } from '@harness-nexus/shared';

/**
 * Workspace directory listing (Phase 9 W6; 9 W9 C adds files) — one level of
 * entries for the chat session picker and the composer's @-reference picker.
 * The server has ALREADY validated containment against the machine's
 * baseWorkspace before emitting `workspace:list`; this module keeps the
 * listing itself honest and bounded: directories and regular files only
 * (symlinks are excluded — `Dirent.isDirectory()` / `isFile()` are false for
 * them), hidden `.*` entries skipped, name-sorted, capped at 512 each.
 */

const MAX_ENTRIES = 512;

export async function listDirectories(path: string): Promise<WorkspaceDirectory[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const out: WorkspaceDirectory[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue; // skips files AND symlinks-to-dirs
    if (entry.name.startsWith('.')) continue;
    out.push({ name: entry.name, path: join(path, entry.name) });
    if (out.length >= MAX_ENTRIES) break;
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** 9 W9 C — regular files at one level, for the @-reference picker. */
export async function listFiles(path: string): Promise<WorkspaceFile[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const out: WorkspaceFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue; // skips dirs AND symlinks-to-files
    if (entry.name.startsWith('.')) continue;
    out.push({ name: entry.name, path: join(path, entry.name) });
    if (out.length >= MAX_ENTRIES) break;
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
