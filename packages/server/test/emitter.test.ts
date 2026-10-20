// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { createMemoryUnitOfWork } from '../src/infra/storage/memory/index.js';
import { MarketplaceEmitter, marketplaceNameFor } from '../src/marketplace/emitter.js';

/** Seed a user + one claude-code profile with mixed entries; return helpers. */
async function seed(uow: ReturnType<typeof createMemoryUnitOfWork>) {
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
    id: 'r-skill',
    key: 'greeter',
    kind: 'skill',
    name: 'Greeter',
    description: 'Greets.',
    version: '1.0.0',
    source: { type: 'inline', content: '---\nname: greeter\n---\n\nhi' },
    scope: 'personal',
    ownerId: 'u1',
    targets: ['claude-code'],
    createdAt: now,
    updatedAt: now,
  });
  await uow.resources.save({
    id: 'r-rule',
    key: 'style',
    kind: 'rule',
    name: 'Style',
    description: 'Conventions.',
    version: '1.0.0',
    source: { type: 'inline', content: 'Use tabs.' },
    scope: 'personal',
    ownerId: 'u1',
    targets: ['claude-code'],
    createdAt: now,
    updatedAt: now,
  });
  await uow.resources.save({
    id: 'r-hook',
    key: 'notify',
    kind: 'hook',
    name: 'Notify',
    description: 'Notify.',
    version: '1.0.0',
    source: {
      type: 'inline',
      content: JSON.stringify({
        hooks: {
          PostToolUse: [{ hooks: [{ type: 'command', command: 'echo ok' }] }],
          // An event claude-code does not support — must be dropped.
          NotARealEvent: [{ hooks: [{ type: 'command', command: 'echo no' }] }],
        },
      }),
    },
    scope: 'personal',
    ownerId: 'u1',
    targets: ['claude-code'],
    createdAt: now,
    updatedAt: now,
  });
  await uow.mcpServers.save({
    id: 'm1',
    name: 'Upstream One',
    transport: { type: 'streamable-http', url: 'https://up.example/mcp' },
    dialSite: 'auto',
    scope: 'personal',
    ownerId: 'u1',
    createdAt: now,
    updatedAt: now,
  });
  await uow.profiles.save({
    id: 'p1',
    name: 'Daily Bundle',
    version: '2.1.0',
    target: 'claude-code',
    scope: 'personal',
    ownerId: 'u1',
    entries: [
      { resourceId: 'm1', kind: 'mcp' },
      { resourceId: 'r-skill', kind: 'skill' },
      { resourceId: 'r-rule', kind: 'rule' },
      { resourceId: 'r-hook', kind: 'hook' },
    ],
    createdAt: now,
    updatedAt: now,
  });
  // A hermes-target profile must NOT appear in the catalog.
  await uow.profiles.save({
    id: 'p2',
    name: 'Hermes Bundle',
    version: '1.0.0',
    target: 'hermes',
    scope: 'personal',
    ownerId: 'u1',
    entries: [],
    createdAt: now,
    updatedAt: now,
  });
  return uow;
}

function makeEmitter() {
  const uow = createMemoryUnitOfWork();
  return {
    uow,
    emitter: new MarketplaceEmitter({
      uow,
      publicBaseUrl: 'https://hn.example',
      logger: fakeLogger,
    }),
  };
}

const fakeLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;

describe('marketplaceNameFor', () => {
  it('sanitizes usernames into a unique per-user marketplace name', () => {
    expect(marketplaceNameFor('alice')).toBe('harness-nexus-alice');
    expect(marketplaceNameFor('Weird.Name-1')).toBe('harness-nexus-weird-name-1');
  });
});

describe('MarketplaceEmitter.buildCatalog', () => {
  it('lists only claude-code profiles visible to the user, archive-sourced', async () => {
    const { uow, emitter } = makeEmitter();
    await seed(uow);
    const catalog = (await emitter.buildCatalog('u1', 'tester', 'hnpat_x')) as {
      name: string;
      plugins: { name: string; version: string; source: { source: string; url: string } }[];
    };
    expect(catalog.name).toBe('harness-nexus-tester');
    expect(catalog.plugins).toHaveLength(1);
    expect(catalog.plugins[0].name).toBe('daily-bundle');
    expect(catalog.plugins[0].version).toBe('2.1.0');
    expect(catalog.plugins[0].source.source).toBe('archive');
    expect(catalog.plugins[0].source.url).toBe(
      'https://hn.example/api/marketplace/hnpat_x/archives/p1.zip',
    );
  });

  it('shows nothing for a user with no profiles', async () => {
    const { uow, emitter } = makeEmitter();
    await seed(uow);
    const catalog = (await emitter.buildCatalog('nobody', 'nobody', 'hnpat_x')) as {
      plugins: unknown[];
    };
    expect(catalog.plugins).toHaveLength(0);
  });
});

describe('MarketplaceEmitter.buildPluginZip', () => {
  it('emits the claude-native layout with MCP, skills, wrapped rules, filtered hooks', async () => {
    const { uow, emitter } = makeEmitter();
    await seed(uow);
    const profile = (await uow.profiles.findById('p1'))!;
    const zip = await JSZip.loadAsync(await emitter.buildPluginZip(profile));

    const names = Object.keys(zip.files);
    expect(names).toContain('daily-bundle/.claude-plugin/plugin.json');
    expect(names).toContain('daily-bundle/.mcp.json');
    expect(names).toContain('daily-bundle/skills/greeter/SKILL.md');
    expect(names).toContain('daily-bundle/skills/style/SKILL.md');
    expect(names).toContain('daily-bundle/hooks/hooks.json');

    const mcp = JSON.parse(await zip.file('daily-bundle/.mcp.json')!.async('string'));
    // C2 default (emitMode 'client'): ONE stdio shim entry — no PAT env var,
    // no inlined credentials.
    expect(mcp.mcpServers['harness-nexus'].type).toBe('stdio');
    expect(mcp.mcpServers['harness-nexus'].command).toBe('hnx');
    expect(mcp.mcpServers['harness-nexus'].args).toEqual([
      'mcp',
      'serve',
      '--profile',
      'p1',
      '--server',
      'https://hn.example',
    ]);

    const rule = await zip.file('daily-bundle/skills/style/SKILL.md')!.async('string');
    expect(rule.startsWith('---\nname: style\ndescription: Rules: Conventions.\n---')).toBe(true);

    const hooks = JSON.parse(await zip.file('daily-bundle/hooks/hooks.json')!.async('string'));
    expect(Object.keys(hooks.hooks)).toEqual(['PostToolUse']);

    const plugin = JSON.parse(
      await zip.file('daily-bundle/.claude-plugin/plugin.json')!.async('string'),
    );
    expect(plugin.name).toBe('daily-bundle');
    expect(plugin.version).toBe('2.1.0');
    // Emission limitations ride the description (the only post-install channel).
    expect(plugin.description).toContain('hnx client');
    expect(plugin.description).toContain('hook event(s)');
  });

  it("emitMode 'server' keeps the pre-C2 output (the no-hnx fallback)", async () => {
    const uow = createMemoryUnitOfWork();
    const emitter = new MarketplaceEmitter({
      uow,
      publicBaseUrl: 'https://hn.example',
      logger: fakeLogger,
      emitMode: 'server',
    });
    await seed(uow);
    const profile = (await uow.profiles.findById('p1'))!;
    const zip = await JSZip.loadAsync(await emitter.buildPluginZip(profile));

    const mcp = JSON.parse(await zip.file('daily-bundle/.mcp.json')!.async('string'));
    expect(mcp.mcpServers['harness-nexus'].url).toBe('https://hn.example/mcp?profile=p1');
    expect(mcp.mcpServers['harness-nexus'].headers.Authorization).toBe(
      'Bearer ${HN_PAT_DAILY_BUNDLE}',
    );
  });
});
