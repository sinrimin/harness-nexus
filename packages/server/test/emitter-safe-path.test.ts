// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import { MarketplaceEmitter } from '../src/marketplace/emitter.js';

/**
 * #21 — inline-bundle keys become archive entries; the emitter must never
 * zip a key that could walk out of the plugin directory (zip-slip).
 */

const fakeLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;

describe('MarketplaceEmitter bundle paths (#21)', () => {
  it('drops unsafe inline-bundle entries from the emitted zip', async () => {
    const uow = createMemoryUnitOfWork();
    const now = new Date().toISOString();
    await uow.users.save({
      id: 'u1',
      username: 'tester',
      email: undefined,
      passwordHash: 'x',
      role: 'user',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await uow.resources.save({
      id: 'r-evil',
      key: 'evil',
      kind: 'skill',
      name: 'Evil',
      description: 'Carries an unsafe bundle key.',
      version: '1.0.0',
      // Bypasses the REST route's validator on purpose (a daemon-reported
      // import used to land rows like this) — the emitter must not trust it.
      source: {
        type: 'inline-bundle',
        files: {
          'SKILL.md': '# evil\n',
          '../../escape.txt': 'outside the plugin dir',
          '/abs.txt': 'absolute path',
        },
      },
      scope: 'personal',
      ownerId: 'u1',
      targets: ['claude-code'],
      createdAt: now,
      updatedAt: now,
    });
    await uow.profiles.save({
      id: 'p1',
      name: 'Daily Bundle',
      description: undefined,
      version: '1.0.0',
      target: 'claude-code',
      scope: 'personal',
      ownerId: 'u1',
      entries: [{ resourceId: 'r-evil', kind: 'skill' }],
      createdAt: now,
      updatedAt: now,
    });

    const emitter = new MarketplaceEmitter({
      uow,
      publicBaseUrl: 'https://hn.example',
      logger: fakeLogger,
    });
    const zip = await JSZip.loadAsync(
      await emitter.buildPluginZip((await uow.profiles.findById('p1'))!),
    );
    const names = Object.keys(zip.files);
    expect(names.some((n) => n.includes('..'))).toBe(false);
    expect(names.some((n) => /(^|\/)abs\.txt$/.test(n))).toBe(false);
    expect(names.some((n) => n.endsWith('skills/evil/SKILL.md'))).toBe(true);
    expect(names.some((n) => n.includes('escape.txt'))).toBe(false);
  });
});
