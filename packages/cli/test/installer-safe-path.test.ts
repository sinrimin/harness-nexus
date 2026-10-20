// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyInstall } from '../src/install/installer.js';
import type { InstallPlan } from '../src/install/types.js';
import { InstallError } from '../src/errors.js';

/**
 * #21 — the installer's containment pre-flight: no operation may write
 * outside the plan's target root, whatever path components a resource name
 * or bundle key smuggled into an adapter's plan.
 */

function plan(root: string, destinationPath: string): InstallPlan {
  return {
    adapter: { id: 'codex', target: 'codex', kind: 'agent' },
    targetRoot: root,
    installStatePath: path.join(root, 'hnx-install-state.json'),
    sensitive: false,
    operations: [{ kind: 'write-file', content: 'evil', destinationPath }],
  };
}

describe('applyInstall containment (#21)', () => {
  it('refuses writes that escape the target root via .. segments', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hnx-safe-'));
    const escape = path.join(root, 'skills', '..', '..', 'hnx-escape-marker.txt');
    expect(() =>
      applyInstall(plan(root, escape), {
        profileId: 'p1',
        profileName: 'P',
        profileVersion: '0.1',
      }),
    ).toThrow(InstallError);
    try {
      applyInstall(plan(root, escape), {
        profileId: 'p1',
        profileName: 'P',
        profileVersion: '0.1',
      });
    } catch (e) {
      expect((e as InstallError).code).toBe('UNSAFE_DESTINATION');
    }
    expect(fs.existsSync(path.resolve(path.dirname(root), 'hnx-escape-marker.txt'))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('refuses absolute destinations outside the root but accepts in-root writes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hnx-safe-'));
    const outside = path.join(os.tmpdir(), 'hnx-abs-escape.txt');
    expect(() =>
      applyInstall(plan(root, outside), {
        profileId: 'p1',
        profileName: 'P',
        profileVersion: '0.1',
      }),
    ).toThrow(InstallError);
    expect(fs.existsSync(outside)).toBe(false);

    applyInstall(plan(root, path.join(root, 'skills', 'fine', 'SKILL.md')), {
      profileId: 'p1',
      profileName: 'P',
      profileVersion: '0.1',
    });
    expect(fs.readFileSync(path.join(root, 'skills', 'fine', 'SKILL.md'), 'utf8')).toBe('evil');
    fs.rmSync(root, { recursive: true, force: true });
  });
});
