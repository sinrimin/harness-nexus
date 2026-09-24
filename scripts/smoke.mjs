// Throwaway smoke test for the Phase 1 auth flow. Run against a freshly booted
// memory-mode server. Not part of the automated test suite (yet).
const B = process.env.BASE_URL ?? 'http://127.0.0.1:7780';
const log = (...a) => console.log(...a);
const code = (r) => r.status;

async function req(method, path, { token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(B + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-json */
  }
  return { status: r.status, json, text };
}

let pass = 0,
  fail = 0;
const expect = (label, got, want) => {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got ${got}, want ${want}`);
  ok ? pass++ : fail++;
};

log('--- register first user (bootstrap admin) ---');
let r = await req('POST', '/api/auth/register', {
  body: { username: 'root', password: 'hunter2hunter2' },
});
expect('first register status', r.status, 201);
expect('first register role', r.json.user.role, 'admin');
const adminToken = r.json.token;

log('\n--- /me with admin token ---');
r = await req('GET', '/api/auth/me', { token: adminToken });
expect('me status', r.status, 200);
expect('me username', r.json.user.username, 'root');

log('\n--- /me with no token (401) ---');
r = await req('GET', '/api/auth/me');
expect('no-token status', r.status, 401);

log('\n--- admin GET /api/users (200) ---');
r = await req('GET', '/api/users', { token: adminToken });
expect('admin list users status', r.status, 200);

log('\n--- register second user (role=user) ---');
r = await req('POST', '/api/auth/register', {
  body: { username: 'alice', password: 'hunter2hunter2' },
});
expect('second register role', r.json.user.role, 'user');
const userToken = r.json.token;

log('\n--- non-admin GET /api/users (403) ---');
r = await req('GET', '/api/users', { token: userToken });
expect('user list users status', r.status, 403);

log('\n--- create PAT ---');
r = await req('POST', '/api/pats', { token: adminToken, body: { name: 'ci' } });
expect('create pat status', r.status, 201);
const patToken = r.json.token;
const patId = r.json.pat.id;
log('    pat prefix:', r.json.pat.prefix);

log('\n--- use PAT on /me (200) ---');
r = await req('GET', '/api/auth/me', { token: patToken });
expect('pat me status', r.status, 200);
expect('pat me resolves admin', r.json.user.username, 'root');

log('\n--- revoke PAT, then it must fail (401) ---');
r = await req('DELETE', `/api/pats/${patId}`, { token: adminToken });
expect('revoke pat status', r.status, 200);
r = await req('GET', '/api/auth/me', { token: patToken });
expect('revoked pat rejected', r.status, 401);

log('\n--- disable registration ---');
r = await req('PUT', '/api/settings/registration', {
  token: adminToken,
  body: { allowRegistration: false },
});
expect('disable registration status', r.status, 200);
r = await req('GET', '/api/settings/registration');
expect('registration now closed', r.json.allowRegistration, false);

log('\n--- register when disabled (403) ---');
r = await req('POST', '/api/auth/register', {
  body: { username: 'bob', password: 'hunter2hunter2' },
});
expect('disabled register status', r.status, 403);

log('\n--- admin create user bypasses switch (201) ---');
r = await req('POST', '/api/users', {
  token: adminToken,
  body: { username: 'carol', password: 'hunter2hunter2', role: 'user' },
});
expect('admin create user status', r.status, 201);

log('\n--- last-admin protection: demote self (409) ---');
const me = (await req('GET', '/api/auth/me', { token: adminToken })).json.user;
r = await req('PATCH', `/api/users/${me.id}/role`, { token: adminToken, body: { role: 'user' } });
expect('demote last admin status', r.status, 409);

log('\n--- self-delete protection (409) ---');
r = await req('DELETE', `/api/users/${me.id}`, { token: adminToken });
expect('self delete status', r.status, 409);

log('\n--- bad login (401) ---');
r = await req('POST', '/api/auth/login', { body: { username: 'alice', password: 'wrong' } });
expect('bad login status', r.status, 401);

log('\n--- validation: short password + bad username (400) ---');
r = await req('POST', '/api/auth/register', { body: { username: 'x', password: 'short' } });
expect('validation status', r.status, 400);

log('\n--- disabled account rejected ---');
// (skipped: requires an admin to disable a user first; covered by unit tests later)

// ====================== Phase 2.1: credentials + mcp-servers ======================

log('\n--- [2.1] user creates a personal credential (201) ---');
r = await req('POST', '/api/credentials', {
  token: userToken,
  body: { name: 'alice-key', secret: 'sk_test_abcdef123456', scope: 'personal' },
});
expect('personal credential created', r.status, 201);
expect('credential secret masked', r.json.credential.secretPreview.includes('…'), true);
expect('credential omits secret field', 'secret' in r.json.credential, false);

log('\n--- [2.1] user cannot create global credential (403) ---');
r = await req('POST', '/api/credentials', {
  token: userToken,
  body: { name: 'g', secret: 'x'.repeat(12), scope: 'global' },
});
expect('non-admin global credential rejected', r.status, 403);

log('\n--- [2.1] admin creates a global credential (201) ---');
r = await req('POST', '/api/credentials', {
  token: adminToken,
  body: { name: 'shared-token', secret: 'bearer_abcdefghijklmnop', scope: 'global' },
});
expect('admin global credential created', r.status, 201);
const globalCredId = r.json.credential.id;

log('\n--- [2.1] list returns personal + global (2) ---');
r = await req('GET', '/api/credentials', { token: userToken });
expect('user lists both credentials', r.json.credentials.length, 2);

log('\n--- [2.1] user cannot delete global credential (404) ---');
r = await req('DELETE', `/api/credentials/${globalCredId}`, { token: userToken });
expect('non-admin delete global → 404', r.status, 404);

log('\n--- [2.1] admin deletes global credential (200) ---');
r = await req('DELETE', `/api/credentials/${globalCredId}`, { token: adminToken });
expect('admin delete global credential', r.status, 200);

log('\n--- [2.1] create mcp-server with a credential placeholder in headers (201) ---');
r = await req('POST', '/api/mcp-servers', {
  token: userToken,
  body: {
    name: 'acme-mcp',
    transport: {
      type: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer ${cred:alice-key}' },
    },
    scope: 'personal',
  },
});
expect('mcp-server created with placeholder in headers', r.status, 201);
const acmeId = r.json.mcpServer.id;

log('\n--- [8 C2] stdio + explicit server dial rejected — STDIO_REQUIRES_CLIENT (409) ---');
r = await req('POST', '/api/mcp-servers', {
  token: userToken,
  body: {
    name: 'stdio-nope',
    transport: { type: 'stdio', command: 'echo' },
    dialSite: 'server',
    scope: 'personal',
  },
});
expect('stdio + server dial rejected (409)', r.status, 409);
expect('error code STDIO_REQUIRES_CLIENT', r.json.error, 'STDIO_REQUIRES_CLIENT');

log('\n--- [8 C2] stdio accepted (dial site derives client — the unification win) ---');
r = await req('POST', '/api/mcp-servers', {
  token: userToken,
  body: {
    name: 'local-fs',
    transport: {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
    },
    dialSite: 'auto',
    scope: 'personal',
  },
});
expect('stdio + auto created', r.status, 201);
expect('dialSite stored', r.json.mcpServer.dialSite, 'auto');

log('\n--- [2.1] non-admin cannot create global mcp-server (403) ---');
r = await req('POST', '/api/mcp-servers', {
  token: userToken,
  body: {
    name: 'g',
    transport: { type: 'streamable-http', url: 'https://mcp.example.com/mcp' },
    scope: 'global',
  },
});
expect('non-admin global mcp-server rejected', r.status, 403);

log('\n--- [3.1] list mcp-servers (2 personal) ---');
r = await req('GET', '/api/mcp-servers', { token: userToken });
expect('user lists own mcp-servers', r.json.mcpServers.length, 2);

log('\n--- [2.1] delete own mcp-server (200) ---');
r = await req('DELETE', `/api/mcp-servers/${acmeId}`, { token: userToken });
expect('delete own mcp-server', r.status, 200);

// ============================ Phase 2.2: profiles + status ============================

log('\n--- [2.2] create a personal mcp-server to reference in a profile (201) ---');
r = await req('POST', '/api/mcp-servers', {
  token: userToken,
  body: {
    name: 'demo-upstream',
    transport: { type: 'streamable-http', url: 'https://mcp.example.com/mcp' },
    // Explicit server dial: pre-C2 this row was `mode: 'proxy'`. Under the
    // dial-site model a no-credential upstream derives CLIENT by default, so
    // these 2.2/2.4 blocks (which exercise the SERVER pool) pin it to 'server'.
    dialSite: 'server',
    scope: 'personal',
  },
});
expect('demo mcp-server created', r.status, 201);
const demoServerId = r.json.mcpServer.id;

log('\n--- [2.2] create profile referencing an accessible server (201) ---');
r = await req('POST', '/api/profiles', {
  token: userToken,
  body: {
    name: 'daily',
    description: 'my daily bundle',
    target: 'claude-code',
    scope: 'personal',
    entries: [{ mcpServerId: demoServerId }],
  },
});
expect('profile created', r.status, 201);
expect('profile has 1 entry', r.json.profile.entries.length, 1);
expect('profile target stored', r.json.profile.target, 'claude-code');
const profileId = r.json.profile.id;

log('\n--- [2.2] create profile referencing a non-existent server (409) ---');
r = await req('POST', '/api/profiles', {
  token: userToken,
  body: {
    name: 'bad',
    target: 'claude-code',
    scope: 'personal',
    entries: [{ mcpServerId: 'mcp_no_such' }],
  },
});
expect('profile with bad entry rejected', r.status, 409);

log('\n--- [2.2] non-admin cannot create global profile (403) ---');
r = await req('POST', '/api/profiles', {
  token: userToken,
  body: { name: 'g', target: 'claude-code', scope: 'global', entries: [] },
});
expect('non-admin global profile rejected', r.status, 403);

log('\n--- [2.2] admin creates a global profile (201) ---');
r = await req('POST', '/api/profiles', {
  token: adminToken,
  body: { name: 'shared', target: 'zcode', scope: 'global', entries: [] },
});
expect('admin global profile created', r.status, 201);

log('\n--- [2.2] list profiles returns personal + global (2) ---');
r = await req('GET', '/api/profiles', { token: userToken });
expect('user lists 2 profiles', r.json.profiles.length, 2);

log('\n--- [2.2] get profile detail (200) ---');
r = await req('GET', `/api/profiles/${profileId}`, { token: userToken });
expect('profile detail status', r.status, 200);
expect('profile detail name', r.json.profile.name, 'daily');

// ============================ Phase 3.2: Profile.target ============================

log('\n--- [3.2] create profile WITHOUT target → 400 (required) ---');
r = await req('POST', '/api/profiles', {
  token: userToken,
  body: { name: 'no-target', scope: 'personal', entries: [] },
});
expect('profile without target rejected', r.status, 400);

log('\n--- [3.2] create profile WITH target hermes → 201, target stored ---');
r = await req('POST', '/api/profiles', {
  token: userToken,
  body: { name: 'hermes-bundle', target: 'hermes', scope: 'personal', entries: [] },
});
expect('hermes profile created', r.status, 201);
expect('hermes profile target', r.json.profile.target, 'hermes');

log('\n--- [3.2] PATCH profile target → 409 TARGET_IMMUTABLE ---');
r = await req('PATCH', `/api/profiles/${profileId}`, {
  token: userToken,
  body: { target: 'zcode' },
});
expect('target change rejected as immutable', r.status, 409);
expect('immutable error code', r.json.error, 'TARGET_IMMUTABLE');

log('\n--- [3.2] PATCH profile name WITHOUT target still works (200) ---');
r = await req('PATCH', `/api/profiles/${profileId}`, {
  token: userToken,
  body: { name: 'daily-renamed' },
});
expect('non-target PATCH succeeds', r.status, 200);
expect('patched name applied', r.json.profile.name, 'daily-renamed');
expect('target unchanged after patch', r.json.profile.target, 'claude-code');
// #18: the version is server-assigned and the bump IS the marketplace publish
// switch, so a name-only edit must leave it alone.
expect('name-only PATCH keeps the version', r.json.profile.version, '0.1');

log('\n--- [#18] versions are server-assigned; only an entries change bumps ---');
r = await req('POST', '/api/profiles', {
  token: userToken,
  body: {
    name: 'versioning',
    target: 'claude-code',
    scope: 'personal',
    version: '1.1.0',
    entries: [],
  },
});
expect('create with a client-sent version → 0.1', r.json.profile.version, '0.1');
const versioningProfileId = r.json.profile.id;
r = await req('PATCH', `/api/profiles/${versioningProfileId}`, {
  token: userToken,
  body: { version: '1.1.0' },
});
expect('client-sent version on PATCH is ignored', r.json.profile.version, '0.1');
r = await req('PATCH', `/api/profiles/${versioningProfileId}`, {
  token: userToken,
  body: { entries: [{ mcpServerId: demoServerId }] },
});
expect('changed entries bump the version', r.json.profile.version, '0.2');
r = await req('PATCH', `/api/profiles/${versioningProfileId}`, {
  token: userToken,
  body: { entries: [{ mcpServerId: demoServerId }] },
});
expect('unchanged entries keep the version', r.json.profile.version, '0.2');
r = await req('DELETE', `/api/profiles/${versioningProfileId}`, { token: userToken });
expect('versioning profile cleaned up', r.status, 200);

log('\n--- [2.2] mcp-servers status endpoint (200) ---');
r = await req('GET', '/api/mcp-servers/status', { token: userToken });
expect('status endpoint status', r.status, 200);
expect('statuses is an array', Array.isArray(r.json.statuses), true);

log('\n--- [2.2] create a fresh PAT for /mcp proxy tests ---');
r = await req('POST', '/api/pats', { token: userToken, body: { name: 'mcp-proxy' } });
expect('fresh pat created', r.status, 201);
const mcpPat = r.json.token;

log('\n--- [2.2] /mcp without profile param (400) ---');
r = await req('POST', '/mcp', { token: mcpPat });
expect('mcp without profile rejected', r.status, 400);

log('\n--- [2.2] /mcp without auth (401) ---');
r = await req('POST', `/mcp?profile=${profileId}`);
expect('mcp without auth rejected', r.status, 401);

log('\n--- [2.2] delete profile (200) ---');
r = await req('DELETE', `/api/profiles/${profileId}`, { token: userToken });
expect('delete profile', r.status, 200);

// ============================ Phase 2.4: connect/disconnect + tools ============================
// demoServerId is the 'demo-upstream' proxy server created in the 2.2 block
// above. Its URL (https://mcp.example.com/mcp) is unreachable, so connect
// resolves with status='error' + detail — this is the primary use case for the
// explicit Connect button (re-dial after fixing a broken upstream). The tools
// endpoint returns [] when not connected; refresh is refused (409 NOT_CONNECTED)
// on a down server.

log('\n--- [2.4] status entries carry toolCount (Phase 2.4 extension) ---');
r = await req('GET', '/api/mcp-servers/status', { token: userToken });
expect('status ok', r.status, 200);
const demoStatus = r.json.statuses.find((s) => s.id === demoServerId);
expect('demo status present', typeof demoStatus, 'object');
expect('status has toolCount field', typeof demoStatus.toolCount, 'number');

log('\n--- [2.4] connect forces a (re)dial; unreachable → status error ---');
r = await req('POST', `/api/mcp-servers/${demoServerId}/connect`, { token: userToken });
expect('connect returns 200', r.status, 200);
expect('connect returns a status object', typeof r.json.status, 'object');
expect(
  'connect result is connected or error (best-effort)',
  r.json.status.status === 'connected' || r.json.status.status === 'error',
  true,
);
expect('status has toolCount', typeof r.json.status.toolCount, 'number');

log('\n--- [2.4] tools list on a not-connected server → empty array (not error) ---');
r = await req('GET', `/api/mcp-servers/${demoServerId}/tools`, { token: userToken });
expect('tools endpoint ok', r.status, 200);
expect('tools is an array', Array.isArray(r.json.tools), true);

log('\n--- [2.4] refresh on a not-connected server → 409 NOT_CONNECTED ---');
r = await req('POST', `/api/mcp-servers/${demoServerId}/tools/refresh`, { token: userToken });
// only assert the contract when the server is actually down (error/disconnected);
// if the unreachable upstream happened to connect, refresh is valid.
if (demoStatus.status !== 'connected') {
  expect('refresh on down server → 409', r.status, 409);
  expect('error code NOT_CONNECTED', r.json.error, 'NOT_CONNECTED');
}

log('\n--- [2.4] connect on a client-dialed server → 409 NOT_SERVER_DIALED ---');
// 'local-fs' is the stdio+auto server created in the 8 C2 block (auto → client).
r = await req('GET', '/api/mcp-servers', { token: userToken });
const clientDialed = r.json.mcpServers.find((s) => s.name === 'local-fs');
r = await req('POST', `/api/mcp-servers/${clientDialed.id}/connect`, { token: userToken });
expect('connect on client-dialed → 409', r.status, 409);
expect('error code NOT_SERVER_DIALED', r.json.error, 'NOT_SERVER_DIALED');

log('\n--- [2.4] connect on unknown id → 404 (leak prevention) ---');
r = await req('POST', '/api/mcp-servers/mcp_no_such/connect', { token: userToken });
expect('connect unknown → 404', r.status, 404);
expect('error code MCP_SERVER_NOT_FOUND', r.json.error, 'MCP_SERVER_NOT_FOUND');

log('\n--- [2.4] disconnect on a pooled server (idempotent) ---');
r = await req('POST', `/api/mcp-servers/${demoServerId}/disconnect`, { token: userToken });
expect('disconnect returns 200', r.status, 200);
expect('disconnect status is disconnected', r.json.status.status, 'disconnected');

// ============================ Phase 4.2: resources ============================

log('\n--- [4.2] user creates a personal sub_agent resource (201) ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'sub_agent:reviewer',
    kind: 'sub_agent',
    name: 'Code reviewer',
    description: 'Reviews PRs carefully',
    scope: 'personal',
    source: { type: 'inline', content: 'You are a careful code reviewer.' },
    targets: ['claude-code', 'zcode'],
  },
});
expect('personal sub_agent created', r.status, 201);
expect('resource kind is sub_agent', r.json.resource.kind, 'sub_agent');
expect('resource source is inline', r.json.resource.source.type, 'inline');
const subAgentId = r.json.resource.id;

log('\n--- [4.2] admin creates a global rule resource (201) ---');
r = await req('POST', '/api/resources', {
  token: adminToken,
  body: {
    key: 'rule:tests-first',
    kind: 'rule',
    name: 'Tests before done',
    scope: 'global',
    source: { type: 'inline', content: 'Always run tests before marking done.' },
  },
});
expect('global rule created', r.status, 201);
const ruleId = r.json.resource.id;

log('\n--- [4.2] list returns personal + global (2) ---');
r = await req('GET', '/api/resources', { token: userToken });
expect('user lists both resources', r.json.resources.length, 2);

log('\n--- [4.2] non-admin cannot create global resource (403) ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'rule:global-nope',
    kind: 'rule',
    name: 'g',
    scope: 'global',
    source: { type: 'inline', content: 'x' },
  },
});
expect('non-admin global resource rejected', r.status, 403);

log('\n--- [4.2] duplicate key in same scope (409) ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'sub_agent:reviewer',
    kind: 'sub_agent',
    name: 'dup',
    scope: 'personal',
    source: { type: 'inline', content: 'x' },
  },
});
expect('duplicate key rejected', r.status, 409);
expect('error code RESOURCE_KEY_TAKEN', r.json.error, 'RESOURCE_KEY_TAKEN');

log('\n--- [4.2] kind mcp not available as a resource (409) ---');
// 'mcp' is a ResourceKind but MCP servers are managed separately (/api/mcp-servers),
// so it is not in the resource AVAILABLE_KINDS.
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'mcp:future',
    kind: 'mcp',
    name: 'future',
    scope: 'personal',
    source: { type: 'inline', content: 'x' },
  },
});
expect('mcp kind rejected', r.status, 409);
expect('error code KIND_NOT_AVAILABLE', r.json.error, 'KIND_NOT_AVAILABLE');

log('\n--- [4.2] PATCH update own resource (200) ---');
r = await req('PATCH', `/api/resources/${subAgentId}`, {
  token: userToken,
  body: { name: 'Senior code reviewer' },
});
expect('patch own resource', r.status, 200);
expect('name updated', r.json.resource.name, 'Senior code reviewer');

log('\n--- [4.2] non-admin cannot mutate global resource (404) ---');
r = await req('PATCH', `/api/resources/${ruleId}`, {
  token: userToken,
  body: { name: 'hacked' },
});
expect('non-admin patch global → 404', r.status, 404);

log('\n--- [4.2] filter by kind=sub_agent (1) ---');
r = await req('GET', '/api/resources?kind=sub_agent', { token: userToken });
expect('kind filter returns 1', r.json.resources.length, 1);

log('\n--- [4.2] delete own resource (200) ---');
r = await req('DELETE', `/api/resources/${subAgentId}`, { token: userToken });
expect('delete own resource', r.status, 200);

log('\n--- [4.4] create a command resource (201) ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'command:explain-args',
    kind: 'command',
    name: 'Explain arguments',
    description: 'Echoes back the arguments passed',
    scope: 'personal',
    source: { type: 'inline', content: 'Explain these arguments: $ARGUMENTS' },
    targets: ['claude-code', 'zcode'],
  },
});
expect('command resource created', r.status, 201);
expect('resource kind is command', r.json.resource.kind, 'command');
const commandId = r.json.resource.id;

log('\n--- [4.4] filter by kind=command (1) ---');
r = await req('GET', '/api/resources?kind=command', { token: userToken });
expect('command filter returns 1', r.json.resources.length, 1);

log('\n--- [4.4] delete command resource (200) ---');
r = await req('DELETE', `/api/resources/${commandId}`, { token: userToken });
expect('delete command resource', r.status, 200);

log('\n--- [4.5] create a hook resource (201) ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'hook:lint-on-edit',
    kind: 'hook',
    name: 'Lint on edit',
    description: 'Runs the linter after Edit/Write',
    scope: 'personal',
    source: {
      type: 'inline',
      content: JSON.stringify({
        hooks: {
          PostToolUse: [
            { matcher: 'Edit|Write', hooks: [{ type: 'command', command: './lint.sh' }] },
          ],
        },
      }),
    },
    targets: ['claude-code', 'zcode'],
  },
});
expect('hook resource created', r.status, 201);
expect('resource kind is hook', r.json.resource.kind, 'hook');
const hookId = r.json.resource.id;

log('\n--- [4.5] hook targeting Hermes rejected (409) ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'hook:hermes-nope',
    kind: 'hook',
    name: 'nope',
    scope: 'personal',
    source: {
      type: 'inline',
      content: JSON.stringify({
        hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] },
      }),
    },
    targets: ['hermes'],
  },
});
expect('hermes hook target rejected', r.status, 409);
expect('error code TARGET_NO_DECLARATIVE_HOOKS', r.json.error, 'TARGET_NO_DECLARATIVE_HOOKS');

log('\n--- [4.5] hook with event unsupported by all targets rejected (409) ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'hook:bad-event',
    kind: 'hook',
    name: 'nope',
    scope: 'personal',
    source: {
      type: 'inline',
      // PreCompact is CC-only; zcode does not support it → unsupported by all
      // declared targets (zcode only).
      content: JSON.stringify({
        hooks: { PreCompact: [{ hooks: [{ type: 'command', command: 'x' }] }] },
      }),
    },
    targets: ['zcode'],
  },
});
expect('unsupported event rejected', r.status, 409);
expect('error code HOOK_EVENT_UNSUPPORTED', r.json.error, 'HOOK_EVENT_UNSUPPORTED');

log('\n--- [4.5] hook with invalid JSON rejected (400) ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'hook:bad-json',
    kind: 'hook',
    name: 'nope',
    scope: 'personal',
    source: { type: 'inline', content: 'not json{' },
    targets: ['claude-code'],
  },
});
expect('invalid hook json rejected', r.status, 400);

log('\n--- [4.5] delete hook resource (200) ---');
r = await req('DELETE', `/api/resources/${hookId}`, { token: userToken });
expect('delete hook resource', r.status, 200);

log('\n--- [4.6] create a single-file skill (inline) (201) ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'skill:hello',
    kind: 'skill',
    name: 'Hello skill',
    scope: 'personal',
    source: { type: 'inline', content: '---\nname: hello\ndescription: Says hello\n---\n# Hello' },
    targets: ['claude-code'],
  },
});
expect('single-file skill created', r.status, 201);
expect('resource kind is skill', r.json.resource.kind, 'skill');
const skillSingleId = r.json.resource.id;

log('\n--- [4.6] create a multi-file skill (inline-bundle) (201) ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'skill:gdrive',
    kind: 'skill',
    name: 'Google Drive skill',
    scope: 'personal',
    source: {
      type: 'inline-bundle',
      files: {
        'SKILL.md': '---\nname: gdrive\ndescription: Drive access\n---\n# GDrive',
        'references/search-syntax.md': '# Search syntax',
        'scripts/list.py': 'print("list")',
      },
    },
    targets: ['claude-code', 'zcode'],
  },
});
expect('multi-file skill created', r.status, 201);
expect('skill source is inline-bundle', r.json.resource.source.type, 'inline-bundle');
expect('skill bundle has 3 files', Object.keys(r.json.resource.source.files).length, 3);
const skillBundleId = r.json.resource.id;

log('\n--- [4.6] bundle missing SKILL.md rejected (409) ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'skill:no-md',
    kind: 'skill',
    name: 'nope',
    scope: 'personal',
    source: { type: 'inline-bundle', files: { 'references/x.md': '# x' } },
    targets: ['claude-code'],
  },
});
expect('bundle missing SKILL.md rejected', r.status, 409);
expect('error code SKILL_BUNDLE_MISSING_SKILL_MD', r.json.error, 'SKILL_BUNDLE_MISSING_SKILL_MD');

log('\n--- [4.6] bundle with path traversal rejected (400) ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'skill:traversal',
    kind: 'skill',
    name: 'nope',
    scope: 'personal',
    source: { type: 'inline-bundle', files: { 'SKILL.md': 'x', '../escape.md': 'evil' } },
    targets: ['claude-code'],
  },
});
expect('bundle path traversal rejected', r.status, 400);

log('\n--- [4.6] skill with git source rejected (409 INVALID_SKILL_SOURCE) ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'skill:git-nope',
    kind: 'skill',
    name: 'nope',
    scope: 'personal',
    source: { type: 'git', url: 'https://example.com/repo' },
    targets: ['claude-code'],
  },
});
expect('skill git source rejected', r.status, 409);
expect('error code INVALID_SKILL_SOURCE', r.json.error, 'INVALID_SKILL_SOURCE');

log('\n--- [4.6] filter by kind=skill (2) ---');
r = await req('GET', '/api/resources?kind=skill', { token: userToken });
expect('skill filter returns 2', r.json.resources.length, 2);

log('\n--- [4.6] delete both skills (200) ---');
r = await req('DELETE', `/api/resources/${skillSingleId}`, { token: userToken });
expect('delete single-file skill', r.status, 200);
r = await req('DELETE', `/api/resources/${skillBundleId}`, { token: userToken });
expect('delete multi-file skill', r.status, 200);

// ---------------------------------------------------------------------------
// Phase 7.1 — plugin source + trust/provenance labels
// ---------------------------------------------------------------------------

log('\n--- [7.1] skill with plugin source accepted; trust computed (trusted) ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'skill:plugin-trusted',
    kind: 'skill',
    name: 'trusted-plugin-skill',
    scope: 'personal',
    source: {
      type: 'plugin',
      source: { source: 'github', repo: 'anthropics/skills', sha: 'abc123def456' },
      plugin: 'skill-creator',
    },
    targets: ['claude-code'],
  },
});
expect('plugin skill created', r.status, 201);
expect('plugin source round-trips', r.json.resource.source.type, 'plugin');
expect('plugin inner source kind', r.json.resource.source.source.source, 'github');
expect('trust label = trusted', r.json.resource.labels?.trust, 'trusted');
expect('pin label = sha', r.json.resource.labels?.pin, 'abc123def456');
expect('provenance label set', typeof r.json.resource.labels?.provenance, 'string');

log('\n--- [7.1] community plugin, no pin (floating ref) ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'skill:plugin-community',
    kind: 'skill',
    name: 'community-plugin-skill',
    scope: 'personal',
    source: {
      type: 'plugin',
      source: { source: 'github', repo: 'random/dev' },
      plugin: 'thing',
    },
    targets: ['claude-code'],
  },
});
expect('community plugin skill created', r.status, 201);
expect('trust label = community', r.json.resource.labels?.trust, 'community');
expect('no pin label when floating', r.json.resource.labels?.pin, undefined);

log('\n--- [7.1] unsafe plugin path rejected (400) ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'skill:plugin-badpath',
    kind: 'skill',
    name: 'badpath',
    scope: 'personal',
    source: {
      type: 'plugin',
      source: { source: 'github', repo: 'anthropics/skills', path: '../etc/passwd' },
      plugin: 'x',
    },
    targets: ['claude-code'],
  },
});
expect('unsafe plugin path rejected', r.status, 400);

log('\n--- [7.1] npm plugin source requires version ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'skill:plugin-npm-no-version',
    kind: 'skill',
    name: 'npm-no-version',
    scope: 'personal',
    // version omitted at the plugin level AND the inner source level — zod
    // rejects (inner .version is required), so this is a 400 VALIDATION_ERROR
    // before our handler-level check runs.
    source: {
      type: 'plugin',
      source: { source: 'npm', package: '@org/foo' },
      plugin: 'foo',
    },
    targets: ['claude-code'],
  },
});
expect('npm plugin without version rejected', r.status, 400);

log('\n--- [7.1] cleanup plugin skills ---');
r = await req('GET', '/api/resources?kind=skill', { token: userToken });
for (const res of r.json.resources) {
  if (res.source.type === 'plugin') {
    const del = await req('DELETE', `/api/resources/${res.id}`, { token: userToken });
    expect(`delete ${res.key}`, del.status, 200);
  }
}

// ---------------------------------------------------------------------------
// Phase 7.2 — marketplace allowlist fetch
// Server must be booted with MARKETPLACE_FIXTURE_PATH=scripts/fixtures/
// marketplace.json so the catalog fetcher reads the local fixture instead of
// hitting GitHub. The fixture has 6 plugins: 4 object-sourced (git-subdir×1,
// url×2, github×1) + 2 relative-path-sourced (must be filtered out).
// ---------------------------------------------------------------------------

log('\n--- [7.2] list configured marketplaces ---');
r = await req('GET', '/api/skills/marketplaces', { token: userToken });
expect('marketplaces list ok', r.status, 200);
expect(
  'default marketplace present',
  r.json.marketplaces.some((m) => m.id === 'claude-plugins-official'),
  true,
);

log('\n--- [7.2] fetch catalog; relative-path sources filtered out ---');
r = await req('GET', '/api/skills/marketplaces/claude-plugins-official/plugins', {
  token: userToken,
});
expect('catalog fetch ok', r.status, 200);
expect('4 plugins after filtering 2 relative-path', r.json.plugins.length, 4);
const sourceKinds = r.json.plugins.map((p) => p.source.source).sort();
expect(
  'source kinds are object kinds only',
  JSON.stringify(sourceKinds),
  JSON.stringify(['git-subdir', 'github', 'url', 'url']),
);

log('\n--- [7.2] filter by category=security ---');
r = await req('GET', '/api/skills/marketplaces/claude-plugins-official/plugins?category=security', {
  token: userToken,
});
expect('security filter ok', r.status, 200);
expect('2 security plugins', r.json.plugins.length, 2);
expect(
  'all returned are security',
  r.json.plugins.every((p) => p.category === 'security'),
  true,
);

log('\n--- [7.2] free-text search q=artifact ---');
r = await req('GET', '/api/skills/marketplaces/claude-plugins-official/plugins?q=artifact', {
  token: userToken,
});
expect('search ok', r.status, 200);
expect('search matches 1 (jfrog description)', r.json.plugins.length, 1);
expect('matched plugin is jfrog', r.json.plugins[0].name, 'jfrog');

log('\n--- [7.2] non-allowlisted marketplace id → 404 ---');
r = await req('GET', '/api/skills/marketplaces/evil-untrusted/plugins', { token: userToken });
expect('non-allowlisted 404', r.status, 404);
expect('error code MARKETPLACE_NOT_ALLOWED', r.json.error, 'MARKETPLACE_NOT_ALLOWED');

log('\n--- [7.2] second catalog read hits cache (same result set) ---');
r = await req('GET', '/api/skills/marketplaces/claude-plugins-official/plugins', {
  token: userToken,
});
expect('cached read ok', r.status, 200);
expect('cached result still 4 plugins', r.json.plugins.length, 4);

log('\n--- [7.2] unauthenticated request → 401 ---');
r = await req('GET', '/api/skills/marketplaces');
expect('no-token 401', r.status, 401);

// ---------------------------------------------------------------------------
// Phase 7.4 — multi-source search
// Server booted with SKILL_DISABLED_SOURCES=github,well-known,url so the search
// router only runs the marketplace source (against the 7.2 fixture). This
// verifies the /api/skills/search endpoint, the dispatch/merge/dedupe pipeline,
// and trust ranking, without hitting GitHub. The per-adapter fetch logic is
// covered by typecheck + manual verification (like 7.3's UI).
// ---------------------------------------------------------------------------

log('\n--- [7.4] search requires ?q= (400) ---');
r = await req('GET', '/api/skills/search', { token: userToken });
expect('search without q → 400', r.status, 400);

log('\n--- [7.4] search dispatches to marketplace source ---');
r = await req('GET', '/api/skills/search?q=artifact', { token: userToken });
expect('search ok', r.status, 200);
expect('returns array', Array.isArray(r.json.results), true);
// marketplace source finds the jfrog plugin (description mentions 'artifact').
expect(
  'marketplace result present',
  r.json.results.some((m) => m.source === 'marketplace' && m.name === 'jfrog'),
  true,
);
// every result carries an identifier + trustLevel (merge contract).
expect(
  'all results have identifier',
  r.json.results.every((m) => typeof m.identifier === 'string'),
  true,
);
expect(
  'all results have trustLevel',
  r.json.results.every(
    (m) => m.trustLevel === 'trusted' || m.trustLevel === 'community' || m.trustLevel === 'builtin',
  ),
  true,
);

log('\n--- [7.4] search result carries precomputed pluginSource in extra ---');
const jfrog = r.json.results.find((m) => m.name === 'jfrog');
expect('jfrog has extra.pluginSource', typeof jfrog.extra?.pluginSource, 'object');
expect('pluginSource is the plugin variant', jfrog.extra.pluginSource?.type, 'plugin');

log('\n--- [7.4] timedOut/errored arrays are present (may be empty) ---');
expect('timedOut is array', Array.isArray(r.json.timedOut), true);
expect('errored is array', Array.isArray(r.json.errored), true);

log('\n--- [7.4] trust ranking — anthropics/skills entry → trusted ---');
// The fixture's 42crunch (git-subdir, 42Crunch-AI owner) is community; if the
// fixture had an anthropics/skills entry it would surface as trusted. Assert
// the tier contract by checking community tiers round-trip correctly.
r = await req('GET', '/api/skills/search?q=42crunch', { token: userToken });
expect('search finds 42crunch', r.status, 200);
const crunch = r.json.results.find((m) => m.name.includes('42crunch'));
expect('42crunch is community trust', crunch.trustLevel, 'community');

log('\n--- [8 C1] enroll a machine ---');
r = await req('POST', '/api/machines', { token: userToken, body: { name: 'smoke-laptop' } });
expect('enroll status', r.status, 201);
expect('machine starts offline', r.json.machine.online, false);
const machineId = r.json.machine.id;
const machineToken = r.json.token;

log('\n--- [8 C1] machine token is rejected by the REST API ---');
r = await req('GET', '/api/machines', { token: machineToken });
expect('machine token REST status', r.status, 401);

log('\n--- [8 C1] daemon connects over /ctl, says hello, comes online ---');
const { io } = await import('socket.io-client');
const ctl = io(`${B}/ctl`, {
  auth: { token: machineToken, machineId },
  transports: ['websocket'],
});
await new Promise((resolve, reject) => {
  ctl.on('connect', resolve);
  ctl.on('connect_error', reject);
  setTimeout(() => reject(new Error('connect timeout')), 5000);
});
const helloAck = await new Promise((resolve, reject) => {
  ctl.emit(
    'machine:hello',
    {
      daemonVersion: '0.1.0-smoke',
      os: 'linux',
      arch: 'x64',
      hostname: 'smokebox',
      capabilities: [],
    },
    resolve,
  );
  setTimeout(() => reject(new Error('hello ack timeout')), 5000);
});
expect('hello ack proto', helloAck.proto, 1);
expect('hello ack machineId', helloAck.machineId, machineId);
let online = false;
let meta = null;
for (let i = 0; i < 50 && !online; i++) {
  r = await req('GET', `/api/machines/${machineId}`, { token: userToken });
  online = r.json.machine.online;
  meta = r.json.machine;
  if (!online) await new Promise((s) => setTimeout(s, 100));
}
expect('machine online after daemon connect', online, true);
expect('daemon metadata persisted', meta.daemonVersion, '0.1.0-smoke');
expect('hostname persisted', meta.hostname, 'smokebox');

log('\n--- [8 C1] malformed hello is rejected with proto:invalid ---');
const badAck = await new Promise((resolve) => {
  ctl.emit('machine:hello', { daemonVersion: '' }, resolve);
  setTimeout(() => resolve(null), 5000);
});
expect('proto:invalid ack', badAck && badAck.error, 'proto:invalid');

log('\n--- [8 C1] daemon disconnect → machine offline ---');
ctl.close();
let offline = false;
for (let i = 0; i < 50 && !offline; i++) {
  r = await req('GET', `/api/machines/${machineId}`, { token: userToken });
  offline = !r.json.machine.online;
  if (!offline) await new Promise((s) => setTimeout(s, 100));
}
expect('machine offline after daemon disconnect', offline, true);

log('\n--- [8 C1] removing the machine revokes its token ---');
r = await req('DELETE', `/api/machines/${machineId}`, { token: userToken });
expect('revoke status', r.status, 200);
r = await req('GET', `/api/machines/${machineId}`, { token: userToken });
expect('machine gone (404)', r.status, 404);
const revoked = io(`${B}/ctl`, {
  auth: { token: machineToken, machineId },
  transports: ['websocket'],
});
const refused = await new Promise((resolve) => {
  revoked.on('connect_error', () => resolve(true));
  revoked.on('connect', () => resolve(false));
  setTimeout(() => resolve(false), 5000);
});
expect('revoked token cannot reconnect', refused, true);
revoked.close();

// ============================ Phase 8 C2: client MCP serving ============================

log('\n--- [8 C2] credentials: personal + locked global + distributable global ---');
r = await req('POST', '/api/credentials', {
  token: userToken,
  body: { name: 'smoke-mine', secret: 'mine-plaintext', scope: 'personal' },
});
expect('personal cred created', r.status, 201);
expect('personal is distributable', r.json.credential.distributable, true);
r = await req('POST', '/api/credentials', {
  token: adminToken,
  body: { name: 'smoke-corp', secret: 'corp-locked-plaintext', scope: 'global' },
});
expect('locked global created', r.status, 201);
expect('locked global NOT distributable (default)', r.json.credential.distributable, false);
r = await req('POST', '/api/credentials', {
  token: adminToken,
  body: { name: 'smoke-shared', secret: 'shared-plaintext', scope: 'global', distributable: true },
});
expect('distributable global created', r.json.credential.distributable, true);

log('\n--- [8 C2] mcp servers across the dial-site matrix ---');
const mkServer = (body, token = userToken) => req('POST', '/api/mcp-servers', { token, body });
r = await mkServer({
  name: 'smoke-api-mine',
  transport: { type: 'streamable-http', url: 'https://api.example/mcp?k=${cred:smoke-mine}' },
  dialSite: 'auto',
  scope: 'personal',
});
expect('personal-cred server created', r.status, 201);
const apiMineId = r.json.mcpServer.id;
r = await mkServer({
  name: 'smoke-api-corp',
  transport: {
    type: 'streamable-http',
    url: 'https://corp.example/mcp',
    headers: { Authorization: 'Bearer ${cred:smoke-corp}' },
  },
  dialSite: 'auto',
  scope: 'personal',
});
expect('locked-cred server created', r.status, 201);
const apiCorpId = r.json.mcpServer.id;
r = await mkServer({
  name: 'smoke-stdio-mine',
  transport: { type: 'stdio', command: 'echo-bin', args: ['${cred:smoke-mine}'] },
  dialSite: 'auto',
  scope: 'personal',
});
expect('stdio server created (no direct-mode forcing anymore)', r.status, 201);
const stdioMineId = r.json.mcpServer.id;
r = await mkServer({
  name: 'smoke-bad-client',
  transport: { type: 'streamable-http', url: 'https://x.example/${cred:smoke-corp}' },
  dialSite: 'client',
  scope: 'personal',
});
expect('client dial + locked cred → 409', r.status, 409);
expect('error code CREDENTIAL_NOT_DISTRIBUTABLE', r.json.error, 'CREDENTIAL_NOT_DISTRIBUTABLE');

log('\n--- [8 C2] profile + config fetch contract ---');
r = await req('POST', '/api/profiles', {
  token: userToken,
  body: {
    name: 'smoke-mixed',
    target: 'claude-code',
    scope: 'personal',
    entries: [{ mcpServerId: apiMineId }, { mcpServerId: apiCorpId }, { mcpServerId: stdioMineId }],
  },
});
expect('profile created', r.status, 201);
const mixedProfileId = r.json.profile.id;

r = await req('GET', `/api/client/mcp-config?profile=${mixedProfileId}`, { token: userToken });
expect('config fetch 200', r.status, 200);
const cfg = r.json;
const byName = new Map(cfg.servers.map((s) => [s.name, s]));
expect(
  'client-dialed http resolved',
  byName.get('smoke-api-mine').transport.url,
  'https://api.example/mcp?k=mine-plaintext',
);
expect('stdio resolved', byName.get('smoke-stdio-mine').transport.args[0], 'mine-plaintext');
expect('server-dialed has NO transport', byName.get('smoke-api-corp').transport, undefined);
expect('platform block present', cfg.platform !== null, true);
expect(
  'locked plaintext NEVER in response',
  JSON.stringify(cfg).includes('corp-locked-plaintext'),
  false,
);

log('\n--- [8 C2] machine PAT is accepted by the config fetch (the one REST exception) ---');
r = await req('POST', '/api/machines', { token: userToken, body: { name: 'c2-laptop' } });
const c2MachineToken = r.json.token;
r = await req('GET', `/api/client/mcp-config?profile=${mixedProfileId}`, { token: c2MachineToken });
expect('machine PAT config fetch 200', r.status, 200);
r = await req('GET', `/api/client/mcp-config?profile=${mixedProfileId}`);
expect('anonymous config fetch 401', r.status, 401);
r = await req('GET', '/api/client/mcp-config', { token: userToken });
expect('missing profile param 400', r.status, 400);

// ============================ Phase 8 C3: inventory + diff + import ============================

log('\n--- [8 C3] fixture HOME + REAL daemon (dist) enrollment ---');
const { spawn } = await import('node:child_process');
const {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  accessSync,
  readFileSync,
  statSync,
  chmodSync,
  readdirSync,
} = await import('node:fs');
const { tmpdir } = await import('node:os');
const pathMod = await import('node:path');
// Rig hygiene: every run below leaves `hnx-smoke-*` directories behind (fixture
// HOME, CLI shims, synthetic projects) — a dozen of them had piled up in /tmp.
// Sweep the previous runs' directories here, at the start; files are left
// alone, because that is where run LOGS live.
for (const entry of readdirSync(tmpdir())) {
  if (!entry.startsWith('hnx-smoke-')) continue;
  const stale = pathMod.join(tmpdir(), entry);
  try {
    if (statSync(stale).isDirectory()) rmSync(stale, { recursive: true, force: true });
  } catch {
    /* another run still owns it */
  }
}
const fixtureHome = mkdtempSync(pathMod.join(tmpdir(), 'hnx-smoke-c3-'));
const fw = (rel, content) => {
  const file = pathMod.join(fixtureHome, rel);
  mkdirSync(pathMod.dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
};
fw(
  '.claude/skills/smoke-skill/SKILL.md',
  '---\nname: smoke-skill\ndescription: Smoke skill\n---\n\nSmoke skill body.\n',
);
fw('.claude/commands/smoke-command.md', 'A smoke command body.\n');
fw('.claude/skills/huge-skill/SKILL.md', 'x'.repeat(300 * 1024)); // over the 256 KiB cap
fw(
  '.claude.json',
  JSON.stringify({
    mcpServers: {
      'smoke-mcp-local': {
        command: 'npx',
        args: ['-y', 'smoke-mcp'],
        env: { SMOKE_KEY: 'ghp-SMOKE-SECRET-VALUE' },
      },
    },
  }),
);
fw('.codex/skills/codex-skill/SKILL.md', 'Codex skill body.\n');
fw('.codex/prompts/smoke-prompt.md', 'Codex prompt body.\n');
fw(
  '.dsh/skills/dsh-skill/SKILL.md',
  '---\nname: dsh-skill\ndescription: DSH smoke skill\n---\n\nDSH skill body.\n',
);
fw(
  '.dsh/skills/dsh-cmd.md',
  '---\nname: dsh-cmd\ndescription: DSH smoke command\n---\nDSH command body.\n',
);
fw(
  '.dsh/cordis.patch.yml',
  [
    '- insert:',
    '    - id: mcp-web',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: web',
    '        transport: streamable-http',
    "        url: 'http://localhost:9/mcp'",
    '# BEGIN harness-nexus:smoke (managed)',
    '- insert:',
    '    - id: hnx-mcp-smoke',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: harness-nexus-smoke',
    '        transport: stdio',
    "        command: '/usr/local/bin/hnx'",
    "        args: ['mcp', 'serve']",
    '# END harness-nexus:smoke (managed)',
    '',
  ].join('\n'),
);

r = await req('POST', '/api/machines', { token: userToken, body: { name: 'c3-laptop' } });
expect('c3 enroll status', r.status, 201);
const c3MachineId = r.json.machine.id;
const c3Token = r.json.token;

const daemonProc = spawn(
  process.execPath,
  [
    'packages/cli/dist/index.js',
    'daemon',
    '--server',
    B,
    '--token',
    c3Token,
    '--machine-id',
    c3MachineId,
  ],
  { env: { ...process.env, HOME: fixtureHome }, stdio: ['ignore', 'pipe', 'pipe'] },
);
let daemonErr = '';
daemonProc.stderr.on('data', (d) => {
  daemonErr += d.toString();
});
let c3online = false;
for (let i = 0; i < 100 && !c3online; i++) {
  r = await req('GET', `/api/machines/${c3MachineId}`, { token: userToken });
  c3online = r.json.machine.online;
  if (!c3online) await new Promise((s2) => setTimeout(s2, 100));
}
expect('real daemon online', c3online, true);
r = await req('GET', `/api/machines/${c3MachineId}`, { token: userToken });
expect(
  'daemon advertises inventory capability',
  r.json.machine.capabilities.includes('inventory'),
  true,
);

log('\n--- [8 C3] scan via the real daemon → stored snapshots ---');
r = await req('POST', `/api/machines/${c3MachineId}/inventory/scan`, {
  token: userToken,
  body: {},
});
expect('scan status', r.status, 200);
expect('scanned 6 targets', r.json.inventory.length, 6); // claude-code/codex/hermes/deepseek/opencode/pi
const ccSnap = r.json.inventory.find((i) => i.target === 'claude-code');
expect('cc snapshot has an agent', ccSnap.agents.length, 1);
const ccItems = ccSnap.agents[0].items;
expect(
  'skill discovered',
  ccItems.some((i) => i.kind === 'skill' && i.name === 'smoke-skill' && i.origin === 'local'),
  true,
);
expect(
  'oversized skill not importable',
  ccItems.find((i) => i.name === 'huge-skill').importable,
  false,
);
expect(
  'mcp discovered',
  ccItems.some((i) => i.kind === 'mcp' && i.name === 'smoke-mcp-local'),
  true,
);
expect(
  'command discovered',
  ccItems.some((i) => i.kind === 'command' && i.name === 'smoke-command'),
  true,
);
const codexSnap = r.json.inventory.find((i) => i.target === 'codex');
expect(
  'codex prompt discovered',
  codexSnap.agents[0].items.some((i) => i.name === 'smoke-prompt'),
  true,
);
const dshSnap = r.json.inventory.find((i) => i.target === 'deepseek');
expect(
  'dsh bundle skill discovered',
  dshSnap.agents[0].items.some((i) => i.kind === 'skill' && i.name === 'dsh-skill'),
  true,
);
expect(
  'dsh flat command discovered',
  dshSnap.agents[0].items.some((i) => i.kind === 'command' && i.name === 'dsh-cmd'),
  true,
);
expect(
  'dsh platform mcp via harness-nexus serverName marker',
  dshSnap.agents[0].items.find((i) => i.name === 'harness-nexus-smoke')?.origin,
  'platform',
);
expect(
  'dsh user mcp is local origin',
  dshSnap.agents[0].items.find((i) => i.name === 'web')?.origin,
  'local',
);
const hermesSnap = r.json.inventory.find((i) => i.target === 'hermes');
expect('absent hermes home is an empty snapshot', hermesSnap.agents[0].items.length, 0);

log('\n--- [8 C3] import → resources + McpServer + profile (secrets redacted daemon-side) ---');
r = await req('POST', `/api/machines/${c3MachineId}/inventory/import`, {
  token: userToken,
  body: {
    target: 'claude-code',
    profileName: 'C3 smoke import',
    items: [
      { kind: 'skill', name: 'smoke-skill' },
      { kind: 'command', name: 'smoke-command' },
      { kind: 'mcp', name: 'smoke-mcp-local' },
    ],
  },
});
expect('import status', r.status, 200);
expect('created 3', r.json.created.length, 3);
expect('reused 0', r.json.reused.length, 0);
expect(
  'env plaintext NEVER crosses to the server',
  JSON.stringify(r.json).includes('ghp-SMOKE-SECRET-VALUE'),
  false,
);
expect(
  'missing-credential warning present',
  r.json.warnings.some((w) => w.includes('SMOKE_KEY')),
  true,
);
const c3ProfileId = r.json.profile.id;
r = await req('GET', '/api/mcp-servers', { token: userToken });
const imported = r.json.mcpServers.find((m) => m.name === 'smoke-mcp-local');
expect('mcp row created personal', imported.scope, 'personal');
expect('mcp env is a placeholder', imported.transport.env.SMOKE_KEY, '\${cred:SMOKE_KEY}');

log('\n--- [8 C3] re-import is a full reuse (idempotent) ---');
r = await req('POST', `/api/machines/${c3MachineId}/inventory/import`, {
  token: userToken,
  body: {
    target: 'claude-code',
    profileName: 'C3 smoke import again',
    items: [
      { kind: 'skill', name: 'smoke-skill' },
      { kind: 'command', name: 'smoke-command' },
      { kind: 'mcp', name: 'smoke-mcp-local' },
    ],
  },
});
expect('re-import status', r.status, 200);
expect('nothing new created', r.json.created.length, 0);
expect('all three reused', r.json.reused.length, 3);

log('\n--- [8 C3] diff: name-matched entries applied, mcp arm missing until installed ---');
r = await req('GET', `/api/machines/${c3MachineId}/inventory/diff?profile=${c3ProfileId}`, {
  token: userToken,
});
expect('diff status', r.status, 200);
expect(
  'skill applied by name',
  r.json.diff.upToDate.some((u) => u.name === 'smoke-skill'),
  true,
);
expect(
  'mcp arm missing (no shim installed)',
  r.json.diff.missingOnMachine.map((m) => m.name).join(','),
  'smoke-mcp-local',
);

log('\n--- [8 C3] import of an unimportable item is refused ---');
r = await req('POST', `/api/machines/${c3MachineId}/inventory/import`, {
  token: userToken,
  body: {
    target: 'claude-code',
    profileName: 'should fail',
    items: [{ kind: 'skill', name: 'huge-skill' }],
  },
});
expect('unimportable rejected', r.status, 409);
expect('unimportable code', r.json.error, 'INVENTORY_ITEM_NOT_IMPORTABLE');

log('\n--- [8 C3] machine removal cascades inventory rows ---');
daemonProc.kill('SIGTERM');
await new Promise((resolve) => {
  daemonProc.once('exit', resolve);
  setTimeout(resolve, 3000);
});
r = await req('DELETE', `/api/machines/${c3MachineId}`, { token: userToken });
expect('c3 machine removed', r.status, 200);
rmSync(fixtureHome, { recursive: true, force: true });
if (daemonErr.includes('Error:')) {
  log(
    `(daemon stderr note): ${daemonErr
      .split('\n')
      .filter((l) => l.includes('Error:'))
      .slice(0, 3)
      .join(' | ')}`,
  );
}

// ========================= Phase 8 T1: deepseek-harness target =========================

log('\n--- [8 T1] deepseek profile install via the REAL CLI (dist) → ~/.dsh ---');
// A skill with NO frontmatter (proves synthesis) + a command + an MCP entry.
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'skill:t1-skill',
    kind: 'skill',
    name: 'T1 Skill',
    description: 'Synthesizes frontmatter on install',
    scope: 'personal',
    source: { type: 'inline', content: '# T1 skill body (no frontmatter)\n' },
    targets: ['deepseek'],
  },
});
expect('t1 skill resource created', r.status, 201);
const t1SkillId = r.json.resource.id;
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'command:t1-cmd',
    kind: 'command',
    name: 't1-cmd',
    description: 'A flat dsh command skill',
    scope: 'personal',
    source: { type: 'inline', content: 'T1 command body.\n' },
    targets: ['deepseek'],
  },
});
expect('t1 command resource created', r.status, 201);
const t1CmdId = r.json.resource.id;
r = await req('POST', '/api/mcp-servers', {
  token: userToken,
  body: {
    name: 't1-upstream',
    transport: { type: 'streamable-http', url: 'https://t1.example.com/mcp' },
    dialSite: 'client',
    scope: 'personal',
  },
});
expect('t1 mcp server created', r.status, 201);
const t1McpId = r.json.mcpServer.id;
r = await req('POST', '/api/profiles', {
  token: userToken,
  body: {
    name: 't1-dsh-kit',
    target: 'deepseek',
    scope: 'personal',
    entries: [
      { resourceId: t1SkillId, kind: 'skill' },
      { resourceId: t1CmdId, kind: 'command' },
      { mcpServerId: t1McpId },
    ],
  },
});
expect('t1 deepseek profile created', r.status, 201);
const t1ProfileId = r.json.profile.id;

const t1Home = mkdtempSync(pathMod.join(tmpdir(), 'hnx-smoke-t1-'));
const t1Root = pathMod.join(t1Home, '.dsh');
const t1Run = await new Promise((resolve) => {
  const p = spawn(
    process.execPath,
    [
      'packages/cli/dist/index.js',
      'install',
      '--profile',
      t1ProfileId,
      '--server',
      B,
      '--token',
      userToken,
      '--target',
      'deepseek',
      '--out',
      t1Root,
      '--apply',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let err = '';
  p.stderr.on('data', (d) => {
    err += d.toString();
  });
  p.on('exit', (code) => resolve({ code, err }));
});
expect('deepseek install exit code', t1Run.code, 0);
if (t1Run.code !== 0) log(`(t1 install stderr): ${t1Run.err.split('\n').slice(0, 4).join(' | ')}`);

const { readFileSync: rf } = await import('node:fs');
const t1Skill = rf(pathMod.join(t1Root, 'skills', 't1-skill', 'SKILL.md'), 'utf8');
expect(
  'skill frontmatter synthesized (dsh requires name+description)',
  t1Skill.startsWith(
    '---\nname: t1-skill\ndescription: "Synthesizes frontmatter on install"\n---\n',
  ),
  true,
);
expect(
  'flat command written',
  rf(pathMod.join(t1Root, 'skills', 't1-cmd.md'), 'utf8').includes('T1 command body.'),
  true,
);
const t1Patch = rf(pathMod.join(t1Root, 'cordis.patch.yml'), 'utf8');
expect(
  'patch mounts the mcp bridge',
  t1Patch.includes("name: '@deepseek-ai/dsh-mcp-client'"),
  true,
);
expect(
  'patch row targets our profile outlet',
  t1Patch.includes(`"--profile", "${t1ProfileId}"`),
  true,
);
expect(
  'patch serverName platform-prefixed',
  t1Patch.includes('serverName: harness-nexus-t1-dsh-kit'),
  true,
);
expect(
  'ledger written',
  rf(pathMod.join(t1Root, 'harness-nexus-install-state.json'), 'utf8').includes('deepseek'),
  true,
);

// Re-planning is an idempotent overwrite of OUR marked region only.
const t1Run2 = await new Promise((resolve) => {
  const p = spawn(
    process.execPath,
    [
      'packages/cli/dist/index.js',
      'install',
      '--profile',
      t1ProfileId,
      '--server',
      B,
      '--token',
      userToken,
      '--target',
      'deepseek',
      '--out',
      t1Root,
      '--apply',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  p.on('exit', (code) => resolve({ code }));
});
expect('deepseek reinstall (upgrade path) exit code', t1Run2.code, 0);
const t1Patch2 = rf(pathMod.join(t1Root, 'cordis.patch.yml'), 'utf8');
// the serverName line is the only occurrence of the dashed form (markers use a colon)
expect(
  'managed region not duplicated by reinstall',
  t1Patch2.split('serverName: harness-nexus-t1-dsh-kit').length - 1,
  1,
);
rmSync(t1Home, { recursive: true, force: true });

// ============================ Phase 8 C4: jobs + remote deploy ============================

log('\n--- [8 C4] deployable profile + offline queue ---');
r = await req('POST', '/api/resources', {
  token: userToken,
  body: {
    key: 'skill:smoke-deploy',
    kind: 'skill',
    name: 'smoke-deploy',
    description: 'Deployed by a C4 job',
    scope: 'personal',
    source: { type: 'inline', content: '# smoke-deploy\n\nDeployed body.' },
    targets: ['hermes'],
  },
});
expect('deploy skill resource created', r.status, 201);
const deployResourceId = r.json.resource.id;
r = await req('POST', '/api/profiles', {
  token: userToken,
  body: {
    name: 'c4-deploy',
    version: '1.0.0',
    target: 'hermes',
    scope: 'personal',
    entries: [{ resourceId: deployResourceId, kind: 'skill' }],
  },
});
expect('deploy profile created', r.status, 201);
const deployProfileId = r.json.profile.id;

const c4Home = mkdtempSync(pathMod.join(tmpdir(), 'hnx-smoke-c4-'));
r = await req('POST', '/api/machines', { token: userToken, body: { name: 'c4-box' } });
const c4MachineId = r.json.machine.id;
r = await req('POST', `/api/machines/${c4MachineId}/jobs`, {
  token: userToken,
  body: { profileId: deployProfileId },
});
expect('offline deploy queues (201)', r.status, 201);
expect('job starts queued', r.json.job.status, 'queued');
const c4Job1 = r.json.job.id;

log('\n--- [8 C4] REAL daemon deploys via the 3.3 pipeline ---');
r = await req('POST', '/api/machines', { token: userToken, body: { name: 'c4-live' } });
const c4LiveId = r.json.machine.id;
const c4LiveToken = r.json.token;
r = await req('POST', `/api/machines/${c4LiveId}/jobs`, {
  token: userToken,
  body: { profileId: deployProfileId },
});
expect('live-box offline deploy also queues', r.json.job.status, 'queued');
const c4Job2 = r.json.job.id;

const c4Daemon = spawn(
  process.execPath,
  [
    'packages/cli/dist/index.js',
    'daemon',
    '--server',
    B,
    '--token',
    c4LiveToken,
    '--machine-id',
    c4LiveId,
  ],
  { env: { ...process.env, HOME: c4Home }, stdio: ['ignore', 'pipe', 'pipe'] },
);
let c4Err = '';
c4Daemon.stderr.on('data', (d) => {
  c4Err += d.toString();
});

let c4job = null;
for (let i = 0; i < 150; i++) {
  r = await req('GET', `/api/machines/${c4LiveId}/jobs`, { token: userToken });
  c4job = r.json.jobs.find((j) => j.id === c4Job2);
  if (c4job && (c4job.status === 'succeeded' || c4job.status === 'failed')) break;
  await new Promise((s2) => setTimeout(s2, 200));
}
expect('deploy job succeeded', c4job?.status, 'succeeded');
expect('deploy error empty', c4job?.error ?? null, null);

r = await req('GET', `/api/machines/${c4LiveId}/agents`, { token: userToken });
// W1: detected instances (host PATH runtimes) may coexist — count deploy rows.
const c4DeployRow = r.json.agents.find((a) => a.profileId !== null);
expect('one DEPLOY agent instance registered', c4DeployRow !== undefined, true);
expect(
  'instance directory is the fixture hermes home',
  c4DeployRow.directory,
  pathMod.join(c4Home, '.hermes'),
);
// The body above still sends `version: '1.0.0'` — #18 ignores it, so the
// deployed instance carries the server-assigned initial version.
expect('instance carries profile version', c4DeployRow.profileVersion, '0.1');
expect('deploy-bundle secret-free (machine PAT path worked — job succeeded)', true, true);

const pluginDir = pathMod.join(c4Home, '.hermes', 'plugins', 'c4-deploy');
const exists = (p) => {
  try {
    accessSync(p);
    return true;
  } catch {
    return false;
  }
};
expect('plugin.yaml written by the pipeline', exists(pathMod.join(pluginDir, 'plugin.yaml')), true);
expect(
  'skill file written',
  exists(pathMod.join(pluginDir, 'skills', 'smoke-deploy', 'SKILL.md')),
  true,
);
expect(
  'install-state ledger written',
  exists(pathMod.join(c4Home, '.hermes', 'harness-nexus-install-state.json')),
  true,
);

log('\n--- [8 C4] redeploy upgrades the same instance ---');
r = await req('POST', `/api/machines/${c4LiveId}/jobs`, {
  token: userToken,
  body: { profileId: deployProfileId },
});
const c4Job3 = r.json.job.id;
expect('redeploy dispatches immediately (daemon online)', r.json.job.status, 'dispatched');
for (let i = 0; i < 150; i++) {
  r = await req('GET', `/api/machines/${c4LiveId}/jobs`, { token: userToken });
  c4job = r.json.jobs.find((j) => j.id === c4Job3);
  if (c4job && (c4job.status === 'succeeded' || c4job.status === 'failed')) break;
  await new Promise((s2) => setTimeout(s2, 200));
}
expect('redeploy succeeded', c4job?.status, 'succeeded');
r = await req('GET', `/api/machines/${c4LiveId}/agents`, { token: userToken });
const c4RedeployRows = r.json.agents.filter((a) => a.profileId !== null);
expect('still exactly one deploy instance (upsert)', c4RedeployRows.length, 1);
expect('instance upgraded by job 3', c4RedeployRows[0].jobId, c4Job3);

log('\n--- [#6] claude-code marketplace deploy via a FAKE claude shim ---');
// The executor drives `claude plugin …` headless — here that CLI is a shim on
// the daemon's PATH recording argv and maintaining CC's own state files under
// the fixture HOME (same trick as the [9 W2] fake npm). Two jobs: fresh
// install (installed 1.0.0), then one-click update (the shim reports 2.0.0).
// The second job stands in for the post-bump deploy: since #18 the version
// bump (entries change) is what publishes an update, and this profile has no
// entries to change — the daemon's update/install choice reads CC's own
// state, so re-running the job is the same code path.
r = await req('POST', '/api/profiles', {
  token: userToken,
  body: { name: 'c4-cc', target: 'claude-code', scope: 'personal', entries: [] },
});
const ccProfileId = r.json.profile.id;
r = await req('PATCH', `/api/profiles/${ccProfileId}`, {
  token: userToken,
  body: { version: '1.1.0' },
});
expect('client-sent version ignored (#18)', r.json.profile.version, '0.1');

r = await req('POST', '/api/machines', { token: userToken, body: { name: 'c4-cc-box' } });
const c4CcMachineId = r.json.machine.id;
const c4CcToken = r.json.token;

const ccShimDir = mkdtempSync(pathMod.join(tmpdir(), 'hnx-smoke-cc-shim-'));
writeFileSync(
  pathMod.join(ccShimDir, 'claude'),
  `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(process.env.HOME, '.claude', 'plugins');
fs.mkdirSync(dir, { recursive: true });
fs.appendFileSync(path.join(dir, 'argv.log'), process.argv.slice(2).join(' ') + '\\n');
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return d; } };
const write = (f, v) => fs.writeFileSync(path.join(dir, f), JSON.stringify(v, null, 2));
const [cmd, sub, ...rest] = process.argv.slice(2);
if (cmd === 'plugin' && sub === 'marketplace') {
  const [action, arg] = rest;
  if (action === 'add') { const k = read('known_marketplaces.json', {}); k['harness-nexus-smoke-user'] = { source: { source: 'url', url: arg } }; write('known_marketplaces.json', k); process.exit(0); }
  if (action === 'update') process.exit(0);
  if (action === 'remove') { const k = read('known_marketplaces.json', {}); delete k[arg]; write('known_marketplaces.json', k); process.exit(0); }
  process.exit(1);
}
if (cmd === 'plugin' && (sub === 'install' || sub === 'update')) {
  const [pluginId] = rest;
  const cur = read('installed_plugins.json', { version: 2, plugins: {} });
  const rows = (cur.plugins[pluginId] = cur.plugins[pluginId] || [{ scope: 'user' }]);
  rows[0].version = sub === 'update' ? '2.0.0' : '1.0.0';
  write('installed_plugins.json', cur);
  process.exit(0);
}
process.exit(1);
`,
  'utf8',
);
chmodSync(pathMod.join(ccShimDir, 'claude'), 0o755);

const c4CcDaemon = spawn(
  process.execPath,
  [
    'packages/cli/dist/index.js',
    'daemon',
    '--server',
    B,
    '--token',
    c4CcToken,
    '--machine-id',
    c4CcMachineId,
  ],
  {
    env: { ...process.env, HOME: c4Home, PATH: `${ccShimDir}:${process.env.PATH}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let c4CcErr = '';
c4CcDaemon.stderr.on('data', (d) => {
  c4CcErr += d.toString();
});
for (let i = 0; i < 50; i++) {
  r = await req('GET', `/api/machines/${c4CcMachineId}`, { token: userToken });
  if (r.json.machine?.online) break;
  await new Promise((s2) => setTimeout(s2, 200));
}

r = await req('POST', `/api/machines/${c4CcMachineId}/jobs`, {
  token: userToken,
  body: { profileId: ccProfileId },
});
expect('claude-code deploy accepted (#6)', r.status, 201);
// The smoke server sets no PUBLIC_BASE_URL — the arm carries the default.
const ccMp = r.json.job.payload.marketplace.marketplaceName;
const ccBase = r.json.job.payload.marketplace.baseUrl;
expect('marketplace arm baseUrl is the server default', ccBase, 'http://localhost:8080');
expect('marketplace arm name is the owner marketplace', ccMp.startsWith('harness-nexus-'), true);
expect('marketplace arm plugin', r.json.job.payload.marketplace.pluginName, 'c4-cc');
const ccJob1 = r.json.job.id;
let ccJob = null;
for (let i = 0; i < 100; i++) {
  r = await req('GET', `/api/machines/${c4CcMachineId}/jobs`, { token: userToken });
  ccJob = r.json.jobs.find((j) => j.id === ccJob1);
  if (ccJob && (ccJob.status === 'succeeded' || ccJob.status === 'failed')) break;
  await new Promise((s2) => setTimeout(s2, 200));
}
expect('marketplace deploy succeeded', ccJob?.status, 'succeeded');
expect('result method', ccJob?.result?.method, 'marketplace');
expect('result installedVersion', ccJob?.result?.installedVersion, '1.0.0');

const ccArgv = readFileSync(pathMod.join(c4Home, '.claude', 'plugins', 'argv.log'), 'utf8');
expect(
  'marketplace add URL carries the machine PAT',
  ccArgv.includes(`plugin marketplace add ${ccBase}/api/marketplace/${c4CcToken}/marketplace.json`),
  true,
);
expect('headless install flag', ccArgv.includes(`plugin install c4-cc@${ccMp} -y`), true);

// The emitter serves the daemon's machine PAT (machine-ctl scope).
r = await req('GET', `/api/marketplace/${c4CcToken}/marketplace.json`, { token: null });
expect('machine PAT accepted by emitter', r.status, 200);
expect('catalog is the owner marketplace', r.json.name, ccMp);
expect(
  'unknown token 404s',
  (
    await req('GET', '/api/marketplace/hnpat_nope0000000000000000/marketplace.json', {
      token: null,
    })
  ).status,
  404,
);

// [#7] The /mcp outlet also accepts the machine PAT (the hnx mcp serve shim's
// passthrough path for server-dialed entries) — an initialize gets THROUGH
// the gate (not 401); the REST API still rejects the same token. Raw fetch:
// the streamable transport demands the dual Accept header.
{
  const raw = await fetch(`${B}/mcp?profile=${ccProfileId}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${c4CcToken}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'smoke', version: '0' },
      },
    }),
  });
  expect('machine PAT passes the outlet gate (#7)', raw.status, 200);
}
r = await req('GET', '/api/machines', { token: c4CcToken });
expect('REST still rejects the machine PAT', r.status, 401);

// One-click update: same job again — the daemon sees installed 1.0.0 and
// routes to `plugin update`, reporting the shim's 2.0.0.
r = await req('POST', `/api/machines/${c4CcMachineId}/jobs`, {
  token: userToken,
  body: { profileId: ccProfileId },
});
const ccJob2 = r.json.job.id;
for (let i = 0; i < 100; i++) {
  r = await req('GET', `/api/machines/${c4CcMachineId}/jobs`, { token: userToken });
  ccJob = r.json.jobs.find((j) => j.id === ccJob2);
  if (ccJob && (ccJob.status === 'succeeded' || ccJob.status === 'failed')) break;
  await new Promise((s2) => setTimeout(s2, 200));
}
expect('marketplace update job succeeded', ccJob?.status, 'succeeded');
expect('update reports the new version', ccJob?.result?.installedVersion, '2.0.0');
const ccArgv2 = readFileSync(pathMod.join(c4Home, '.claude', 'plugins', 'argv.log'), 'utf8');
expect('second run used plugin update', ccArgv2.includes(`plugin update c4-cc@${ccMp} -y`), true);

// claude-code deploys never register an AgentInstance (chat keys off the
// runtime-detected row — a plugin install is not a runtime install).
r = await req('GET', `/api/machines/${c4CcMachineId}/agents`, { token: userToken });
expect(
  'no agent instance for marketplace deploys',
  r.json.agents.some((a) => a.profileId === ccProfileId),
  false,
);

c4CcDaemon.kill('SIGTERM');
await new Promise((resolve) => {
  c4CcDaemon.once('exit', resolve);
  setTimeout(resolve, 3000);
});
await req('DELETE', `/api/machines/${c4CcMachineId}`, { token: userToken });
rmSync(ccShimDir, { recursive: true, force: true });
rmSync(pathMod.join(c4Home, '.claude'), { recursive: true, force: true });
if (c4CcErr.includes('Error:')) {
  log(
    `(c4-cc daemon stderr note): ${c4CcErr
      .split('\n')
      .filter((l) => l.includes('Error:'))
      .slice(0, 3)
      .join(' | ')}`,
  );
}

c4Daemon.kill('SIGTERM');
await new Promise((resolve) => {
  c4Daemon.once('exit', resolve);
  setTimeout(resolve, 3000);
});
await req('DELETE', `/api/machines/${c4LiveId}`, { token: userToken });
await req('DELETE', `/api/machines/${c4MachineId}`, { token: userToken });
rmSync(c4Home, { recursive: true, force: true });
if (c4Err.includes('Error:')) {
  log(
    `(c4 daemon stderr note): ${c4Err
      .split('\n')
      .filter((l) => l.includes('Error:'))
      .slice(0, 3)
      .join(' | ')}`,
  );
}

// ============================ Phase 8 C5: ACP chat ============================
// REAL daemon dist + the fixture ACP agent (via HN_ACP_COMMAND_HERMES):
// enroll → gating (chat off ⇒ refused) → enable → deploy → browser socket
// round-trip (open → ready → prompt → permission → respond → turn_result)
// → close → audit rows.

log('\n--- [8 C5] chat gating: refused while remote chat is disabled ---');
const c5Home = mkdtempSync(pathMod.join(tmpdir(), 'hnx-smoke-c5-'));
r = await req('POST', '/api/machines', { token: userToken, body: { name: 'c5-box' } });
const c5MachineId = r.json.machine.id;
const c5MachineToken = r.json.token;

const c5Daemon = spawn(
  process.execPath,
  [
    'packages/cli/dist/index.js',
    'daemon',
    '--server',
    B,
    '--token',
    c5MachineToken,
    '--machine-id',
    c5MachineId,
  ],
  {
    env: {
      ...process.env,
      HOME: c5Home,
      HN_ACP_COMMAND_HERMES: `node ${pathMod.resolve('packages/cli/test/fixtures/acp-agent.mjs')}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let c5Err = '';
c5Daemon.stderr.on('data', (d) => {
  c5Err += d.toString();
});

// A browser socket on /app for the whole block.
const c5App = io(`${B}/app`, { auth: { token: userToken }, transports: ['websocket'] });
await new Promise((resolve, reject) => {
  c5App.on('connect', resolve);
  c5App.on('connect_error', reject);
  setTimeout(() => reject(new Error('app socket connect timeout')), 5000);
});
const c5EmitAck = (event, payload) =>
  new Promise((resolve, reject) => {
    c5App.emit(event, payload, resolve);
    setTimeout(() => reject(new Error(`ack timeout: ${event}`)), 10000);
  });
const c5Events = [];
c5App.on('chat:event', (e) => c5Events.push(e));
const c5WaitEvent = async (pred, label, budgetMs = 15000) => {
  const start = Date.now();
  for (;;) {
    const hit = c5Events.find(pred);
    if (hit !== undefined) return hit;
    if (Date.now() - start > budgetMs) throw new Error(`timeout waiting for chat event: ${label}`);
    await new Promise((s2) => setTimeout(s2, 100));
  }
};
const c5Once = (event) =>
  new Promise((resolve, reject) => {
    c5App.once(event, resolve);
    setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), 15000);
  });

// Wait for the daemon to be online + capable (capability check, not a
// version-string match — the daemon version moves every phase).
let c5Online = false;
for (let i = 0; i < 50 && !c5Online; i++) {
  r = await req('GET', `/api/machines/${c5MachineId}`, { token: userToken });
  c5Online = r.json.machine.online && (r.json.machine.capabilities ?? []).includes('chat');
  await new Promise((s2) => setTimeout(s2, 100));
}
expect('c5 daemon online (chat capability)', c5Online, true);

// Deploy the C4 profile to get an AgentInstance (chat's addressable unit).
r = await req('POST', `/api/machines/${c5MachineId}/jobs`, {
  token: userToken,
  body: { profileId: deployProfileId },
});
expect('c5 deploy job created', r.status, 201);
const c5JobId = r.json.job.id;
let c5job = null;
for (let i = 0; i < 150; i++) {
  r = await req('GET', `/api/machines/${c5MachineId}/jobs`, { token: userToken });
  c5job = r.json.jobs.find((j) => j.id === c5JobId);
  if (c5job && (c5job.status === 'succeeded' || c5job.status === 'failed')) break;
  await new Promise((s2) => setTimeout(s2, 200));
}
expect('c5 deploy succeeded', c5job?.status, 'succeeded');
r = await req('GET', `/api/machines/${c5MachineId}/agents`, { token: userToken });
// W1: detected instances may precede the deploy row — chat targets the DEPLOYED
// hermes row here (its ACP adapter is the fixture override).
const c5AgentId = r.json.agents.find((a) => a.profileId !== null)?.id;
expect('c5 agent instance exists', Boolean(c5AgentId), true);

// Chat disabled by default ⇒ refused.
let openAck = await c5EmitAck('chat:session.open', { agentInstanceId: c5AgentId });
expect('chat open refused while disabled', openAck.error, 'REMOTE_CHAT_DISABLED');

log('\n--- [8 C5] full round-trip: open → ready → permission → turn → close ---');
r = await req('PATCH', `/api/machines/${c5MachineId}`, {
  token: userToken,
  body: { remoteChatEnabled: true },
});
expect('remote chat enabled', r.json.machine.remoteChatEnabled, true);

const readyP = c5Once('chat:session.ready');
openAck = await c5EmitAck('chat:session.open', { agentInstanceId: c5AgentId });
expect('chat open acked with sessionId', typeof openAck.sessionId, 'string');
const c5SessionId = openAck.sessionId;
const readyEvt = await readyP;
expect('session ready carries agentInfo', readyEvt.agentName, 'fixture-agent');
expect('ready for the opened session', readyEvt.sessionId, c5SessionId);

// Turn 1: asks permission; we allow.
let sendAck = await c5EmitAck('chat:message.send', {
  sessionId: c5SessionId,
  content: 'fixture, please ask-permission to run the echo tool',
});
expect('message accepted', sendAck.accepted, true);
let permEvt = await c5WaitEvent(
  (e) => e.sessionId === c5SessionId && e.event?.kind === 'permission_request',
  'permission_request',
);
expect(
  'permission options carry verbatim optionIds',
  permEvt.event.options.map((o) => o.optionId).join(','),
  'allow_always,reject_once',
);
let respondAck = await c5EmitAck('chat:permission.respond', {
  sessionId: c5SessionId,
  requestId: permEvt.event.requestId,
  optionId: 'allow_always',
});
expect('permission respond accepted', respondAck.accepted, true);
const grantedEvt = await c5WaitEvent(
  (e) =>
    e.sessionId === c5SessionId &&
    e.event?.kind === 'message_delta' &&
    e.event.delta.includes('permission granted: allow_always'),
  'granted message',
);
expect('agent acknowledged the granted permission', Boolean(grantedEvt), true);
const turn1 = await c5WaitEvent(
  (e) => e.sessionId === c5SessionId && e.event?.kind === 'turn_result',
  'turn_result 1',
);
expect('turn 1 ended cleanly', turn1.event.stopReason, 'end_turn');

// Turn 2: plain echo + usage.
sendAck = await c5EmitAck('chat:message.send', {
  sessionId: c5SessionId,
  content: 'echo me twice',
});
expect('second message accepted', sendAck.accepted, true);
const echoEvt = await c5WaitEvent(
  (e) =>
    e.sessionId === c5SessionId &&
    e.event?.kind === 'message_delta' &&
    e.event.delta === 'echo: echo me twice',
  'echo message',
);
expect('fixture echoed the prompt', Boolean(echoEvt), true);
const usageEvt = await c5WaitEvent(
  (e) => e.sessionId === c5SessionId && e.event?.kind === 'usage',
  'usage_update',
);
expect('usage mapped', usageEvt.event.inputTokens, 11);
const turn2 = await c5WaitEvent(
  (e) => e.sessionId === c5SessionId && e.event?.kind === 'turn_result' && e !== turn1,
  'turn_result 2',
);
expect('turn 2 ended cleanly', turn2.event.stopReason, 'end_turn');

// Busy gate: session_status active arrived during turns and idled after.
const statuses = c5Events
  .filter((e) => e.sessionId === c5SessionId && e.event?.kind === 'session_status')
  .map((e) => e.event.state);
expect(
  'turn activity observed (active + idle)',
  statuses.includes('active') && statuses.includes('idle'),
  true,
);

// Close: the daemon gets chat:session.close, viewers get chat:session.closed.
const closedP = c5Once('chat:session.closed');
const closeAck = await c5EmitAck('chat:session.close', { sessionId: c5SessionId, reason: 'user' });
expect('close acked', closeAck.closed, true);
const closedEvt = await closedP;
expect('closed push reason', closedEvt.reason, 'user');

log('\n--- [8 C5] native sessions surface (redefined 9 W7) + teardown ---');
r = await req('GET', `/api/agent-instances/${c5AgentId}/sessions`, { token: userToken });
expect('native listing answered', r.status, 200);
expect('hermes has no verified native session surface', r.json.supported, false);
expect('…so the list is empty', JSON.stringify(r.json.sessions), '[]');

// Daemon death closes any open channel — open one, kill the daemon.
openAck = await c5EmitAck('chat:session.open', { agentInstanceId: c5AgentId });
const closedP2 = c5Once('chat:session.closed');
c5Daemon.kill('SIGTERM');
const closedEvt2 = await closedP2;
expect(
  'daemon disconnect closes the channel (native sessions survive)',
  closedEvt2.reason,
  'connection-lost',
);

c5App.close();
await req('DELETE', `/api/machines/${c5MachineId}`, { token: userToken });
// Nothing session-shaped persists platform-side (9 W7) — the agent row dies
// with the machine and the listing 404s.
r = await req('GET', `/api/agent-instances/${c5AgentId}/sessions`, { token: userToken });
expect('agent listing 404s after machine deletion', r.status, 404);
rmSync(c5Home, { recursive: true, force: true });
if (c5Err.includes('Error:')) {
  log(
    `(c5 daemon stderr note): ${c5Err
      .split('\n')
      .filter((l) => l.includes('Error:'))
      .slice(0, 3)
      .join(' | ')}`,
  );
}

// ===========================================================================
// [9 W1] Agent-first inventory — runtime probe arm, detected instances,
// capture-as-profile. Fake claude/dsh bins on a fixture PATH (no network);
// codex deliberately absent so the not-installed arm is exercised too.
// ===========================================================================
log('\n--- [9 W1] fixture HOME + fake runtime bins ---');
const w1Home = mkdtempSync(pathMod.join(tmpdir(), 'hnx-smoke-9w1-'));
const w1Bin = pathMod.join(w1Home, 'bin');
mkdirSync(w1Bin, { recursive: true });
const w1BinScript = (name, out) => {
  const file = pathMod.join(w1Bin, name);
  writeFileSync(file, `#!/bin/sh\necho "${out}"\n`, 'utf8');
  chmodSync(file, 0o755);
};
w1BinScript('claude', '9.9.7-fake (Claude Code)');
w1BinScript('dsh', '0.1.2-fake');
// claude + codex artifacts: items nest under the Agent card
mkdirSync(pathMod.join(w1Home, '.claude/skills/cc-w1'), { recursive: true });
writeFileSync(
  pathMod.join(w1Home, '.claude/skills/cc-w1/SKILL.md'),
  '---\nname: cc-w1\ndescription: W1 smoke skill\n---\nBody.\n',
  'utf8',
);
mkdirSync(pathMod.join(w1Home, '.codex/skills/cx-w1'), { recursive: true });
writeFileSync(pathMod.join(w1Home, '.codex/skills/cx-w1/SKILL.md'), 'Codex W1 body.\n', 'utf8');

r = await req('POST', '/api/machines', { token: userToken, body: { name: 'w1-laptop' } });
expect('w1 enroll status', r.status, 201);
const w1MachineId = r.json.machine.id;
const w1Token = r.json.token;

const w1Daemon = spawn(
  process.execPath,
  [
    'packages/cli/dist/index.js',
    'daemon',
    '--server',
    B,
    '--token',
    w1Token,
    '--machine-id',
    w1MachineId,
  ],
  {
    env: { ...process.env, HOME: w1Home, PATH: `${w1Bin}:${process.env.PATH}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let w1Err = '';
w1Daemon.stderr.on('data', (d) => {
  w1Err += d.toString();
});
let w1Online = false;
for (let i = 0; i < 100 && !w1Online; i++) {
  r = await req('GET', `/api/machines/${w1MachineId}`, { token: userToken });
  w1Online = r.json.machine.online;
  if (!w1Online) await new Promise((s2) => setTimeout(s2, 100));
}
expect('w1 daemon online', w1Online, true);
r = await req('GET', `/api/machines/${w1MachineId}`, { token: userToken });
expect(
  'daemon advertises runtime capability',
  r.json.machine.capabilities.includes('runtime'),
  true,
);

log('\n--- [9 W1] scan carries the runtimes arm ---');
r = await req('POST', `/api/machines/${w1MachineId}/inventory/scan`, {
  token: userToken,
  body: {},
});
expect('w1 scan status', r.status, 200);
const w1Rows = r.json.inventory;
expect('w1 scanned 6 targets', w1Rows.length, 6);
const w1Cc = w1Rows.find((i) => i.target === 'claude-code');
expect('cc runtime installed', w1Cc.runtime?.installed, true);
expect('cc runtime version', w1Cc.runtime?.version, '9.9.7-fake (Claude Code)');
expect('cc runtime method', w1Cc.runtime?.installMethod, 'unknown');
const w1Cx = w1Rows.find((i) => i.target === 'codex');
expect('codex runtime not installed', w1Cx.runtime?.installed, false);
expect('codex runtime has no binPath', w1Cx.runtime?.binPath, undefined);
const w1Ds = w1Rows.find((i) => i.target === 'deepseek');
expect('dsh runtime installed', w1Ds.runtime?.installed, true);
const w1Hermes = w1Rows.find((i) => i.target === 'hermes');
expect('hermes runtime arm is null (not runtime-managed)', w1Hermes.runtime, null);

log('\n--- [9 W1] detected AgentInstances auto-register (chat targets) ---');
r = await req('GET', `/api/machines/${w1MachineId}/agents`, { token: userToken });
const w1Detected = r.json.agents.filter((a) => a.source === 'detected');
expect('two detected instances (claude-code + deepseek)', w1Detected.length, 2);
expect(
  'detected targets',
  w1Detected
    .map((a) => a.target)
    .sort()
    .join(','),
  'claude-code,deepseek',
);
expect(
  'detected instance has no profile',
  w1Detected.every((a) => a.profileId === null),
  true,
);

log('\n--- [9 W1] capture-as-profile (no baseline) ---');
r = await req('POST', `/api/machines/${w1MachineId}/inventory/capture`, {
  token: userToken,
  body: { target: 'codex', profileName: 'w1-codex-capture' },
});
expect('capture status', r.status, 200);
expect('captured profile target', r.json.profile?.target, 'codex');
expect('captured one entry', r.json.profile?.entries?.length, 1);
expect('capture created one resource', r.json.created.length, 1);
r = await req('POST', `/api/machines/${w1MachineId}/inventory/capture`, {
  token: userToken,
  body: { target: 'codex', profileName: 'w1-codex-capture-2' },
});
expect('re-capture reuses (idempotent)', r.json.reused.length, 1);
r = await req('POST', `/api/machines/${w1MachineId}/inventory/capture`, {
  token: userToken,
  body: { target: 'hermes', profileName: 'w1-hermes-empty' },
});
expect('default-state capture → zero-entry profile', r.json.profile?.entries?.length, 0);

w1Daemon.kill('SIGTERM');
await req('DELETE', `/api/machines/${w1MachineId}`, { token: userToken });
rmSync(w1Home, { recursive: true, force: true });
if (w1Err.includes('Error:')) {
  log(
    `(w1 daemon stderr note): ${w1Err
      .split('\n')
      .filter((l) => l.includes('Error:'))
      .slice(0, 3)
      .join(' | ')}`,
  );
}

// ===========================================================================
// [9 W2] Harness install/upgrade/pin jobs — a FAKE npm shim on the daemon's
// PATH records installs by writing a bin that prints the "installed" version
// (no network). Full loop: pin job → succeeded → runtime row updates via the
// daemon's post-install auto-report → detected instance appears → upgrade.
// ===========================================================================
log('\n--- [9 W2] fixture HOME + fake npm shim ---');
const w2Home = mkdtempSync(pathMod.join(tmpdir(), 'hnx-smoke-9w2-'));
const w2Shim = pathMod.join(w2Home, 'shim');
const w2Bin = pathMod.join(w2Home, 'bin');
mkdirSync(w2Shim, { recursive: true });
mkdirSync(w2Bin, { recursive: true });
const w2Chmod = (f) => chmodSync(f, 0o755);
const w2Npm = pathMod.join(w2Shim, 'npm');
writeFileSync(
  w2Npm,
  [
    '#!/bin/sh',
    'spec=$3',
    'ver=${spec##*@}',
    'name=${spec%@*}',
    'case "$name" in',
    '  *claude-code) bin=claude ;;',
    '  *codex) bin=codex ;;',
    '  *dsh) bin=dsh ;;',
    '  *) exit 1 ;;',
    'esac',
    'if [ "$ver" = "latest" ]; then ver=2.0.0-w2fake; fi',
    `out='${w2Bin}/'$bin`,
    '{ echo \'#!/bin/sh\'; echo "echo $ver"; } > "$out"',
    'chmod +x "$out"',
    'echo "added 1 package in 0.1s"',
  ].join('\n') + '\n',
  'utf8',
);
w2Chmod(w2Npm);

r = await req('POST', '/api/machines', { token: userToken, body: { name: 'w2-laptop' } });
expect('w2 enroll status', r.status, 201);
const w2MachineId = r.json.machine.id;
const w2Token = r.json.token;

const w2Daemon = spawn(
  process.execPath,
  [
    'packages/cli/dist/index.js',
    'daemon',
    '--server',
    B,
    '--token',
    w2Token,
    '--machine-id',
    w2MachineId,
  ],
  {
    env: {
      ...process.env,
      HOME: w2Home,
      PATH: `${w2Shim}:${w2Bin}:${process.env.PATH ?? ''}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let w2Err = '';
w2Daemon.stderr.on('data', (d) => {
  w2Err += d.toString();
});
let w2Online = false;
for (let i = 0; i < 100 && !w2Online; i++) {
  r = await req('GET', `/api/machines/${w2MachineId}`, { token: userToken });
  w2Online = r.json.machine.online && (r.json.machine.capabilities ?? []).includes('harness');
  if (!w2Online) await new Promise((s2) => setTimeout(s2, 100));
}
expect('w2 daemon online (harness capability)', w2Online, true);

log('\n--- [9 W2] pin dsh@1.2.3-w2fake → job succeeds, runtime row + detected instance ---');
// Let the daemon's connect-time full report land FIRST (it carries the
// pre-install probe: dsh absent). Starting the pin job before it would let
// that in-flight report overwrite the job's post-install auto-report.
let w2Initial = null;
for (let i = 0; i < 100 && w2Initial?.runtime?.installed !== false; i++) {
  r = await req('GET', `/api/machines/${w2MachineId}/inventory`, { token: userToken });
  w2Initial = r.json.inventory.find((x) => x.target === 'deepseek');
  if (w2Initial?.runtime?.installed !== false) await new Promise((s2) => setTimeout(s2, 100));
}
expect('initial deepseek runtime row (not installed)', w2Initial?.runtime?.installed, false);

r = await req('POST', `/api/machines/${w2MachineId}/jobs`, {
  token: userToken,
  body: { type: 'harness', action: 'pin', target: 'deepseek', version: '1.2.3-w2fake' },
});
expect('harness pin job created', r.status, 201);
expect('harness job type', r.json.job.type, 'harness');
const w2Job1 = r.json.job.id;
let w2job = null;
for (let i = 0; i < 150; i++) {
  r = await req('GET', `/api/machines/${w2MachineId}/jobs`, { token: userToken });
  w2job = r.json.jobs.find((j) => j.id === w2Job1);
  if (w2job && (w2job.status === 'succeeded' || w2job.status === 'failed')) break;
  await new Promise((s2) => setTimeout(s2, 200));
}
expect('pin job succeeded', w2job?.status, 'succeeded');
expect('pin job result carries the probed version', w2job?.result?.version, '1.2.3-w2fake');
expect('pin job result method', w2job?.result?.installMethod, 'unknown');

// The daemon's post-install auto-report lands asynchronously — poll for it.
let w2Row = null;
for (let i = 0; i < 50 && w2Row?.runtime?.version !== '1.2.3-w2fake'; i++) {
  r = await req('GET', `/api/machines/${w2MachineId}/inventory`, { token: userToken });
  w2Row = r.json.inventory.find((x) => x.target === 'deepseek');
  if (w2Row?.runtime?.version !== '1.2.3-w2fake') await new Promise((s2) => setTimeout(s2, 100));
}
expect('runtime row updated by the auto-report', w2Row?.runtime?.version, '1.2.3-w2fake');
r = await req('GET', `/api/machines/${w2MachineId}/agents`, { token: userToken });
expect(
  'detected deepseek instance appeared after install',
  r.json.agents.some((a) => a.source === 'detected' && a.target === 'deepseek'),
  true,
);

log('\n--- [9 W2] upgrade → npm @latest through the shim ---');
r = await req('POST', `/api/machines/${w2MachineId}/jobs`, {
  token: userToken,
  body: { type: 'harness', action: 'upgrade', target: 'deepseek' },
});
expect('upgrade job created', r.status, 201);
const w2Job2 = r.json.job.id;
for (let i = 0; i < 150; i++) {
  r = await req('GET', `/api/machines/${w2MachineId}/jobs`, { token: userToken });
  w2job = r.json.jobs.find((j) => j.id === w2Job2);
  if (w2job && (w2job.status === 'succeeded' || w2job.status === 'failed')) break;
  await new Promise((s2) => setTimeout(s2, 200));
}
expect('upgrade job succeeded', w2job?.status, 'succeeded');
for (let i = 0; i < 50 && w2Row?.runtime?.version !== '2.0.0-w2fake'; i++) {
  r = await req('GET', `/api/machines/${w2MachineId}/inventory`, { token: userToken });
  w2Row = r.json.inventory.find((x) => x.target === 'deepseek');
  if (w2Row?.runtime?.version !== '2.0.0-w2fake') await new Promise((s2) => setTimeout(s2, 100));
}
expect('runtime row shows the upgraded version', w2Row?.runtime?.version, '2.0.0-w2fake');

log('\n--- [9 W2] gates: pin without version 400, admin mutation 403 ---');
r = await req('POST', `/api/machines/${w2MachineId}/jobs`, {
  token: userToken,
  body: { type: 'harness', action: 'pin', target: 'deepseek' },
});
expect('pin without version rejected', r.status, 400);
r = await req('POST', `/api/machines/${w2MachineId}/jobs`, {
  token: adminToken,
  body: { type: 'harness', action: 'install', target: 'deepseek' },
});
expect('admin harness mutation refused (owner-only)', r.status, 403);

w2Daemon.kill('SIGTERM');
await req('DELETE', `/api/machines/${w2MachineId}`, { token: userToken });
rmSync(w2Home, { recursive: true, force: true });
if (w2Err.includes('Error:')) {
  log(
    `(w2 daemon stderr note): ${w2Err
      .split('\n')
      .filter((l) => l.includes('Error:'))
      .slice(0, 3)
      .join(' | ')}`,
  );
}

// ===========================================================================
// [9 W3] Provider config push — a REAL daemon dist applies an `apply-config`
// job end-to-end against a fixture HOME (fetches the resolved bundle over
// REST with its machine PAT, writes the native slots). User config planted
// beforehand proves merge preservation; the gates mirror the route tests.
// ===========================================================================
log('\n--- [9 W3] fixture HOME with planted user config + credential ---');
const w3Home = mkdtempSync(pathMod.join(tmpdir(), 'hnx-smoke-9w3-'));
mkdirSync(pathMod.join(w3Home, '.codex'), { recursive: true });
writeFileSync(
  pathMod.join(w3Home, '.codex', 'config.toml'),
  ['# my config', '[mcp_servers.user-thing]', 'command = "keep-me"', ''].join('\n'),
  'utf8',
);
mkdirSync(pathMod.join(w3Home, '.dsh'), { recursive: true });
writeFileSync(pathMod.join(w3Home, '.dsh', '.env'), 'DEEPSEEK_API_KEY=user-key\n', 'utf8');

r = await req('POST', '/api/credentials', {
  token: userToken,
  body: { name: 'w3-gw-key', secret: 'sk-w3-secret', scope: 'personal' },
});
expect('w3 credential created', r.status, 201);

r = await req('POST', '/api/machines', { token: userToken, body: { name: 'w3-laptop' } });
expect('w3 enroll status', r.status, 201);
const w3MachineId = r.json.machine.id;
const w3Token = r.json.token;

const w3Daemon = spawn(
  process.execPath,
  [
    'packages/cli/dist/index.js',
    'daemon',
    '--server',
    B,
    '--token',
    w3Token,
    '--machine-id',
    w3MachineId,
  ],
  { env: { ...process.env, HOME: w3Home }, stdio: ['ignore', 'pipe', 'pipe'] },
);
let w3Err = '';
w3Daemon.stderr.on('data', (d) => {
  w3Err += d.toString();
});
let w3Online = false;
for (let i = 0; i < 100 && !w3Online; i++) {
  r = await req('GET', `/api/machines/${w3MachineId}`, { token: userToken });
  w3Online =
    r.json.machine.online && (r.json.machine.capabilities ?? []).includes('runtime-config');
  if (!w3Online) await new Promise((s2) => setTimeout(s2, 100));
}
expect('w3 daemon online (runtime-config capability)', w3Online, true);

log('\n--- [9 W3] PUT codex config → apply-config job writes config.toml + auth.json ---');
const w3CodexSpec = {
  providerLabel: 'w3 gateway',
  baseUrl: `${B.replace('127.0.0.1', '127.0.0.1')}/v1`,
  api: 'openai',
  model: 'w3-model',
  credentialName: 'w3-gw-key',
};
r = await req('PUT', `/api/machines/${w3MachineId}/runtime-config/codex`, {
  token: userToken,
  body: w3CodexSpec,
});
expect('w3 codex config upserted (201 first time)', r.status, 201);
expect('w3 spec echoes credentialName, not the secret', r.json.config.credentialName, 'w3-gw-key');
expect('w3 response carries no secret', JSON.stringify(r.json).includes('sk-w3-secret'), false);
expect('w3 job queued is apply-config', r.json.job.payload.action, 'apply-config');
const w3Job1 = r.json.job.id;
let w3job = null;
for (let i = 0; i < 150; i++) {
  r = await req('GET', `/api/machines/${w3MachineId}/jobs`, { token: userToken });
  w3job = r.json.jobs.find((j) => j.id === w3Job1);
  if (w3job && (w3job.status === 'succeeded' || w3job.status === 'failed')) break;
  await new Promise((s2) => setTimeout(s2, 200));
}
expect('w3 codex apply job succeeded', w3job?.status, 'succeeded');
expect(
  'w3 job result lists the written files',
  (w3job?.result?.files ?? []).join(','),
  '~/.codex/config.toml,~/.codex/auth.json',
);

const w3Toml = readFileSync(pathMod.join(w3Home, '.codex', 'config.toml'), 'utf8');
expect('codex: user comment survives', w3Toml.includes('# my config'), true);
expect('codex: user MCP section survives', w3Toml.includes('[mcp_servers.user-thing]'), true);
expect('codex: root model set', w3Toml.includes('model = "w3-model"'), true);
expect(
  'codex: model_provider selects our route',
  w3Toml.includes('model_provider = "harness_nexus"'),
  true,
);
expect(
  'codex: provider section with auth.json auth',
  w3Toml.includes('requires_openai_auth = true'),
  true,
);
expect('codex: wire_api absent (Responses-only)', w3Toml.includes('wire_api'), false);
const w3Auth = JSON.parse(readFileSync(pathMod.join(w3Home, '.codex', 'auth.json'), 'utf8'));
expect('codex: auth.json apikey mode with our key', w3Auth.OPENAI_API_KEY, 'sk-w3-secret');
expect(
  'codex: auth.json 0600',
  statSync(pathMod.join(w3Home, '.codex', 'auth.json')).mode & 0o777,
  0o600,
);

log('\n--- [9 W3] PUT deepseek config → patch region + default-model + ~/.dsh/.env ---');
r = await req('PUT', `/api/machines/${w3MachineId}/runtime-config/deepseek`, {
  token: userToken,
  body: { ...w3CodexSpec, api: 'anthropic-messages' },
});
expect('w3 deepseek config upserted', r.status, 201);
const w3Job2 = r.json.job.id;
for (let i = 0; i < 150; i++) {
  r = await req('GET', `/api/machines/${w3MachineId}/jobs`, { token: userToken });
  w3job = r.json.jobs.find((j) => j.id === w3Job2);
  if (w3job && (w3job.status === 'succeeded' || w3job.status === 'failed')) break;
  await new Promise((s2) => setTimeout(s2, 200));
}
expect('w3 deepseek apply job succeeded', w3job?.status, 'succeeded');
const w3Settings = readFileSync(pathMod.join(w3Home, '.dsh', 'settings.yaml'), 'utf8');
expect(
  'dsh: settings managed region',
  w3Settings.includes('# BEGIN harness-nexus (managed)'),
  true,
);
expect('dsh: llm namespace carries the route', w3Settings.includes('llm-pi-ai:'), true);
expect('dsh: anthropic api flavor', w3Settings.includes('api: anthropic-messages'), true);
expect(
  'dsh: key channel is the env var name',
  w3Settings.includes('apiKeyEnv: HARNESS_NEXUS_API_KEY'),
  true,
);
expect(
  'dsh: default-model namespace selects the route',
  w3Settings.includes('agent-default-model:'),
  true,
);
const w3Patch = readFileSync(pathMod.join(w3Home, '.dsh', 'cordis.patch.yml'), 'utf8');
expect('dsh: acp entry overridden onto our route', w3Patch.includes('- id: acp'), true);
expect('dsh: override selects harness-nexus', w3Patch.includes('provider: harness-nexus'), true);
const w3Env = readFileSync(pathMod.join(w3Home, '.dsh', '.env'), 'utf8');
expect('dsh: user env var survives', w3Env.includes('DEEPSEEK_API_KEY=user-key'), true);
expect('dsh: managed key written', w3Env.includes('HARNESS_NEXUS_API_KEY=sk-w3-secret'), true);

log('\n--- [9 W3] gates: GET echo, machine-PAT bundle, admin 403, flavor 409 ---');
r = await req('GET', `/api/machines/${w3MachineId}/runtime-config/codex`, { token: userToken });
expect('GET echoes the stored spec', r.json.config.model, 'w3-model');
r = await req('GET', `/api/machines/${w3MachineId}/runtime-config/codex`, { token: adminToken });
expect('admin may view the spec', r.status, 200);
r = await req('PUT', `/api/machines/${w3MachineId}/runtime-config/codex`, {
  token: adminToken,
  body: w3CodexSpec,
});
expect('admin mutation refused (owner-only)', r.status, 403);
r = await req('PUT', `/api/machines/${w3MachineId}/runtime-config/claude-code`, {
  token: userToken,
  body: { ...w3CodexSpec, api: 'openai' },
});
expect('claude-code cannot speak openai (409)', r.status, 409);
r = await req('POST', `/api/machines/${w3MachineId}/jobs`, {
  token: userToken,
  body: { type: 'harness', action: 'apply-config', target: 'codex' },
});
expect('bare apply-config job body refused (409)', r.status, 409);
// The ONLY surface carrying the plaintext: the daemon's machine-PAT bundle.
r = await req('GET', `/api/client/runtime-config?target=codex`, { token: w3Token });
expect('machine PAT bundle resolves the secret', r.json.secret, 'sk-w3-secret');
r = await req('GET', `/api/client/runtime-config?target=codex`, { token: userToken });
expect('user tokens get a flat 404 on the bundle surface', r.status, 404);

// ===========================================================================
// [9 W4] Redacted config view — the SAME live daemon (real dist) answers
// `runtime:config.get`; the files it wrote in W3 come back MASKED. The
// load-bearing assertion: the planted secret never appears in the view.
// ===========================================================================
log('\n--- [9 W4] redacted view: codex files masked, plaintext absent ---');
r = await req('GET', `/api/machines/${w3MachineId}/runtimes/codex/config`, { token: userToken });
expect('w4 codex view status', r.status, 200);
expect('w4 view target', r.json.target, 'codex');
const w4Paths = (r.json.files ?? []).map((f) => f.path).join(',');
expect('w4 codex view lists both files', w4Paths, '~/.codex/config.toml,~/.codex/auth.json');
expect(
  'w4 view carries NO plaintext secret',
  JSON.stringify(r.json).includes('sk-w3-secret'),
  false,
);
const w4AuthFile = r.json.files.find((f) => f.path === '~/.codex/auth.json');
expect('w4 auth.json key masked', JSON.parse(w4AuthFile.content).OPENAI_API_KEY, '${redacted}');
expect(
  'w4 redacted list names the key',
  r.json.redacted.some((x) => x.includes('OPENAI_API_KEY')),
  true,
);
const w4TomlView = r.json.files.find((f) => f.path === '~/.codex/config.toml');
expect(
  'w4 toml keeps the provider block readable',
  w4TomlView.content.includes('requires_openai_auth = true'),
  true,
);

log('\n--- [9 W4] redacted view: deepseek patch rows + fully masked .env ---');
r = await req('GET', `/api/machines/${w3MachineId}/runtimes/deepseek/config`, { token: userToken });
expect('w4 deepseek view status', r.status, 200);
expect(
  'w4 deepseek view carries NO plaintext secret',
  JSON.stringify(r.json).includes('sk-w3-secret'),
  false,
);
const w4Env = r.json.files.find((f) => f.path === '~/.dsh/.env');
expect(
  'w4 .env fully masked (both the planted user key and ours)',
  w4Env.content,
  'DEEPSEEK_API_KEY=${redacted}\nHARNESS_NEXUS_API_KEY=${redacted}\n',
);
const w4Settings = r.json.files.find((f) => f.path === '~/.dsh/settings.yaml');
expect('w4 settings rows readable', w4Settings.content.includes('llm-pi-ai:'), true);
expect(
  'w4 settings key channel masked',
  w4Settings.content.includes('apiKeyEnv: ${redacted}'),
  true,
);

log('\n--- [9 W4] gates: admin view ok, bad target 400 ---');
r = await req('GET', `/api/machines/${w3MachineId}/runtimes/codex/config`, { token: adminToken });
expect('admin may view the redacted config', r.status, 200);
r = await req('GET', `/api/machines/${w3MachineId}/runtimes/hermes/config`, { token: userToken });
expect('non-runtime target rejected (400)', r.status, 400);

w3Daemon.kill('SIGTERM');
await req('DELETE', `/api/machines/${w3MachineId}`, { token: userToken });
rmSync(w3Home, { recursive: true, force: true });
if (w3Err.includes('Error:')) {
  log(
    `(w3 daemon stderr note): ${w3Err
      .split('\n')
      .filter((l) => l.includes('Error:'))
      .slice(0, 3)
      .join(' | ')}`,
  );
}

// ===========================================================================
// [9 W10] LLM provider management — CRUD + scope rules, and the provider-
// first runtime-config PUT (providerId provenance + extras-only models).
// The query-models fetch itself is covered by the stubbed server tests —
// the smoke only pins its failure mapping against a dead endpoint.
// ===========================================================================
log('\n--- [9 W10] provider CRUD + name-taken gate ---');
r = await req('POST', '/api/llm-providers', {
  token: userToken,
  body: {
    name: 'w10-gw',
    api: 'openai-responses',
    baseUrl: 'https://gw.example.com/v1',
    credentialName: 'w3-gw-key',
  },
});
expect('w10 provider created (scope defaults to personal)', r.status, 201);
const w10ProviderId = r.json.provider.id;

r = await req('POST', '/api/llm-providers', {
  token: userToken,
  body: { name: 'w10-gw', api: 'anthropic', credentialName: 'w3-gw-key' },
});
expect('duplicate name in scope rejected', r.status, 409);

r = await req('GET', '/api/llm-providers', { token: userToken });
expect(
  'provider listed for its owner',
  r.json.providers.some((p) => p.id === w10ProviderId),
  true,
);
r = await req('GET', '/api/llm-providers', { token: adminToken });
expect(
  'foreign personal provider hidden from others',
  r.json.providers.some((p) => p.id === w10ProviderId),
  false,
);

log('\n--- [9 W10] provider-mode runtime-config PUT (providerId + models) ---');
const w10Machine = await req('POST', '/api/machines', {
  token: userToken,
  body: { name: 'w10-box' },
});
expect('w10 enroll status', w10Machine.status, 201);
r = await req('PUT', `/api/machines/${w10Machine.json.machine.id}/runtime-config/codex`, {
  token: userToken,
  body: {
    providerLabel: 'w10-gw',
    api: 'openai',
    model: 'gpt-5',
    credentialName: 'w3-gw-key',
    providerId: w10ProviderId,
    models: ['gpt-5', 'gpt-5-mini'],
  },
});
expect('provider-mode spec accepted (queues while offline)', r.status, 201);
expect('providerId echoed', r.json.config.providerId, w10ProviderId);
expect(
  'models stored as extras only (default dropped)',
  r.json.config.models.join(','),
  'gpt-5-mini',
);

r = await req('POST', '/api/llm-providers/query-models', {
  token: userToken,
  body: { providerId: w10ProviderId },
});
expect('dead endpoint maps to 502 PROVIDER_MODELS_FAILED', r.status, 502);
expect('error code', r.json.error, 'PROVIDER_MODELS_FAILED');

r = await req('DELETE', `/api/machines/${w10Machine.json.machine.id}`, { token: userToken });
expect('w10 machine cleanup', r.status, 200);
r = await req('DELETE', `/api/llm-providers/${w10ProviderId}`, { token: userToken });
expect('provider deleted (applied specs keep their snapshots)', r.json.ok, true);

// ===========================================================================
// [9 W6] Portal chat — the workspace listing round-trip through a REAL daemon
// dist (one level of subdirectories under the machine's base workspace), the
// chat open-with-directory + cwd validation matrix over the fake browser
// socket, and the derived session title.
// ===========================================================================
log('\n--- [9 W6] fixture workspace tree + daemon with workspace capability ---');
const w6Home = mkdtempSync(pathMod.join(tmpdir(), 'hnx-smoke-9w6-'));
const w6Root = pathMod.join(w6Home, 'projects');
mkdirSync(pathMod.join(w6Root, 'alpha'), { recursive: true });
mkdirSync(pathMod.join(w6Root, 'beta'), { recursive: true });
mkdirSync(pathMod.join(w6Root, '.hidden'), { recursive: true });
writeFileSync(pathMod.join(w6Root, 'plain.txt'), 'not a dir', 'utf8');

r = await req('POST', '/api/machines', { token: userToken, body: { name: 'w6-laptop' } });
expect('w6 enroll status', r.status, 201);
const w6MachineId = r.json.machine.id;
const w6Token = r.json.token;

const w6Daemon = spawn(
  process.execPath,
  [
    'packages/cli/dist/index.js',
    'daemon',
    '--server',
    B,
    '--token',
    w6Token,
    '--machine-id',
    w6MachineId,
  ],
  { env: { ...process.env, HOME: w6Home }, stdio: ['ignore', 'pipe', 'pipe'] },
);
let w6Err = '';
w6Daemon.stderr.on('data', (d) => {
  w6Err += d.toString();
});
let w6Online = false;
for (let i = 0; i < 100 && !w6Online; i++) {
  r = await req('GET', `/api/machines/${w6MachineId}`, { token: userToken });
  w6Online = r.json.machine.online && (r.json.machine.capabilities ?? []).includes('workspace');
  if (!w6Online) await new Promise((s2) => setTimeout(s2, 100));
}
expect('w6 daemon online (workspace capability)', w6Online, true);

log('\n--- [9 W6] workspace listing: root unset, containment, round-trip ---');
r = await req('GET', `/api/machines/${w6MachineId}/workspace`, { token: userToken });
expect('no base workspace yet → 400', r.status, 400);
expect('…with WORKSPACE_ROOT_NOT_SET', r.json.error, 'WORKSPACE_ROOT_NOT_SET');

r = await req('PATCH', `/api/machines/${w6MachineId}`, {
  token: userToken,
  body: { baseWorkspace: w6Root },
});
expect('base workspace saved', r.json.machine.baseWorkspace, w6Root);

r = await req(
  'GET',
  `/api/machines/${w6MachineId}/workspace?path=${encodeURIComponent(pathMod.join(w6Home, 'elsewhere'))}`,
  { token: userToken },
);
expect('outside root → 400 WORKSPACE_OUTSIDE_ROOT', r.json.error, 'WORKSPACE_OUTSIDE_ROOT');

r = await req('GET', `/api/machines/${w6MachineId}/workspace`, { token: userToken });
expect('root listing status', r.status, 200);
expect(
  'root lists exactly the two visible dirs (hidden + file skipped)',
  JSON.stringify(r.json.directories.map((d) => d.name)),
  JSON.stringify(['alpha', 'beta']),
);
r = await req(
  'GET',
  `/api/machines/${w6MachineId}/workspace?path=${encodeURIComponent(`${w6Root}/alpha`)}`,
  { token: userToken },
);
expect('subdirectory listing is empty', JSON.stringify(r.json.directories), '[]');

log('\n--- [9 W6] workspace gates: ownership + offline ---');
r = await req('GET', `/api/machines/${w6MachineId}/workspace`, { token: adminToken });
expect('admin may also browse (owner-or-admin read)', r.status, 200);
await req('POST', '/api/users', {
  token: adminToken,
  body: { username: 'w6stranger', password: 'stranger-pass-123', role: 'user' },
});
const w6Login = await req('POST', '/api/auth/login', {
  body: { username: 'w6stranger', password: 'stranger-pass-123' },
});
r = await req('GET', `/api/machines/${w6MachineId}/workspace`, {
  token: w6Login.json.token,
});
expect('stranger gets the 404 (existence hiding)', r.status, 404);

w6Daemon.kill('SIGTERM');
for (let i = 0; i < 100; i++) {
  r = await req('GET', `/api/machines/${w6MachineId}`, { token: userToken });
  if (r.json.machine.online === false) break;
  await new Promise((s2) => setTimeout(s2, 100));
}
r = await req('GET', `/api/machines/${w6MachineId}/workspace`, { token: userToken });
expect('offline daemon → 409 MACHINE_OFFLINE', r.json.error, 'MACHINE_OFFLINE');

await req('DELETE', `/api/machines/${w6MachineId}`, { token: userToken });
rmSync(w6Home, { recursive: true, force: true });
if (w6Err.includes('Error:')) {
  log(
    `(w6 daemon stderr note): ${w6Err
      .split('\n')
      .filter((l) => l.includes('Error:'))
      .slice(0, 3)
      .join(' | ')}`,
  );
}

// ===========================================================================
// [9 W7] Native agent sessions — the platform persists NOTHING
// session-shaped: list + resume ride the agent's OWN surface. Real daemon
// dist + the fixture ACP adapter as a claude-code stand-in (session/list +
// session/load-with-replay), plus a crafted dsh transcript store (multi-frame
// zstd) exercised through the file-scan listing when Node has the zstd
// binding (>= 22.15).
// ===========================================================================
log('\n--- [9 W7] fixture HOME: fake runtime bins + crafted dsh transcript ---');
const w7Home = mkdtempSync(pathMod.join(tmpdir(), 'hnx-smoke-9w7-'));
const w7Bin = pathMod.join(w7Home, 'bin');
mkdirSync(w7Bin, { recursive: true });
const w7BinScript = (name, out) => {
  const file = pathMod.join(w7Bin, name);
  writeFileSync(file, `#!/bin/sh\necho "${out}"\n`, 'utf8');
  chmodSync(file, 0o755);
};
w7BinScript('claude', '9.9.7-fake (Claude Code)');
w7BinScript('dsh', '0.1.2-rc.1');

// A dsh-shaped transcript: header + title + one full turn, multi-frame zstd.
const w7Proj = pathMod.join(w7Home, 'proj');
mkdirSync(w7Proj, { recursive: true });
const w7DshId = '828c9ddc-2fa8-44b4-9cff-00c4c886a77f';
const w7Zstd = await import('node:zlib');
const w7HasZstd =
  typeof w7Zstd.zstdCompressSync === 'function' && typeof w7Zstd.zstdDecompressSync === 'function';
if (w7HasZstd) {
  const dshDir = pathMod.join(w7Home, '.dsh', 'sessions', '--w7-proj--', w7DshId);
  mkdirSync(dshDir, { recursive: true });
  const dshEntries = [
    {
      type: 'session',
      version: 0,
      id: w7DshId,
      createdAt: Date.now(),
      cwd: w7Proj,
      delegationDepth: 0,
    },
    { type: 'session/title', data: { title: 'smoke dsh turn' } },
    {
      type: 'agent/inbox/spliced',
      data: {
        target: 'next-turn',
        inserted: [
          {
            content: [{ type: 'text', text: 'hi dsh' }],
            source: { kind: 'user' },
            role: 'user',
            id: 'u-w7',
          },
        ],
      },
    },
    {
      type: 'assistant/message',
      data: {
        message: { role: 'assistant', content: [{ type: 'text', text: 'hello from the store' }] },
      },
    },
    { type: 'turn/end', data: { reason: { kind: 'completed' } } },
  ];
  writeFileSync(
    pathMod.join(dshDir, 'session.jsonl.zstd'),
    Buffer.concat(
      dshEntries.map((e) => w7Zstd.zstdCompressSync(Buffer.from(`${JSON.stringify(e)}\n`))),
    ),
  );
} else {
  log('(w7 note: Node lacks zstd — the dsh file-scan listing is skipped)');
}

r = await req('POST', '/api/machines', { token: userToken, body: { name: 'w7-laptop' } });
expect('w7 enroll status', r.status, 201);
const w7MachineId = r.json.machine.id;
const w7Token = r.json.token;

const w7Daemon = spawn(
  process.execPath,
  [
    'packages/cli/dist/index.js',
    'daemon',
    '--server',
    B,
    '--token',
    w7Token,
    '--machine-id',
    w7MachineId,
  ],
  {
    env: {
      ...process.env,
      HOME: w7Home,
      PATH: `${w7Bin}:${process.env.PATH ?? ''}`,
      HN_ACP_COMMAND_CLAUDE_CODE: `node ${pathMod.resolve('packages/cli/test/fixtures/acp-agent.mjs')}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let w7Err = '';
w7Daemon.stderr.on('data', (d) => {
  w7Err += d.toString();
});
let w7Online = false;
for (let i = 0; i < 100 && !w7Online; i++) {
  r = await req('GET', `/api/machines/${w7MachineId}`, { token: userToken });
  w7Online = r.json.machine.online && (r.json.machine.capabilities ?? []).includes('sessions');
  if (!w7Online) await new Promise((s2) => setTimeout(s2, 100));
}
expect('w7 daemon online (sessions capability)', w7Online, true);

// The auto-report's runtime probe registers DETECTED instances for the fake
// bins (claude-code + deepseek) — the chat/list addressable units.
let w7Agents = [];
for (let i = 0; i < 100; i++) {
  r = await req('GET', `/api/machines/${w7MachineId}/agents`, { token: userToken });
  w7Agents = r.json.agents ?? [];
  if (
    w7Agents.some((a) => a.target === 'claude-code') &&
    w7Agents.some((a) => a.target === 'deepseek')
  ) {
    break;
  }
  await new Promise((s2) => setTimeout(s2, 100));
}
const w7CcAgent = w7Agents.find((a) => a.target === 'claude-code');
const w7DshAgent = w7Agents.find((a) => a.target === 'deepseek');
expect('detected claude-code instance', Boolean(w7CcAgent), true);
expect('detected deepseek instance', Boolean(w7DshAgent), true);

log('\n--- [9 W7] native listing: adapter-routed (claude-code) + file-scan (dsh) ---');
r = await req('PATCH', `/api/machines/${w7MachineId}`, {
  token: userToken,
  body: { remoteChatEnabled: true },
});
expect('remote chat enabled', r.json.machine.remoteChatEnabled, true);

r = await req('GET', `/api/agent-instances/${w7CcAgent.id}/sessions`, { token: userToken });
expect('claude-code listing status', r.status, 200);
expect('claude-code listing supported', r.json.supported, true);
expect(
  'the fixture adapter IS the vendor session list',
  JSON.stringify(r.json.sessions.map((s) => s.sessionId)),
  JSON.stringify(['fx-native-1']),
);
expect('session carries cwd + title', r.json.sessions[0].cwd, '/tmp');

if (w7HasZstd) {
  r = await req('GET', `/api/agent-instances/${w7DshAgent.id}/sessions`, { token: userToken });
  expect('dsh file-scan listing status', r.status, 200);
  expect('crafted session listed', r.json.sessions[0].sessionId, w7DshId);
  expect('cwd decoded from the transcript header', r.json.sessions[0].cwd, w7Proj);
  expect('title from the session/title entry', r.json.sessions[0].title, 'smoke dsh turn');
}

log('\n--- [9 W7] resume: open with the native session → replayed history → live turn ---');
const w7App = io(`${B}/app`, { auth: { token: userToken }, transports: ['websocket'] });
await new Promise((resolve, reject) => {
  w7App.on('connect', resolve);
  w7App.on('connect_error', reject);
  setTimeout(() => reject(new Error('app socket connect timeout')), 5000);
});
const w7EmitAck = (event, payload) =>
  new Promise((resolve, reject) => {
    w7App.emit(event, payload, resolve);
    setTimeout(() => reject(new Error(`ack timeout: ${event}`)), 10000);
  });
const w7HistoryP = new Promise((resolve, reject) => {
  w7App.once('chat:history', resolve);
  setTimeout(() => reject(new Error('timeout waiting for chat:history')), 15000);
});
const w7ReadyP = new Promise((resolve, reject) => {
  w7App.once('chat:session.ready', resolve);
  setTimeout(() => reject(new Error('timeout waiting for chat:session.ready')), 15000);
});
openAck = await w7EmitAck('chat:session.open', {
  agentInstanceId: w7CcAgent.id,
  resume: { sessionId: 'fx-native-1', cwd: '/tmp' },
});
expect('resume open acked', typeof openAck.sessionId, 'string');
const w7Ready = await w7ReadyP;
expect('ready carries the native session id', w7Ready.nativeSessionId, 'fx-native-1');
const w7History = await w7HistoryP;
const w7Kinds = w7History.items.map((i) => (i.type === 'user' ? 'user' : i.event.kind));
expect(
  'history = replayed user + message + tool + synthetic turn tail',
  JSON.stringify(w7Kinds),
  JSON.stringify(['user', 'message_delta', 'tool_call', 'turn_result']),
);

// The resumed channel keeps working: a live turn on the same native session.
const w7Events = [];
w7App.on('chat:event', (e) => w7Events.push(e));
sendAck = await w7EmitAck('chat:message.send', {
  sessionId: openAck.sessionId,
  content: 'continue after resume',
});
expect('live turn on the resumed channel accepted', sendAck.accepted, true);
for (let i = 0; i < 100; i++) {
  if (w7Events.some((e) => e.event?.kind === 'turn_result')) break;
  await new Promise((s2) => setTimeout(s2, 100));
}
expect(
  'resumed channel echoes the new turn',
  w7Events.some(
    (e) => e.event?.kind === 'message_delta' && e.event.delta === 'echo: continue after resume',
  ),
  true,
);

// Disconnect is channel-only — the listing keeps offering the session.
const w7ClosedP = new Promise((resolve, reject) => {
  w7App.once('chat:session.closed', resolve);
  setTimeout(() => reject(new Error('timeout waiting for chat:session.closed')), 15000);
});
const w7CloseAck = await w7EmitAck('chat:session.close', {
  sessionId: openAck.sessionId,
  reason: 'user',
});
expect('disconnect acked', w7CloseAck.closed, true);
await w7ClosedP;
r = await req('GET', `/api/agent-instances/${w7CcAgent.id}/sessions`, { token: userToken });
expect(
  'native session still listed after disconnect',
  JSON.stringify(r.json.sessions.map((s) => s.sessionId)),
  JSON.stringify(['fx-native-1']),
);

w7App.close();
w7Daemon.kill('SIGTERM');
await new Promise((resolve) => {
  w7Daemon.once('exit', resolve);
  setTimeout(resolve, 3000);
});
await req('DELETE', `/api/machines/${w7MachineId}`, { token: userToken });
rmSync(w7Home, { recursive: true, force: true });
if (w7Err.includes('Error:')) {
  log(
    `(w7 daemon stderr note): ${w7Err
      .split('\n')
      .filter((l) => l.includes('Error:'))
      .slice(0, 3)
      .join(' | ')}`,
  );
}

log('\n--- [#3] machine-scoped chat pre-warm switches ---');
r = await req('POST', '/api/machines', {
  token: userToken,
  body: { name: 'prewarm-box' },
});
expect('enroll prewarm machine', r.status, 201);
const pwMachineId = r.json.machine.id;
r = await req('GET', `/api/machines/${pwMachineId}`, { token: userToken });
expect('map absent by default (defaults apply)', r.json.machine.chatPrewarm, undefined);
// Registration may be toggled off by earlier sections — admin-create instead.
await req('POST', '/api/users', {
  token: adminToken,
  body: { username: 'pwother', password: 'hunter2hunter2' },
});
r = await req('POST', '/api/auth/login', {
  body: { username: 'pwother', password: 'hunter2hunter2' },
});
const pwOtherToken = r.json.token;
r = await req('PATCH', `/api/machines/${pwMachineId}`, {
  token: pwOtherToken,
  body: { chatPrewarm: { 'claude-code': true, codex: true, deepseek: true, opencode: true } },
});
expect('foreign non-owner PATCH hidden 404', r.status, 404);
r = await req('PATCH', `/api/machines/${pwMachineId}`, {
  token: userToken,
  body: { chatPrewarm: { 'claude-code': false, codex: true, deepseek: true, opencode: false } },
});
expect('owner PATCH ok', r.status, 200);
// The map is strict replace-semantics — a legacy 3-key payload is a 400, not
// a silent default-fill (the web normalizes with defaults before sending).
r = await req('PATCH', `/api/machines/${pwMachineId}`, {
  token: userToken,
  body: { chatPrewarm: { 'claude-code': false, codex: true, deepseek: true } },
});
expect('legacy 3-key PATCH rejected 400', r.status, 400);
r = await req('PATCH', `/api/machines/${pwMachineId}`, {
  token: userToken,
  body: { chatPrewarm: { 'claude-code': false, codex: true, deepseek: true, opencode: false } },
});
expect('owner PATCH ok (restore)', r.status, 200);
r = await req('PATCH', `/api/machines/${pwMachineId}`, {
  token: userToken,
  body: { name: 'prewarm-box-2' },
});
expect(
  'unrelated PATCH keeps the map',
  JSON.stringify(r.json.machine.chatPrewarm),
  JSON.stringify({ 'claude-code': false, codex: true, deepseek: true, opencode: false }),
);
await req('DELETE', `/api/machines/${pwMachineId}`, { token: userToken });

log(`\n=== ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
