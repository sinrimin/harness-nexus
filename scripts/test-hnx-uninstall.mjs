// End-to-end test of `hnx uninstall` ledger reversal (no server needed):
// install a hermes profile into a temp dir that ALREADY has a user config.yaml,
// verify the merge, then uninstall and verify the pre-install state is fully
// restored. Run from repo root: node scripts/test-hnx-uninstall.mjs
import fs from 'node:fs';
import { hermesAdapter } from '../packages/cli/dist/install/adapters/hermes.js';
import { applyInstall } from '../packages/cli/dist/install/installer.js';
import { planUninstall, applyUninstall } from '../packages/cli/dist/install/uninstaller.js';

const OUT = '/tmp/hnx-uninstall-test';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// A user config that predates the install — uninstall must restore it byte-for-byte.
const USER_CONFIG = `# my hermes config
model: sonnet
mcp_servers:
  my-own-server:
    url: https://mine.example/mcp
`;
fs.writeFileSync(`${OUT}/config.yaml`, USER_CONFIG, 'utf8');

const resolvedProfile = {
  profile: {
    id: 'p1',
    name: 'Uninstall Me',
    description: 'd',
    version: '1.0.0',
    target: 'hermes',
    scope: 'personal',
    ownerId: null,
    entries: [
      { resourceId: 'skill-1', kind: 'skill' },
      { resourceId: 'mcp-1', kind: 'mcp' },
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
        name: 'tdd',
        description: 'TDD.',
        version: '1.0.0',
        source: {
          type: 'inline',
          content: '---\nname: tdd\ndescription: TDD\n---\n\nWrite tests first.',
        },
        scope: 'personal',
        ownerId: null,
        targets: ['hermes'],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    },
    {
      entryId: 'mcp-1',
      kind: 'mcp',
      mcpServer: {
        id: 'mcp-1',
        name: 'upstream',
        transport: { type: 'streamable-http', url: 'https://up.example/mcp' },
        mode: 'proxy',
        scope: 'personal',
        ownerId: null,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    },
  ],
};

let pass = 0,
  fail = 0;
const expect = (label, got, want) => {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  ok ? pass++ : fail++;
};

// ---- install ----
const plan = hermesAdapter.planOperations(resolvedProfile, { outDir: OUT }, hermesAdapter);
applyInstall(plan, { profileId: 'p1', profileName: 'Uninstall Me', profileVersion: '1.0.0' });

const merged = fs.readFileSync(`${OUT}/config.yaml`, 'utf8');
expect('config merged: user entry kept', merged.includes('my-own-server'), true);
expect('config merged: our entry added', merged.includes('harness-nexus-uninstall-me'), true);
expect('plugin dir written', fs.existsSync(`${OUT}/plugins/uninstall-me/plugin.yaml`), true);

// ---- simulate a user edit post-install (conflict path) ----
fs.writeFileSync(`${OUT}/config.yaml`, merged + '\n# user note added after install\n', 'utf8');

// ---- uninstall ----
const uPlan = planUninstall({ target: 'hermes', input: { outDir: OUT } });
expect('uninstall plan found', uPlan !== null, true);
const restoreStep = uPlan.steps.find((s) => s.destinationPath === `${OUT}/config.yaml`);
expect('config.yaml step is restore', restoreStep?.action, 'restore');
expect('config.yaml step flagged as conflict', restoreStep?.conflicts, true);

const touched = applyUninstall(uPlan);
expect('uninstall touched files', touched > 0, true);

// ---- verify restoration ----
const after = fs.readFileSync(`${OUT}/config.yaml`, 'utf8');
expect('config restored byte-for-byte', after, USER_CONFIG);
expect('user conflict edit kept as .bak', fs.existsSync(`${OUT}/config.yaml.hnx.bak`), true);
expect('plugin dir pruned', fs.existsSync(`${OUT}/plugins/uninstall-me`), false);
expect('empty plugins parent pruned', fs.existsSync(`${OUT}/plugins`), false);
expect('ledger removed', fs.existsSync(`${OUT}/harness-nexus-install-state.json`), false);
expect(
  'second uninstall finds nothing',
  planUninstall({ target: 'hermes', input: { outDir: OUT } }) === null,
  true,
);

console.log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
