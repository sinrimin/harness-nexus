// Throwaway smoke test for the Phase 3.5 marketplace emitter. Self-contained:
// boots a memory-mode server on :17800, registers a user, creates a PAT,
// resources + an MCP server + a claude-code profile mixing both entry arms,
// then exercises the PAT-in-path catalog + archive routes. The zip is written
// to /tmp for member inspection (asserted here by magic + parsed next by the
// caller via python3 zipfile).
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const B = 'http://127.0.0.1:17800';
const log = (...a) => console.log(...a);

let pass = 0,
  fail = 0;
const expect = (label, got, want) => {
  const ok = got === want;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}: got ${String(got).slice(0, 120)}, want ${String(want).slice(0, 120)}`,
  );
  ok ? pass++ : fail++;
};

async function req(method, path, { token, body, raw } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(B + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (raw) {
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, buf };
  }
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-json */
  }
  return { status: r.status, json, text };
}

// ---- boot the server ----
const server = spawn('node', ['packages/server/dist/server.js'], {
  env: {
    ...process.env,
    STORAGE_DRIVER: 'memory',
    JWT_SECRET: 'smoke-secret-smoke-secret-smoke',
    PORT: '17800',
    PUBLIC_BASE_URL: B,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(B + '/healthz');
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 250));
  }
  throw new Error(`server never became healthy\n${serverLog}`);
}

try {
  await waitReady();
  log('--- server ready ---');

  log('\n--- register user + marketplace emit token ---');
  let r = await req('POST', '/api/auth/register', {
    body: { username: 'smoke', password: 'hunter2hunter2' },
  });
  expect('register status', r.status, 201);
  const jwt = r.json.token;
  r = await req('POST', '/api/pats', {
    token: jwt,
    body: { name: 'emitter', kind: 'marketplace' },
  });
  expect('pat status', r.status, 201);
  const pat = r.json.token;
  expect('pat carries marketplace scope', r.json.pat.scopes.includes('marketplace'), true);
  expect(
    'add command shape',
    r.json.addCommand.startsWith(
      'claude plugin marketplace add http://127.0.0.1:17800/api/marketplace/',
    ),
    true,
  );

  log('\n--- token-kind isolation ---');
  // An API PAT must NOT authenticate the marketplace URL...
  r = await req('POST', '/api/pats', { token: jwt, body: { name: 'cli' } });
  const apiPat = r.json.token;
  r = await req('GET', `/api/marketplace/${apiPat}/marketplace.json`);
  expect('api pat on marketplace -> 404', r.status, 404);
  // ...and the marketplace token must NOT authenticate the REST API.
  r = await req('GET', '/api/auth/me', { token: pat });
  expect('marketplace pat on api -> 401', r.status, 401);

  log('\n--- create resources (skill / bundle-skill / rule / command / sub_agent / hook) ---');
  const mkResource = (over) =>
    req('POST', '/api/resources', {
      token: jwt,
      body: {
        key: over.key,
        kind: over.kind,
        name: over.name,
        description: over.description,
        version: '1.0.0',
        source: over.source,
        scope: 'personal',
        targets: ['claude-code'],
      },
    });
  r = await mkResource({
    key: 'greeter',
    kind: 'skill',
    name: 'Greeter',
    description: 'Greets people.',
    source: {
      type: 'inline',
      content: '---\nname: greeter\ndescription: Greets people.\n---\n\nSay hi warmly.',
    },
  });
  expect('skill resource status', r.status, 201);
  const skillId = r.json.resource.id;

  r = await mkResource({
    key: 'bundled',
    kind: 'skill',
    name: 'Bundled',
    description: 'Multi-file skill.',
    source: {
      type: 'inline-bundle',
      files: {
        'SKILL.md': '---\nname: bundled\ndescription: Multi-file.\n---\n\nSee references.',
        'references/api.md': '# API notes\n...',
      },
    },
  });
  expect('bundle resource status', r.status, 201);
  const bundleId = r.json.resource.id;

  r = await mkResource({
    key: 'code-style',
    kind: 'rule',
    name: 'Code Style',
    description: 'Project code conventions.',
    source: { type: 'inline', content: 'Always use tabs. Never commit generated files.' },
  });
  expect('rule resource status', r.status, 201);
  const ruleId = r.json.resource.id;

  r = await mkResource({
    key: 'deploy',
    kind: 'command',
    name: 'Deploy',
    description: 'Deploy the app.',
    source: {
      type: 'inline',
      content: '---\ndescription: Deploy the app\n---\nRun the deploy pipeline.',
    },
  });
  expect('command resource status', r.status, 201);
  const commandId = r.json.resource.id;

  r = await mkResource({
    key: 'reviewer',
    kind: 'sub_agent',
    name: 'Reviewer',
    description: 'Reviews code.',
    source: {
      type: 'inline',
      content: '---\nname: reviewer\ndescription: Reviews code.\n---\n\nYou review code.',
    },
  });
  expect('sub_agent resource status', r.status, 201);
  const agentId = r.json.resource.id;

  r = await mkResource({
    key: 'notify',
    kind: 'hook',
    name: 'Notify',
    description: 'PostToolUse notify.',
    source: {
      type: 'inline',
      content: JSON.stringify({
        hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'echo done' }] }] },
      }),
    },
  });
  expect('hook resource status', r.status, 201);
  const hookId = r.json.resource.id;

  log('\n--- create a proxy MCP server ---');
  r = await req('POST', '/api/mcp-servers', {
    token: jwt,
    body: {
      name: 'demo-upstream',
      mode: 'proxy',
      scope: 'personal',
      transport: { type: 'streamable-http', url: 'https://example.invalid/mcp' },
    },
  });
  expect('mcp server status', r.status, 201);
  const mcpId = r.json.mcpServer.id;

  log('\n--- create claude-code profile mixing both entry arms ---');
  r = await req('POST', '/api/profiles', {
    token: jwt,
    body: {
      name: 'Daily CC',
      description: 'Everything a claude session needs.',
      target: 'claude-code',
      scope: 'personal',
      entries: [
        { mcpServerId: mcpId },
        { resourceId: skillId, kind: 'skill' },
        { resourceId: bundleId, kind: 'skill' },
        { resourceId: ruleId, kind: 'rule' },
        { resourceId: commandId, kind: 'command' },
        { resourceId: agentId, kind: 'sub_agent' },
        { resourceId: hookId, kind: 'hook' },
      ],
    },
  });
  expect('profile status', r.status, 201);
  const profileId = r.json.profile.id;

  log('\n--- marketplace.json via PAT-in-path ---');
  r = await req('GET', `/api/marketplace/${pat}/marketplace.json`);
  expect('catalog status', r.status, 200);
  expect('catalog name', r.json.name, 'harness-nexus-smoke');
  expect('catalog plugin count', r.json.plugins.length, 1);
  expect('plugin name', r.json.plugins[0].name, 'daily-cc');
  expect(
    'archive url shape',
    r.json.plugins[0].source.url,
    `${B}/api/marketplace/${pat}/archives/${profileId}.zip`,
  );
  expect('archive source kind', r.json.plugins[0].source.source, 'archive');

  log('\n--- bad token → 404 (no existence leak) ---');
  r = await req('GET', '/api/marketplace/hnpat_deadbeef/marketplace.json');
  expect('bad token status', r.status, 404);
  expect('bad token code', r.json.error, 'MARKETPLACE_NOT_FOUND');

  log('\n--- non-claude-code profile hidden from catalog ---');
  r = await req('POST', '/api/profiles', {
    token: jwt,
    body: {
      name: 'Hermes Only',
      target: 'hermes',
      scope: 'personal',
      entries: [],
    },
  });
  expect('hermes profile status', r.status, 201);
  r = await req('GET', `/api/marketplace/${pat}/marketplace.json`);
  expect('still 1 plugin', r.json.plugins.length, 1);

  log('\n--- archive zip ---');
  r = await req('GET', `/api/marketplace/${pat}/archives/${profileId}.zip`, { raw: true });
  expect('zip status', r.status, 200);
  expect('zip magic', r.buf.subarray(0, 2).toString('latin1'), 'PK');
  writeFileSync('/tmp/hnx-marketplace-smoke.zip', r.buf);

  log('\n--- invisible profile archive → 404 ---');
  // Register a second user; their PAT must not see smoke's personal profile.
  r = await req('POST', '/api/auth/register', {
    body: { username: 'mallory', password: 'hunter2hunter2' },
  });
  const malloryJwt = r.json.token;
  r = await req('POST', '/api/pats', {
    token: malloryJwt,
    body: { name: 'm', kind: 'marketplace' },
  });
  const malloryPat = r.json.token;
  r = await req('GET', `/api/marketplace/${malloryPat}/archives/${profileId}.zip`, { raw: true });
  expect('cross-user archive status', r.status, 404);
  r = await req('GET', `/api/marketplace/${malloryPat}/marketplace.json`);
  expect('cross-user catalog status', r.status, 200);
  expect('cross-user sees no personal plugins', r.json.plugins.length, 0);

  log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exitCode = fail > 0 ? 1 : 0;
} catch (e) {
  console.error('SMOKE ERROR:', e);
  process.exitCode = 1;
} finally {
  server.kill('SIGTERM');
}
