// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listDirectories } from '../src/daemon/workspace.js';

/**
 * Workspace directory listing (Phase 9 W6): directories only (symlinks
 * excluded — Dirent.isDirectory is false for them), hidden entries skipped,
 * name-sorted, capped at 512.
 */
describe('listDirectories (9 W6)', () => {
  it('lists only visible directories, sorted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hnx-ws-'));
    await mkdir(join(root, 'beta'));
    await mkdir(join(root, 'alpha'));
    await mkdir(join(root, '.hidden'));
    await writeFile(join(root, 'file.txt'), 'not a dir');
    await symlink(join(root, 'alpha'), join(root, 'linked'));

    const dirs = await listDirectories(root);
    expect(dirs.map((d) => d.name)).toEqual(['alpha', 'beta']);
    expect(dirs[0]!.path).toBe(join(root, 'alpha'));
  });

  it('is empty for a flat directory and rejects missing paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hnx-ws-'));
    await writeFile(join(root, 'only.txt'), 'x');
    expect(await listDirectories(root)).toEqual([]);
    await expect(listDirectories(join(root, 'nope'))).rejects.toBeTruthy();
  });
});
