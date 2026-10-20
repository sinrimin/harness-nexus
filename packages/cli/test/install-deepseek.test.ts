// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { McpServer, Profile, Resource } from '@harness-nexus/core';
import { planInstall } from '../src/install/planner.js';
import { getAdapter } from '../src/install/registry.js';
import {
  ensureDshFrontmatter,
  getDeepseekPlanWarnings,
  managedPatchBlock,
  mergeManagedPatchRegion,
} from '../src/install/adapters/deepseek.js';
import type { ResolvedProfile } from '../src/install/types.js';

/**
 * DeepSeek Harness adapter tests (Phase 8 T1). Ground truth:
 * wiki research-phase-8-t1-deepseek-harness.md — skills need mandatory
 * frontmatter, commands are flat skills, MCP is a managed home-patch region.
 */

const NOW = '2026-09-07T00:00:00.000Z';

function profile(entries: Profile['entries']): Profile {
  return {
    id: 'p-dsh',
    name: 'My DSH Kit',
    version: '1.0.0',
    target: 'deepseek',
    scope: 'personal',
    ownerId: 'u1',
    entries,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function resource(
  kind: Resource['kind'],
  name: string,
  source: Resource['source'],
  description?: string,
): Resource {
  return {
    id: `r-${name}`,
    key: `${kind}:${name}`,
    kind,
    name,
    ...(description !== undefined ? { description } : {}),
    version: '1.0.0',
    source,
    scope: 'personal',
    ownerId: 'u1',
    targets: ['deepseek'],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const mcpServer: McpServer = {
  id: 'm1',
  name: 'github',
  transport: { type: 'stdio', command: 'npx', args: ['-y', 'server-github'] },
  dialSite: 'client',
  scope: 'personal',
  ownerId: 'u1',
  createdAt: NOW,
  updatedAt: NOW,
};

function resolvedWith(artifacts: ResolvedProfile['artifacts']): ResolvedProfile {
  return { profile: profile([]), artifacts };
}

let tmp: string;
afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('ensureDshFrontmatter', () => {
  it('synthesizes frontmatter for plain markdown', () => {
    const out = ensureDshFrontmatter('# Just a body\n', 'my-skill', 'Does things');
    expect(out).toBe('---\nname: my-skill\ndescription: "Does things"\n---\n\n# Just a body\n');
  });

  it('adds missing name and description without touching other keys', () => {
    const out = ensureDshFrontmatter(
      '---\nwhenToUse: coding tasks\nlicense: MIT\n---\nbody\n',
      'slug-a',
      'desc',
    );
    expect(out).toBe(
      '---\nname: slug-a\ndescription: "desc"\nwhenToUse: coding tasks\nlicense: MIT\n---\nbody\n',
    );
  });

  it('corrects a non-kebab name and an empty description, keeping a valid one', () => {
    const out = ensureDshFrontmatter(
      '---\nname: My Skill\ndescription:\n---\nbody\n',
      'fixed-slug',
      'fallback',
    );
    expect(out).toBe('---\nname: fixed-slug\ndescription: "fallback"\n---\nbody\n');
  });

  it('leaves valid frontmatter byte-identical (block indicators count as present)', () => {
    const fm = '---\nname: ok-skill\ndescription: >-\n  folded text\n---\nbody\n';
    expect(ensureDshFrontmatter(fm, 'slug', 'd')).toBe(fm);
  });
});

describe('mergeManagedPatchRegion', () => {
  it('appends into an empty patch', () => {
    expect(mergeManagedPatchRegion('', 'kit', 'BLOCK')).toBe('BLOCK\n');
  });

  it('replaces only its own region across re-plans and preserves everything else', () => {
    const user = '# user note\n- id: system-prompt\n  config:\n    persona: x\n';
    // blocks as managedPatchBlock emits them: markers included
    const mk = (slug: string, body: string): string =>
      `# BEGIN harness-nexus:${slug} (managed)\n${body}\n# END harness-nexus:${slug} (managed)`;
    const other = mergeManagedPatchRegion(user, 'other-kit', mk('other-kit', 'OLD-OTHER'));
    const once = mergeManagedPatchRegion(other, 'kit', mk('kit', 'OLD-KIT'));
    const twice = mergeManagedPatchRegion(once, 'kit', mk('kit', 'NEW-KIT'));
    expect(twice).toContain('NEW-KIT');
    expect(twice).not.toContain('OLD-KIT');
    expect(twice).toContain('OLD-OTHER'); // other profile's region untouched
    expect(twice).toContain('# user note');
    expect(twice).toContain('persona: x');
    // idempotent: planning again with identical content is stable
    expect(mergeManagedPatchRegion(twice, 'kit', mk('kit', 'NEW-KIT'))).toBe(twice);
  });
});

describe('managedPatchBlock', () => {
  it('emits a dsh-mcp-client stdio row with a constrained serverName', () => {
    const block = managedPatchBlock(resolvedWith([]), 'https://hn.example.com');
    expect(block).toContain("name: '@deepseek-ai/dsh-mcp-client'");
    expect(block).toContain('serverName: harness-nexus-my-dsh-kit');
    expect(block).toMatch(/serverName: [A-Za-z0-9_-]{1,32}$/m);
    expect(block).toContain('"--profile", "p-dsh"');
    expect(block).toContain('"--server", "https://hn.example.com"');
  });

  it('caps very long slugs to the 32-char serverName limit', () => {
    const long = resolvedWith([]);
    long.profile = { ...long.profile, name: 'a'.repeat(80) };
    const block = managedPatchBlock(long, 'https://x');
    const sn = /serverName: (\S+)/.exec(block)![1]!;
    expect(sn.length).toBeLessThanOrEqual(32);
    expect(sn).toBe('harness-nexus-aaaaaaaaaaaaaaaaaa');
  });
});

describe('deepseek adapter plan', () => {
  it('plans skills/commands/mcp and skips unrepresentable kinds', () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'hnx-dsh-'));
    const out = path.join(tmp, 'home');
    process.env.HN_SERVER = 'https://hn.example.com';
    process.env.HNX_BIN = '/usr/local/bin/hnx';

    const artifacts: ResolvedProfile['artifacts'] = [
      {
        entryId: 'e1',
        kind: 'skill',
        resource: resource(
          'skill',
          'Doc Helper',
          { type: 'inline', content: '# Doc Helper body\n' },
          'Helps with documents',
        ),
      },
      {
        entryId: 'e2',
        kind: 'skill',
        resource: resource(
          'skill',
          'bundled',
          {
            type: 'inline-bundle',
            files: {
              'SKILL.md': '---\nname: bundled\ndescription: ok\n---\nbundled body\n',
              'references/notes.md': 'notes\n',
            },
          },
          'Multi file',
        ),
      },
      {
        entryId: 'e3',
        kind: 'command',
        resource: resource(
          'command',
          'Deploy Now',
          { type: 'inline', content: '---\ndescription: deploys\n---\nDeploy it.\n' },
          'Deploy helper',
        ),
      },
      {
        entryId: 'e4',
        kind: 'rule',
        resource: resource('rule', 'rules-1', { type: 'inline', content: 'be nice\n' }),
      },
      { entryId: 'e5', kind: 'mcp', mcpServer },
    ];

    const plan = planInstall(resolvedWith(artifacts), { input: { outDir: out } });

    expect(plan.adapter.target).toBe('deepseek');
    expect(plan.targetRoot).toBe(out);
    expect(plan.installStatePath).toBe(path.join(out, 'harness-nexus-install-state.json'));

    const byDest = new Map(plan.operations.map((op) => [op.destinationPath, op]));

    // skill without frontmatter gets synthesized (kebab dir name from the name)
    const inlineSkill = byDest.get(path.join(out, 'skills', 'doc-helper', 'SKILL.md')) as
      { kind: string; content: string } | undefined;
    expect(inlineSkill).toBeDefined();
    expect(inlineSkill!.content).toBe(
      '---\nname: doc-helper\ndescription: "Helps with documents"\n---\n\n# Doc Helper body\n',
    );

    // bundle: SKILL.md kept as-is (already valid), siblings copied verbatim
    expect(byDest.get(path.join(out, 'skills', 'bundled', 'SKILL.md'))).toBeDefined();
    expect(byDest.get(path.join(out, 'skills', 'bundled', 'references', 'notes.md'))).toBeDefined();

    // command → flat skill file, frontmatter completed (not stripped)
    const cmd = byDest.get(path.join(out, 'skills', 'deploy-now.md')) as
      { kind: string; content: string } | undefined;
    expect(cmd).toBeDefined();
    expect(cmd!.content).toBe('---\nname: deploy-now\ndescription: deploys\n---\nDeploy it.\n');

    // mcp → home patch managed region
    const patch = byDest.get(path.join(out, 'cordis.patch.yml')) as
      { kind: string; content: string } | undefined;
    expect(patch).toBeDefined();
    expect(patch!.content).toContain("name: '@deepseek-ai/dsh-mcp-client'");
    expect(patch!.content).toContain('"/usr/local/bin/hnx"');

    // rule skipped with a reason; needsHnx flagged
    const w = getDeepseekPlanWarnings();
    expect(w.needsHnx).toBe(true);
    expect(w.skipped.some((s) => s.startsWith('rule:'))).toBe(true);

    delete process.env.HN_SERVER;
    delete process.env.HNX_BIN;
  });

  it('merges into an existing user patch without disturbing it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hnx-dsh-2-'));
    const out = path.join(dir, 'home');
    const existing = '- id: system-prompt\n  config:\n    persona: keep me\n';
    process.env.HN_SERVER = 'https://hn.example.com';
    // pre-create the target home with a user patch (plan reads it)
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, 'cordis.patch.yml'), existing, 'utf8');

    const plan = planInstall(resolvedWith([{ entryId: 'e1', kind: 'mcp', mcpServer }]), {
      input: { outDir: out },
    });
    const patchOp = plan.operations.find(
      (op) => op.destinationPath === path.join(out, 'cordis.patch.yml'),
    ) as { kind: string; content: string };
    expect(patchOp.content).toContain('persona: keep me');
    expect(patchOp.content).toContain('harness-nexus-my-dsh-kit');
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HN_SERVER;
  });

  it('registers in the adapter registry (install no longer 409s)', () => {
    expect(getAdapter('deepseek').target).toBe('deepseek');
  });
});
