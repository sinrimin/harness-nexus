// Unit-test the hermes adapter's plugin-bundle path directly (no server needed).
// Run from repo root: node scripts/test-hermes-adapter.mjs
import fs from 'node:fs';
import path from 'node:path';
import {
  hermesAdapter,
  getHermesPlanWarnings,
} from '../packages/cli/dist/install/adapters/hermes.js';
import { applyInstall } from '../packages/cli/dist/install/installer.js';

const OUT = '/tmp/hnx-hermes-skill-test';
fs.rmSync(OUT, { recursive: true, force: true });

const resolvedProfile = {
  profile: {
    id: 'test-profile-id',
    name: 'My Skill Bundle',
    description: 'Test profile with skills + rules',
    version: '2.1.0',
    target: 'hermes',
    scope: 'personal',
    ownerId: null,
    entries: [
      { resourceId: 'skill-1', kind: 'skill' },
      { resourceId: 'rule-1', kind: 'rule' },
      { resourceId: 'sub-1', kind: 'sub_agent' },
      { resourceId: 'hook-1', kind: 'hook' },
    ],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  artifacts: [
    {
      entryId: 'skill-1',
      kind: 'skill',
      resource: {
        id: 'skill-1',
        key: 'skill:tdd',
        kind: 'skill',
        name: 'tdd-workflow',
        description: 'TDD workflow skill.',
        version: '1.0.0',
        source: {
          type: 'inline',
          content:
            '---\nname: tdd-workflow\ndescription: TDD skill\n---\n\n# TDD\n\nWrite tests first.',
        },
        scope: 'personal',
        ownerId: null,
        targets: ['hermes'],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    },
    {
      entryId: 'skill-2',
      kind: 'skill',
      resource: {
        id: 'skill-2',
        key: 'skill:multi',
        kind: 'skill',
        name: 'multi-file-skill',
        description: 'A multi-file skill.',
        version: '1.0.0',
        source: {
          type: 'inline-bundle',
          files: {
            'SKILL.md': '---\nname: multi-file-skill\ndescription: Multi-file\n---\n\n# Multi',
            'references/guide.md': '# Guide\n\nDetails here.',
            'scripts/helper.py': '# helper',
          },
        },
        scope: 'personal',
        ownerId: null,
        targets: ['hermes'],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    },
    {
      entryId: 'rule-1',
      kind: 'rule',
      resource: {
        id: 'rule-1',
        key: 'rule:core',
        kind: 'rule',
        name: 'core-rules',
        description: 'Core rules.',
        version: '1.0.0',
        source: { type: 'inline', content: '# Core Rules\n\nAlways write tests.\nUse TypeScript.' },
        scope: 'personal',
        ownerId: null,
        targets: ['hermes'],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    },
    {
      entryId: 'sub-1',
      kind: 'sub_agent',
      resource: {
        id: 'sub-1',
        key: 'sub_agent:reviewer',
        kind: 'sub_agent',
        name: 'reviewer',
        description: 'Code reviewer.',
        version: '1.0.0',
        source: { type: 'inline', content: 'reviewer' },
        scope: 'personal',
        ownerId: null,
        targets: ['hermes'],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    },
    {
      entryId: 'hook-1',
      kind: 'hook',
      resource: {
        id: 'hook-1',
        key: 'hook:precommit',
        kind: 'hook',
        name: 'pre-commit',
        description: 'Pre-commit hook.',
        version: '1.0.0',
        source: { type: 'inline', content: '{}' },
        scope: 'personal',
        ownerId: null,
        targets: ['hermes'],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    },
  ],
};

const plan = hermesAdapter.planOperations(resolvedProfile, { outDir: OUT }, hermesAdapter);
console.log('=== PLAN ===');
console.log('operations:', plan.operations.length, '| sensitive:', plan.sensitive);
console.log(
  plan.operations
    .map((o, i) => `  [${i + 1}] ${o.kind} → ${o.destinationPath.replace(OUT, '~')}`)
    .join('\n'),
);

applyInstall(plan, {
  profileId: 'test-profile-id',
  profileName: 'My Skill Bundle',
  profileVersion: '2.1.0',
});

console.log('\n=== OUTPUT TREE ===');
function walk(dir, prefix = '') {
  if (!fs.existsSync(dir)) return [];
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = prefix + e.name;
    if (e.isDirectory()) out.push(p + '/', ...walk(dir + '/' + e.name, p + '/'));
    else out.push(p);
  }
  return out;
}
walk(OUT).forEach((f) => console.log('  ' + f));

console.log('\n=== plugin.yaml ===');
console.log(fs.readFileSync(path.join(OUT, 'plugins/my-skill-bundle/plugin.yaml'), 'utf8'));

console.log('=== __init__.py ===');
console.log(fs.readFileSync(path.join(OUT, 'plugins/my-skill-bundle/__init__.py'), 'utf8'));

console.log('=== AGENTS.md (rules) ===');
console.log(fs.readFileSync(path.join(OUT, 'AGENTS.md'), 'utf8'));

const w = getHermesPlanWarnings();
console.log('=== skipped warnings ===');
w.skipped.forEach((s) => console.log('  - ' + s));
console.log('needsPluginEnable:', w.needsPluginEnable);
console.log('\nDONE');
