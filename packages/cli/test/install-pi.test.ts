// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Profile, Resource } from '@harness-nexus/core';
import { planInstall } from '../src/install/planner.js';
import { ensurePiFrontmatter, getPiPlanWarnings } from '../src/install/adapters/pi.js';
import type { ResolvedProfile } from '../src/install/types.js';

/**
 * pi adapter tests (Phase 9 W16). Ground truth:
 * wiki research-phase-9-w16-pi-agent.md §7 — skills are Agent Skills with
 * REQUIRED name+description frontmatter under skills/<name>/, commands are
 * prompt templates under prompts/<name>.md (filename = /name), and
 * mcp/sub_agent/hook/rule have no declarative surface (skipped with reasons).
 */

const NOW = '2026-09-17T00:00:00.000Z';

function profile(): Profile {
  return {
    id: 'p-pi',
    name: 'My pi Kit',
    version: '1.0.0',
    target: 'pi',
    scope: 'personal',
    ownerId: 'u1',
    entries: [],
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
    targets: ['pi'],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function resolvedWith(artifacts: ResolvedProfile['artifacts']): ResolvedProfile {
  return { profile: profile(), artifacts };
}

let tmp: string;
afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('ensurePiFrontmatter', () => {
  it('synthesizes frontmatter for plain markdown', () => {
    const out = ensurePiFrontmatter('# Just a body\n', 'my-skill', 'Does things');
    expect(out).toBe('---\nname: "my-skill"\ndescription: "Does things"\n---\n\n# Just a body\n');
  });

  it('adds only the missing key, keeping user values and other keys', () => {
    const out = ensurePiFrontmatter('---\nname: keep-me\nlicense: MIT\n---\nbody\n', 'slug', 'd');
    expect(out).toBe('---\nname: keep-me\nlicense: MIT\ndescription: "d"\n---\nbody\n');
  });

  it('leaves complete frontmatter byte-identical', () => {
    const fm = '---\nname: ok\ndescription: fine\n---\nbody\n';
    expect(ensurePiFrontmatter(fm, 'slug', 'd')).toBe(fm);
  });
});

describe('pi adapter plan', () => {
  it('plans skills/commands and skips unrepresentable kinds with reasons', () => {
    tmp = mkdtempSync(path.join(tmpdir(), 'hnx-pi-'));
    const out = path.join(tmp, 'home');

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
        kind: 'mcp',
        mcpServer: {
          id: 'm1',
          name: 'github',
          transport: { type: 'stdio', command: 'npx', args: ['-y', 'server-github'] },
          dialSite: 'client',
          scope: 'personal',
          ownerId: 'u1',
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
      {
        entryId: 'e5',
        kind: 'rule',
        resource: resource('rule', 'rules-1', { type: 'inline', content: 'be nice\n' }),
      },
      {
        entryId: 'e6',
        kind: 'sub_agent',
        resource: resource('sub_agent', 'reviewer', { type: 'inline', content: 'review\n' }),
      },
    ];

    const plan = planInstall(resolvedWith(artifacts), { input: { outDir: out } });

    expect(plan.adapter.target).toBe('pi');
    expect(plan.targetRoot).toBe(out);
    expect(plan.installStatePath).toBe(path.join(out, 'harness-nexus-install-state.json'));

    const byDest = new Map(plan.operations.map((op) => [op.destinationPath, op]));

    // Skill without frontmatter → synthesized into skills/<kebab>/SKILL.md
    const skillDoc = byDest.get(path.join(out, 'skills', 'doc-helper', 'SKILL.md'));
    expect(skillDoc).toBeDefined();
    expect((skillDoc as { content: string }).content).toBe(
      '---\nname: "doc-helper"\ndescription: "Helps with documents"\n---\n\n# Doc Helper body\n',
    );

    // Bundle: SKILL.md kept verbatim (complete frontmatter), side file rides along
    expect(byDest.get(path.join(out, 'skills', 'bundled', 'SKILL.md'))).toBeDefined();
    expect(byDest.get(path.join(out, 'skills', 'bundled', 'references', 'notes.md'))).toBeDefined();

    // Command → prompts/<kebab>.md, content verbatim (frontmatter is optional for pi)
    const prompt = byDest.get(path.join(out, 'prompts', 'deploy-now.md'));
    expect(prompt).toBeDefined();
    expect((prompt as { content: string }).content).toBe(
      '---\ndescription: deploys\n---\nDeploy it.\n',
    );

    // No MCP ops, no rule/sub_agent ops
    expect([...byDest.keys()].filter((p) => p.includes('mcp'))).toEqual([]);

    const warnings = getPiPlanWarnings();
    expect(warnings.skipped.some((s) => s.startsWith('mcp:'))).toBe(true);
    expect(warnings.skipped.some((s) => s.startsWith('rule:'))).toBe(true);
    expect(warnings.skipped.some((s) => s.startsWith('sub_agent:'))).toBe(true);
    expect(warnings.skipped.some((s) => s.includes('extensions'))).toBe(true);
  });
});
