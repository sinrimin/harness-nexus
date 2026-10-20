// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { collectItems, scanAllTargets, scanTarget } from '../src/inventory/scan.js';

let home: string;

function setupHome(): string {
  home = mkdtempSync(path.join(tmpdir(), 'hnx-inventory-'));
  const w = (rel: string, content: string): void => {
    const file = path.join(home, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, 'utf8');
  };

  // ---- claude-code ----
  w(
    '.claude/skills/docx/SKILL.md',
    '---\nname: docx\ndescription: Work with Word documents\n---\n\n# docx\n\nCreate and edit .docx files.\n',
  );
  w('.claude/skills/docx/references/formats.md', 'Format notes.\n');
  w(
    '.claude/commands/deploy.md',
    '---\ndescription: Deploy the app\n---\nDeploy to production carefully.\n',
  );
  w('.claude/agents/reviewer.md', 'You are a code reviewer.\n');
  w('.claude/skills/binary-skill/SKILL.md', 'before\u0000after\n'); // binary sniff
  // ---- claude-code marketplace plugin cache (the 3.5 install path) ----
  w(
    '.claude/plugins/cache/harness-nexus-demo/cc-kit/1.0.0/skills/cc-plugin-skill/SKILL.md',
    '---\nname: cc-plugin-skill\ndescription: from plugin\n---\n\nPlugin skill body.\n',
  );
  w(
    '.claude/plugins/cache/harness-nexus-demo/cc-kit/1.0.0/commands/plug-cmd.md',
    'Plugin command body.\n',
  );
  w(
    '.claude/plugins/cache/community/third-party/0.2.0/skills/community-skill/SKILL.md',
    '---\nname: community-skill\ndescription: not ours\n---\nCommunity skill body.\n',
  );
  w(
    '.claude.json',
    JSON.stringify({
      mcpServers: {
        github: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_TOKEN: 'ghp-SECRET-VALUE' },
        },
        'harness-nexus-demo': { command: '/usr/local/bin/hnx', args: ['mcp', 'serve'] },
      },
    }),
  );

  // ---- codex (with an install ledger — alpha is platform-written) ----
  w('.codex/skills/alpha/SKILL.md', 'Alpha skill body.\n');
  w('.codex/prompts/prompt-a.md', 'Prompt body.\n');
  w(
    '.codex/config.toml',
    [
      '# user comment',
      '[mcp_servers.harness-nexus-my-profile]',
      'command = "hnx"',
      'args = ["mcp", "serve", "--profile", "p1"]',
      '',
      '[mcp_servers.user-server]',
      'command = "uvx"',
      'args = ["mcp-server-fetch"]',
      '',
    ].join('\n'),
  );
  w(
    '.codex/harness-nexus-install-state.json',
    JSON.stringify({
      schemaVersion: 'harness-nexus.install.v1',
      installedAt: new Date().toISOString(),
      target: { id: 'p1', target: 'codex', kind: 'profile', root: path.join(home, '.codex') },
      profile: { id: 'p1', name: 'my-profile', version: '1.0.0' },
      operations: [
        {
          kind: 'write-file',
          content: '',
          destinationPath: path.join(home, '.codex', 'skills', 'alpha', 'SKILL.md'),
        },
      ],
    }),
  );

  // ---- hermes ----
  w(
    '.hermes/plugins/my-plugin/plugin.yaml',
    'name: my-plugin\nversion: 1.0.0\nauthor: Harness Nexus\nkind: standalone\n',
  );
  w('.hermes/plugins/my-plugin/skills/hshare/SKILL.md', 'Shared skill from our plugin.\n');
  w(
    '.hermes/plugins/third-party/plugin.yaml',
    'name: third-party\nversion: 0.1.0\nauthor: someone-else\nkind: standalone\n',
  );
  w('.hermes/plugins/third-party/skills/hshare/SKILL.md', 'Same-name skill, third party.\n');
  w('.hermes/AGENTS.md', 'Project rules for Hermes.\n');
  w(
    '.hermes/config.yaml',
    [
      'mcp_servers:',
      '  fetcher:',
      '    command: uvx',
      '    args:',
      '      - mcp-server-fetch',
      '    env:',
      '      FETCH_KEY: fetch-secret-123',
      '',
    ].join('\n'),
  );

  // ---- deepseek (T1): bundle skill, flat command skill, home patch MCP rows ----
  w(
    '.dsh/skills/docx/SKILL.md',
    '---\nname: docx\ndescription: Work with documents\n---\n\nCreate and edit documents.\n',
  );
  w('.dsh/skills/deploy-now.md', '---\nname: deploy-now\ndescription: deploys\n---\nDeploy.\n');
  w(
    '.dsh/cordis.patch.yml',
    [
      "# the user's own rows come first",
      '- id: system-prompt',
      '  config:',
      '    persona: keep',
      '# BEGIN harness-nexus:my-kit (managed)',
      '- insert:',
      '    - id: hnx-mcp-my-kit',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: harness-nexus-my-kit',
      '        transport: stdio',
      '        command: /usr/local/bin/hnx',
      "        args: ['mcp', 'serve', '--profile', 'p1']",
      '# END harness-nexus:my-kit (managed)',
      '- insert:',
      '    - id: mcp-web',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: web',
      '        transport: streamable-http',
      "        url: 'http://localhost:3000/mcp'",
      '',
    ].join('\n'),
  );

  // ---- opencode (9 W12): mcp from opencode.json, command/agent markdown, skills ----
  w(
    '.config/opencode/opencode.json',
    JSON.stringify(
      {
        model: 'harness-nexus/gw-large',
        mcp: {
          'harness-nexus-my-kit': {
            type: 'local',
            command: ['/usr/local/bin/hnx', 'mcp', 'serve', '--profile', 'p1'],
            environment: { HN_KEY: 'oc-secret-1' },
          },
          web: { type: 'remote', url: 'https://mcp.example.com/sse' },
        },
      },
      null,
      2,
    ),
  );
  w(
    '.config/opencode/command/deploy.md',
    '---\ndescription: Deploy the app\n---\nDeploy carefully.\n',
  );
  w('.config/opencode/agent/reviewer.md', 'You are a code reviewer.\n');
  w(
    '.config/opencode/skill/docx/SKILL.md',
    '---\nname: docx\ndescription: Work with documents\n---\n\nCreate and edit .docx files.\n',
  );

  // ---- pi (9 W16): skills (frontmatter name may differ from the dir), prompt templates ----
  w(
    '.pi/agent/skills/mismatched-dir/SKILL.md',
    '---\nname: real-name\ndescription: The dir is not the name\n---\n\nBody.\n',
  );
  w(
    '.pi/agent/skills/plain/SKILL.md',
    '---\nname: plain\ndescription: No side files\n---\n\nBody.\n',
  );
  w('.pi/agent/prompts/deploy.md', '---\ndescription: Deploy the app\n---\nDeploy carefully.\n');

  return home;
}

afterAll(() => {
  if (home) rmSync(home, { recursive: true, force: true });
});

describe('claude-code scanner', () => {
  it('discovers skills/commands/agents/mcp with origins and summaries', () => {
    const h = setupHome();
    const snap = scanTarget('claude-code', h);
    expect(snap.target).toBe('claude-code');
    expect(snap.agents).toHaveLength(1);
    const items = snap.agents[0]!.items;
    const docx = items.find((i) => i.name === 'docx')!;
    expect(docx.kind).toBe('skill');
    expect(docx.origin).toBe('local');
    expect(docx.summary).toBe('Create and edit .docx files.');
    expect(docx.meta?.multi).toBe(true);
    expect(docx.importable).toBe(true);

    expect(items.find((i) => i.name === 'deploy')?.kind).toBe('command');
    expect(items.find((i) => i.name === 'reviewer')?.kind).toBe('sub_agent');
    expect(items.find((i) => i.name === 'binary-skill')?.importable).toBe(false);

    const shim = items.find((i) => i.name === 'harness-nexus-demo')!;
    expect(shim.kind).toBe('mcp');
    expect(shim.origin).toBe('platform');
    expect(snap.agents[0]!.profileApplied).toBe(true);
  });

  it('sees 3.5 marketplace plugin cache — harness-nexus items platform, third-party local', async () => {
    const h = setupHome();
    const snap = scanTarget('claude-code', h);
    const items = snap.agents[0]!.items;

    const pluginSkill = items.find((i) => i.name === 'cc-plugin-skill')!;
    expect(pluginSkill.kind).toBe('skill');
    expect(pluginSkill.origin).toBe('platform');
    expect(pluginSkill.meta?.plugin).toBe('harness-nexus-demo/cc-kit/1.0.0');
    expect(pluginSkill.summary).toBe('Plugin skill body.');

    expect(items.find((i) => i.name === 'plug-cmd')?.origin).toBe('platform');
    expect(items.find((i) => i.name === 'community-skill')?.origin).toBe('local');

    // Collect works straight off the cache path.
    const payload = await collectItems(
      'claude-code',
      [{ kind: 'skill', name: 'cc-plugin-skill' }],
      h,
    );
    expect(payload[0]!.ok).toBe(true);
  });

  it('redacts mcp env values daemon-side — plaintext never crosses the wire', async () => {
    const h = setupHome();
    const payload = await collectItems('claude-code', [{ kind: 'mcp', name: 'github' }], h);
    const wire = JSON.stringify(payload);
    expect(wire).not.toContain('ghp-SECRET-VALUE');
    expect(wire).toContain('${cred:GITHUB_TOKEN}');
    expect(payload[0]!.ok).toBe(true);
  });
});

describe('codex scanner', () => {
  it('marks ledger-written artifacts as platform origin', () => {
    const h = setupHome();
    const snap = scanTarget('codex', h);
    const items = snap.agents[0]!.items;
    expect(items.find((i) => i.name === 'alpha')?.origin).toBe('platform');
    expect(items.find((i) => i.name === 'prompt-a')?.origin).toBe('local');
    const shim = items.find((i) => i.name === 'harness-nexus-my-profile')!;
    expect(shim.origin).toBe('platform');
    expect(shim.meta?.command).toBe('hnx');
    const user = items.find((i) => i.name === 'user-server')!;
    expect(user.origin).toBe('local');
    expect(user.meta?.transport).toBe('stdio');
  });

  it('collects a stdio transport verbatim from config.toml', async () => {
    const h = setupHome();
    const payload = await collectItems('codex', [{ kind: 'mcp', name: 'user-server' }], h);
    expect(payload[0]!.artifact).toEqual({
      kind: 'mcp',
      transport: { type: 'stdio', command: 'uvx', args: ['mcp-server-fetch'] },
    });
  });
});

describe('hermes scanner', () => {
  it('separates our plugin skills from third-party ones and dedupes by (kind,name)', () => {
    const h = setupHome();
    const snap = scanTarget('hermes', h);
    const items = snap.agents[0]!.items;
    const shared = items.filter((i) => i.name === 'hshare');
    expect(shared).toHaveLength(1); // first occurrence wins
    expect(items.find((i) => i.name === 'AGENTS')?.kind).toBe('rule');
    expect(items.find((i) => i.name === 'fetcher')?.meta?.command).toBe('uvx');
  });

  it('redacts hermes mcp env values', async () => {
    const h = setupHome();
    const payload = await collectItems('hermes', [{ kind: 'mcp', name: 'fetcher' }], h);
    const wire = JSON.stringify(payload);
    expect(wire).not.toContain('fetch-secret-123');
    expect(wire).toContain('${cred:FETCH_KEY}');
  });
});

describe('deepseek scanner (T1)', () => {
  it('maps bundles to skills, flat files to commands, and patch rows to mcp with origins', () => {
    const h = setupHome();
    const snap = scanTarget('deepseek', h);
    const items = snap.agents[0]!.items;

    const docx = items.find((i) => i.name === 'docx')!;
    expect(docx.kind).toBe('skill');
    expect(docx.origin).toBe('local');
    expect(docx.summary).toBe('Create and edit documents.');

    expect(items.find((i) => i.name === 'deploy-now')?.kind).toBe('command');

    const shim = items.find((i) => i.name === 'harness-nexus-my-kit')!;
    expect(shim.kind).toBe('mcp');
    expect(shim.origin).toBe('platform'); // harness-nexus serverName marker
    expect(shim.meta?.command).toBe('/usr/local/bin/hnx');
    expect(snap.agents[0]!.profileApplied).toBe(true);

    const user = items.find((i) => i.name === 'web')!;
    expect(user.origin).toBe('local');
    expect(user.meta?.transport).toBe('http');
  });

  it('collects stdio and streamable-http mounts from the patch', async () => {
    const h = setupHome();
    const payload = await collectItems(
      'deepseek',
      [
        { kind: 'mcp', name: 'harness-nexus-my-kit' },
        { kind: 'mcp', name: 'web' },
        { kind: 'skill', name: 'docx' },
      ],
      h,
    );
    expect(payload[0]!.artifact).toEqual({
      kind: 'mcp',
      transport: {
        type: 'stdio',
        command: '/usr/local/bin/hnx',
        args: ['mcp', 'serve', '--profile', 'p1'],
      },
    });
    expect(payload[1]!.artifact).toEqual({
      kind: 'mcp',
      transport: { type: 'streamable-http', url: 'http://localhost:3000/mcp' },
    });
    expect(payload[2]!.ok).toBe(true);
  });
});

describe('opencode scanner (9 W12)', () => {
  it('maps the mcp block (array command + platform marker), markdown surfaces, and skills', () => {
    const h = setupHome();
    const snap = scanTarget('opencode', h);
    const items = snap.agents[0]!.items;

    const shim = items.find((i) => i.name === 'harness-nexus-my-kit')!;
    expect(shim.kind).toBe('mcp');
    expect(shim.origin).toBe('platform'); // harness-nexus serverName marker
    expect(shim.meta?.command).toBe('/usr/local/bin/hnx');
    expect(shim.meta?.transport).toBe('stdio');

    const web = items.find((i) => i.name === 'web')!;
    expect(web.origin).toBe('local');
    expect(web.meta?.transport).toBe('http');
    expect(web.meta?.url).toBe('https://mcp.example.com/sse');

    expect(items.find((i) => i.name === 'deploy')?.kind).toBe('command');
    expect(items.find((i) => i.name === 'reviewer')?.kind).toBe('sub_agent');
    const docx = items.find((i) => i.name === 'docx')!;
    expect(docx.kind).toBe('skill');
    expect(docx.summary).toBe('Create and edit .docx files.'); // body first line (frontmatter is metadata)
  });

  it('collects mcp with split command/args and redacts env values', async () => {
    const h = setupHome();
    const payload = await collectItems(
      'opencode',
      [
        { kind: 'mcp', name: 'harness-nexus-my-kit' },
        { kind: 'command', name: 'deploy' },
      ],
      h,
    );
    expect(payload[0]!.artifact).toEqual({
      kind: 'mcp',
      transport: {
        type: 'stdio',
        command: '/usr/local/bin/hnx',
        args: ['mcp', 'serve', '--profile', 'p1'],
        env: { HN_KEY: '${cred:HN_KEY}' },
      },
    });
    expect(payload[1]!.artifact).toEqual({
      kind: 'command',
      content: '---\ndescription: Deploy the app\n---\nDeploy carefully.\n',
    });
  });
});

describe('pi scanner (9 W16)', () => {
  it('maps skills (frontmatter name wins over the dir) and prompt templates as commands', async () => {
    const h = setupHome();
    const snap = scanTarget('pi', h);
    const items = snap.agents[0]!.items;

    const renamed = items.find((i) => i.name === 'real-name')!;
    expect(renamed.kind).toBe('skill');
    expect(renamed.path).toBe('skills/mismatched-dir'); // dir preserved, name from frontmatter
    expect(renamed.origin).toBe('local');
    expect(items.find((i) => i.name === 'plain')?.kind).toBe('skill');
    expect(items.find((i) => i.name === 'deploy')?.kind).toBe('command');

    const payload = await collectItems('pi', [{ kind: 'skill', name: 'real-name' }], h);
    expect(payload[0]!.artifact).toEqual({
      kind: 'skill',
      files: { 'SKILL.md': expect.stringContaining('real-name') },
    });
  });
});

describe('scanAllTargets', () => {
  it('reports a snapshot for every supported target and validates against the wire schema', async () => {
    const h = setupHome();
    const snapshots = scanAllTargets(h);
    expect(snapshots.map((s) => s.target).sort()).toEqual([
      'claude-code',
      'codex',
      'deepseek',
      'hermes',
      'opencode',
      'pi',
    ]);
    const { inventorySnapshotSchema } = await import('@harness-nexus/shared');
    for (const snap of snapshots) {
      expect(inventorySnapshotSchema.safeParse(snap).success).toBe(true);
    }
  });
});
