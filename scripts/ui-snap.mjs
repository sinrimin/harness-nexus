#!/usr/bin/env node
/**
 * ui-snap — visual snapshot rig for the Harness Nexus web UI.
 *
 * Boots the API server (STORAGE_DRIVER=memory, ephemeral JWT secret) and the
 * Vite dev server, seeds a small honest dataset over the REST API, then
 * screenshots the web UI across a matrix of route x skin x mode x viewport
 * with puppeteer-core driving the system Chrome. Baselines live under
 * docs/dev/ui-baselines/ (git-ignored, machine-local).
 *
 * Usage:
 *   node scripts/ui-snap.mjs                        # capture + compare vs baseline
 *   node scripts/ui-snap.mjs --update               # (re)write baselines
 *   node scripts/ui-snap.mjs --routes /login,/machines --modes light
 *   node scripts/ui-snap.mjs --skins signal --viewports desktop,mobile
 *   node scripts/ui-snap.mjs --threshold 0.1 --drift 0.5 --keep
 *
 * Single-mode skins: the capture asks the document which mode it actually
 * resolved to and SKIPS the shot when a skin locks the theme to the other one
 * (BAY ships light only), rather than storing byte-identical duplicates. A
 * refreshed baseline set is pruned to the matrix that produced it.
 *
 * Exit codes: 0 = all shots match (or drift-only warnings); 1 = any shot
 * differs beyond tolerance, is missing, or the rig failed to boot/seed.
 *
 * Verified localStorage keys (see apps/web/src/api.ts, src/i18n/index.tsx,
 * next-themes default storageKey — App.tsx does not override it):
 *   harnessnexus.token  — JWT access token (cleared for the /login shot)
 *   theme               — 'light' | 'dark' (next-themes)
 *   hnx.skin            — SkinId from apps/web/src/skins/registry.ts
 *                         ('signal' is the always-present baseline skin)
 *   hnx.lang            — 'en' | 'zh' (pinned to 'en' for determinism)
 *
 * Determinism measures:
 *   - prefers-reduced-motion: reduce + injected `*{animation:none!important}`
 *   - page clock frozen at a fixed epoch (kills clock-driven re-renders)
 *   - dates and random PAT prefixes are text-masked in the DOM before the
 *     shot ("Sep 23, 2026" -> "000 00, 0000", "hnpat_Ab3xY9" -> zeros)
 *   - CDP Emulation.setDeviceMetricsOverride for viewports (mobile 390x844
 *     @dsf2 — plain --window-size would clamp to a 500px layout viewport)
 *   - settle gate: network-quiet (CDP Network tracking, socket.io polling
 *     excluded) AND two byte-identical screenshot frames before each shot —
 *     lazy route chunks and data fetches land well after the load event
 *   - document.fonts.ready re-awaited AFTER the settle gate (the one right
 *     after `load` resolves before the SPA has requested any font) plus one
 *     more stable-frame gate, so a late webfont swap cannot be captured
 *
 * KNOWN FLAKE (~5% of shots, whole-page 3-8% diff): residual cold-boot timing
 * variance — each shot runs in a fresh browser context against a fresh dev
 * server, and first-paint/font/layout warmup occasionally lands between the
 * gate and the capture. A controlled same-stack A/B is 0-diff, so this is rig
 * noise, not app nondeterminism. If a run flags 1-2 shots, re-run the same
 * filter: real regressions persist, flakes move or vanish.
 */

import { spawn, execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  openSync,
  closeSync,
  readSync,
  statSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import puppeteer from 'puppeteer-core';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API_ORIGIN = 'http://127.0.0.1:8080';
let WEB_ORIGIN = 'http://127.0.0.1:5173'; // refined at boot (prefers 5173)
const BASELINE_DIR = path.join(REPO_ROOT, 'docs', 'dev', 'ui-baselines');
const CURRENT_DIR = path.join(REPO_ROOT, 'docs', 'dev', 'ui-snap-current');
const LOGS_DIR = path.join(REPO_ROOT, 'docs', 'dev', 'ui-snap-logs');

// Route matrix follows the #23 P2 information architecture: one destination
// per kind (the old `/resources?kind=` container is gone), and the skill hub is
// the `?tab=hub` state of /skills. `/hooks` stands in for the four kind pages
// whose bodies are identical until P4.
const ALL_ROUTES = [
  '/login',
  '/',
  '/machines',
  '/chat',
  '/skills',
  '/hooks',
  '/mcp-servers',
  '/profiles',
  '/credentials',
  '/llm-providers',
  '/tokens',
];
// Skin ids from apps/web/src/skins/registry.ts (SkinId union). The registry
// may grow; ids not registered there fall back to the default skin at render
// time, so listing the union members is safe.
const ALL_SKINS = ['signal', 'bay', 'ledger', 'nightwatch'];
const DEFAULT_SKINS = ['signal'];
// The font families each skin's tokens.css puts on --app-font-{sans,mono,
// display} (keep in sync with apps/web/src/skins/*/tokens.css). Skin fonts
// arrive via DYNAMIC css chunks (manifest.load()), so document.fonts can be
// empty of them when fonts.ready first resolves — the capture gate must wait
// for EVERY family to actually be active or shots race fallback-vs-webfont
// metrics (mono-heavy mobile layouts are where the race becomes visible).
const SKIN_FONT_FAMILIES = {
  signal: ['IBM Plex Sans Variable', 'IBM Plex Mono'],
  bay: ['Archivo Variable', 'Archivo Narrow', 'JetBrains Mono'],
  ledger: ['Public Sans', 'Zilla Slab', 'DM Mono'],
  nightwatch: ['Instrument Sans', 'Red Hat Mono'],
};
const ALL_MODES = ['light', 'dark'];
const ALL_VIEWPORTS = ['desktop', 'mobile'];
const VIEWPORT_PRESETS = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
};

const TOKEN_KEY = 'harnessnexus.token';
const THEME_KEY = 'theme';
const SKIN_KEY = 'hnx.skin';
const LANG_KEY = 'hnx.lang';

const SEED_USER = 'snap-admin';
const SEED_PASS = 'snapshot-admin-1';

const BOOT_PAGE = '/login'; // public route used to land on the origin pre-nav
const NAV_TIMEOUT_MS = 30_000;
// Settle gate: a shot is taken only when (a) no non-socket.io HTTP request is
// inflight (lazy route chunks + their data fetches land AFTER the load event;
// plain networkidle never fires because socket.io long-polls forever) and
// (b) two consecutive screenshot frames ~300ms apart are byte-identical.
// CDP quirk: `Network.loadingFinished` never fires for cache-served font
// responses, so after QUIET_FALLBACK_MS visual stability alone suffices.
// Falls through after the budget on genuinely live pages.
const SETTLE_BUDGET_MS = 20_000;
const SETTLE_POLL_MS = 300;
const QUIET_FALLBACK_MS = 4_000;
const FROZEN_EPOCH = Date.UTC(2026, 0, 12, 9, 0, 0);

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    update: false,
    keep: false,
    routes: ALL_ROUTES,
    skins: DEFAULT_SKINS,
    modes: ALL_MODES,
    viewports: ALL_VIEWPORTS,
    threshold: 0.1,
    drift: 0.5,
    help: false,
  };
  const take = (args, i) => {
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) {
      throw new Error(`missing value for ${args[i]}`);
    }
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--update') opts.update = true;
    else if (a === '--keep') opts.keep = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--routes')
      opts.routes = take(argv, i++)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    else if (a === '--skins')
      opts.skins = take(argv, i++)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    else if (a === '--modes')
      opts.modes = take(argv, i++)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    else if (a === '--viewports')
      opts.viewports = take(argv, i++)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    else if (a === '--threshold') opts.threshold = Number(take(argv, i++));
    else if (a === '--drift') opts.drift = Number(take(argv, i++));
    else throw new Error(`unknown option ${a}`);
  }
  // Validate filters against the known sets (typos fail loudly, not silently).
  const badRoute = opts.routes.filter((r) => !ALL_ROUTES.includes(r));
  if (badRoute.length) throw new Error(`unknown route(s): ${badRoute.join(', ')}`);
  const badSkin = opts.skins.filter((s) => !ALL_SKINS.includes(s));
  if (badSkin.length)
    throw new Error(`unknown skin(s): ${badSkin.join(', ')} — available: ${ALL_SKINS.join(', ')}`);
  const badMode = opts.modes.filter((m) => !ALL_MODES.includes(m));
  if (badMode.length) throw new Error(`unknown mode(s): ${badMode.join(', ')}`);
  const badVp = opts.viewports.filter((v) => !ALL_VIEWPORTS.includes(v));
  if (badVp.length) throw new Error(`unknown viewport(s): ${badVp.join(', ')}`);
  return opts;
}

const usage = `ui-snap — visual snapshot rig for the Harness Nexus web UI

Usage: node scripts/ui-snap.mjs [options]

Options:
  --update              write/refresh baselines instead of comparing
  --routes  a,b,c       comma-separated route filter (default: all)
  --skins   s1,s2       skin filter (default: signal; ids per skins/registry.ts)
  --modes   light,dark  mode filter (default: both)
  --viewports d,m       viewport filter: desktop, mobile (default: both)
  --threshold N         pixelmatch per-pixel threshold (default 0.1)
  --drift PCT           differing-pixel % tolerated as drift warning (default 0.5)
  --keep                leave the booted servers running on exit (debugging)
  --help                this help

Routes: ${ALL_ROUTES.join(' ')}
Baselines: docs/dev/ui-baselines/ (git-ignored)`;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(msg) {
  process.stdout.write(`[ui-snap] ${msg}\n`);
}

function warn(msg) {
  process.stderr.write(`[ui-snap] WARN ${msg}\n`);
}

async function fetchJson(url, { method = 'GET', token, body, timeoutMs = 10_000 } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, ok: res.ok, json };
}

function routeSlug(route) {
  const s = route.replace(/^\//, '') || 'root';
  return s.replace(/[^A-Za-z0-9]+/g, '_');
}

function shotName(route, skin, mode, viewport) {
  return `${skin}__${routeSlug(route)}__${mode}__${viewport}`;
}

// ---------------------------------------------------------------------------
// Process management (boot / kill)
// ---------------------------------------------------------------------------

/** True iff 127.0.0.1:<port> can be bound right now. */
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/** First bindable port at or after `preferred`. */
async function pickPort(preferred, attempts = 10) {
  for (let p = preferred; p < preferred + attempts; p++) {
    if (await portFree(p)) return p;
  }
  throw new Error(`no free port in ${preferred}..${preferred + attempts - 1}`);
}

const children = [];
let shuttingDown = false;
let keepServers = false;

function spawnLogged(label, cmd, args, env) {
  // Children outlive the rig under --keep, so their output goes to files —
  // pipes would deliver EPIPE the moment this process exits and the dev
  // servers would die on their next log write.
  mkdirSync(LOGS_DIR, { recursive: true });
  const logPath = path.join(LOGS_DIR, `${label}.log`);
  const fd = openSync(logPath, 'w');
  const child = spawn(cmd, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', fd, fd],
    detached: true, // own process group => kill(-pid) reaps pnpm + grandchildren
  });
  child.on('exit', (code, signal) => {
    if (!shuttingDown)
      log(`${label} exited unexpectedly (code=${code} signal=${signal}; log: ${logPath})`);
    try {
      closeSync(fd);
    } catch {
      /* already closed */
    }
  });
  children.push({ label, child, logPath });
  return child;
}

/** Last ~4KB of a child's log — post-mortem for boot failures. */
function childTail(logPath) {
  try {
    const stat = statSync(logPath);
    const start = Math.max(0, stat.size - 4096);
    const fd = openSync(logPath, 'r');
    try {
      const buf = Buffer.alloc(stat.size - start);
      readSync(fd, buf, 0, buf.length, start);
      return buf.toString('utf8').trimEnd();
    } finally {
      closeSync(fd);
    }
  } catch {
    return '(no output)';
  }
}

/** Best-effort synchronous group kill — used from process 'exit'. */
function killAllSync() {
  if (keepServers) return;
  for (const { child } of children) {
    if (child.exitCode !== null) continue;
    for (const sig of ['SIGTERM', 'SIGKILL']) {
      try {
        process.kill(-child.pid, sig);
      } catch {
        /* already gone */
      }
    }
  }
}

/** Graceful async teardown: SIGTERM, grace period, then SIGKILL. */
async function killAllChildren({ verbose = false } = {}) {
  if (keepServers) return;
  shuttingDown = true;
  const alive = () => children.filter((c) => c.child.exitCode === null);
  for (const { child } of alive()) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  await sleep(1500);
  for (const { child } of alive()) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  if (verbose) {
    for (const { label, logPath } of children) {
      log(`${label} output tail:\n${childTail(logPath)}`);
    }
  }
}

function installExitHandlers() {
  process.on('exit', () => {
    shuttingDown = true;
    killAllSync();
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      shuttingDown = true;
      if (keepServers) {
        log(`received ${sig}; --keep active, spawned servers stay up`);
        process.exit(130);
      }
      log(`received ${sig}, killing spawned servers`);
      killAllSync();
      process.exit(130);
    });
  }
  process.on('unhandledRejection', (err) => {
    shuttingDown = true;
    warn(`unhandled rejection: ${err && err.stack ? err.stack : err}`);
    killAllSync();
    process.exit(1);
  });
}

async function waitForHttp(url, label, timeoutMs) {
  const started = Date.now();
  let lastErr = 'no attempt yet';
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        log(`${label} ready at ${url} (${Math.round((Date.now() - started) / 1000)}s)`);
        return;
      }
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err.code ?? String(err);
    }
    await sleep(500);
  }
  throw new Error(`${label} not ready at ${url} within ${timeoutMs}ms (last: ${lastErr})`);
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

async function seed(token) {
  const created = { mcpServerIds: [] };
  const api = (method, p, body, tokenArg) =>
    fetchJson(`${API_ORIGIN}${p}`, { method, body, ...(tokenArg ? { token: tokenArg } : {}) });

  // Machines (offline — no daemon dials in; honest "configured/offline" rows).
  for (const name of ['dev-laptop', 'ci-runner']) {
    const r = await api('POST', '/api/machines', { name }, token);
    if (r.ok) log(`seeded machine "${name}"`);
    else warn(`machine "${name}" skipped (${r.status} ${r.json?.code ?? ''})`);
    await sleep(30); // strict createdAt ordering for list stability
  }

  // Credentials (global + personal; the LLM provider rows reference them).
  for (const c of [
    {
      name: 'anthropic-key',
      secret: 'sk-snap-demo-anthropic-000000000000',
      scope: 'global',
      distributable: false,
    },
    { name: 'openrouter-key', secret: 'sk-snap-demo-openrouter-0000000000', scope: 'personal' },
  ]) {
    const r = await api('POST', '/api/credentials', c, token);
    if (r.ok) log(`seeded credential "${c.name}"`);
    else warn(`credential "${c.name}" skipped (${r.status} ${r.json?.code ?? ''})`);
    await sleep(30);
  }

  // MCP servers — stdio, client-dialed only. The platform never dials these,
  // so their status is a permanently static "configured": deterministic by
  // construction. (A server-dialed seed was tried — loopback port that
  // refuses — but its status flaps connecting↔error across the run, which
  // made the dashboard constellation and the mcp-servers page nondeterminic
  // shot to shot. Live status is exactly what a snapshot rig cannot freeze.)
  for (const s of [
    {
      name: 'filesystem',
      transport: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      },
      dialSite: 'client',
      scope: 'personal',
    },
  ]) {
    const r = await api('POST', '/api/mcp-servers', s, token);
    if (r.ok) {
      log(`seeded mcp-server "${s.name}"`);
      const id = r.json?.mcpServer?.id;
      if (id) created.mcpServerIds.push(id);
    } else {
      warn(`mcp-server "${s.name}" skipped (${r.status} ${r.json?.code ?? ''})`);
    }
    await sleep(30);
  }

  // Profile referencing the first seedable MCP server entry.
  const firstServerId = created.mcpServerIds[0];
  const profile = {
    name: 'daily-driver',
    description: 'UI snapshot seed profile',
    target: 'claude-code',
    scope: 'personal',
    ...(firstServerId ? { entries: [{ mcpServerId: firstServerId }] } : {}),
  };
  {
    const r = await api('POST', '/api/profiles', profile, token);
    if (r.ok) log('seeded profile "daily-driver"');
    else warn(`profile skipped (${r.status} ${r.json?.code ?? ''})`);
  }

  // Resources: a skill + a rule, inline bodies.
  for (const res of [
    {
      key: 'commit-discipline',
      kind: 'skill',
      name: 'Commit discipline',
      description: 'Write honest, reviewable commit messages.',
      version: '1.0.0',
      source: {
        type: 'inline',
        content: '# Commit discipline\n\nSmall commits, honest messages.\n',
      },
      scope: 'personal',
      targets: ['claude-code', 'codex'],
    },
    {
      key: 'no-force-push',
      kind: 'rule',
      name: 'No force push',
      description: 'Never rewrite shared history.',
      version: '1.0.0',
      source: { type: 'inline', content: '# No force push\n\nShared branches are immutable.\n' },
      scope: 'personal',
      targets: ['claude-code'],
    },
  ]) {
    const r = await api('POST', '/api/resources', res, token);
    if (r.ok) log(`seeded ${res.kind} "${res.key}"`);
    else warn(`${res.kind} "${res.key}" skipped (${r.status} ${r.json?.code ?? ''})`);
    await sleep(30);
  }

  // LLM providers (reference credentials by name — never the secret).
  for (const p of [
    {
      name: 'Anthropic',
      api: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      credentialName: 'anthropic-key',
      scope: 'global',
    },
    {
      name: 'OpenRouter',
      api: 'openai-chat',
      baseUrl: 'https://openrouter.ai/api/v1',
      credentialName: 'openrouter-key',
      scope: 'personal',
    },
  ]) {
    const r = await api('POST', '/api/llm-providers', p, token);
    if (r.ok) log(`seeded llm-provider "${p.name}"`);
    else warn(`llm-provider "${p.name}" skipped (${r.status} ${r.json?.code ?? ''})`);
    await sleep(30);
  }

  // PATs (one api, one marketplace) so /tokens has rows.
  for (const p of [
    { name: 'ci token', kind: 'api' },
    { name: 'marketplace emitter', kind: 'marketplace' },
  ]) {
    const r = await api('POST', '/api/pats', p, token);
    if (r.ok) log(`seeded pat "${p.name}"`);
    else warn(`pat "${p.name}" skipped (${r.status} ${r.json?.code ?? ''})`);
    await sleep(30);
  }
}

async function obtainToken() {
  const reg = await fetchJson(`${API_ORIGIN}/api/auth/register`, {
    method: 'POST',
    body: { username: SEED_USER, password: SEED_PASS, email: 'snap@example.com' },
  });
  if (reg.ok && reg.json?.token) {
    log(`registered "${SEED_USER}" (first user -> bootstrap admin)`);
  } else if (reg.status === 409) {
    log(`user "${SEED_USER}" already exists (server not fresh) — logging in`);
  } else {
    throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.json)}`);
  }
  // Always go through the login route — the rig's token is a login token,
  // exactly like the web UI's own flow.
  const login = await fetchJson(`${API_ORIGIN}/api/auth/login`, {
    method: 'POST',
    body: { username: SEED_USER, password: SEED_PASS },
  });
  if (!login.ok || !login.json?.token) {
    throw new Error(`login failed: ${login.status} ${JSON.stringify(login.json)}`);
  }
  const me = await fetchJson(`${API_ORIGIN}/api/auth/me`, { token: login.json.token });
  log(`login ok — user "${me.json?.user?.username}" role=${me.json?.user?.role}`);
  if (me.json?.user?.role !== 'admin') {
    throw new Error('seed user is not admin — first-register bootstrap did not apply');
  }
  return login.json.token;
}

// ---------------------------------------------------------------------------
// Chrome / puppeteer
// ---------------------------------------------------------------------------

function findChrome() {
  const candidates = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  for (const bin of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try {
      const p = execSync(`which ${bin}`, { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim();
      if (p) return p;
    } catch {
      /* not on PATH */
    }
  }
  throw new Error(
    'no Chrome/Chromium binary found (tried google-chrome, google-chrome-stable, chromium)',
  );
}

// Injected before any page script runs: freeze the clock and kill animations.
const INIT_SCRIPT = `
  (() => {
    try {
      const FIXED = ${FROZEN_EPOCH};
      const RealDate = Date;
      class FrozenDate extends RealDate {
        constructor(...args) { super(...(args.length ? args : [FIXED])); }
        static now() { return FIXED; }
      }
      globalThis.Date = FrozenDate;
    } catch (e) { /* never break the page */ }
    try {
      const style = document.createElement('style');
      style.textContent = [
        '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}',
        'html{scroll-behavior:auto!important}',
      ].join('');
      (document.head || document.documentElement).appendChild(style);
    } catch (e) { /* never break the page */ }
  })();
`;

// Mask dynamic text in-place: dates (server-side createdAt differs per boot)
// and random PAT prefixes. Same-length zero-fill keeps layout identical.
const MASK_SCRIPT = `
  (() => {
    const DATE_RE = /\\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\\s+\\d{1,2},?\\s+\\d{4}\\b|\\b\\d{1,2}\\/\\d{1,2}\\/\\d{4},\\s*\\d{1,2}:\\d{2}:\\d{2}(?:\\s*(?:AM|PM))?|\\b\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z?\\b/g;
    const PAT_RE = /\\bhnpat_[A-Za-z0-9_-]+/g;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    let masked = 0;
    for (const n of nodes) {
      const s = n.nodeValue;
      if (!s || (!/[\\d]/.test(s) && !s.includes('hnpat_'))) continue;
      const next = s
        .replace(DATE_RE, (m) => '0'.repeat(m.length))
        .replace(PAT_RE, (m) => '0'.repeat(m.length));
      if (next !== s) { n.nodeValue = next; masked++; }
    }
    return masked;
  })();
`;

async function captureShot(browser, { route, skin, mode, viewport, token }) {
  const preset = VIEWPORT_PRESETS[viewport];
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  try {
    await page.evaluateOnNewDocument(INIT_SCRIPT);
    await page.emulateMediaFeatures([
      { name: 'prefers-color-scheme', value: mode },
      { name: 'prefers-reduced-motion', value: 'reduce' },
    ]);
    // CDP device emulation — the authoritative viewport override. Plain
    // window sizing clamps the headless layout viewport to >=500px, which
    // would silently break the 390px mobile shot.
    const cdp = await page.createCDPSession();
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: preset.width,
      height: preset.height,
      deviceScaleFactor: preset.deviceScaleFactor,
      mobile: preset.mobile,
    });
    if (preset.mobile) {
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    }
    // Track inflight HTTP, ignoring the socket.io long-poll (its ~25s pending
    // GET is exactly what makes puppeteer's networkidle useless here) and font
    // files (document.fonts.ready gates those; CDP also never reports
    // loadingFinished for cache-served font responses).
    const inflight = new Set();
    const isNoise = (url) =>
      url.includes('/socket.io/') ||
      url.startsWith('data:') ||
      /\.(?:woff2?|ttf|otf)(?:\?|$)/.test(url);
    cdp.on('Network.requestWillBeSent', (p) => {
      if (!isNoise(p.request.url)) inflight.add(p.requestId);
    });
    const done = (p) => inflight.delete(p.requestId);
    cdp.on('Network.loadingFinished', done);
    cdp.on('Network.loadingFailed', done);
    // Cache-served responses (font files on every shot after the first) never
    // produce loadingFinished — release them or `quiet` is permanently false.
    cdp.on('Network.requestServedFromCache', done);
    await cdp.send('Network.enable');
    // Also route through puppeteer's own viewport bookkeeping (same CDP
    // command under the hood; keeps screenshot metrics consistent).
    await page.setViewport({
      width: preset.width,
      height: preset.height,
      deviceScaleFactor: preset.deviceScaleFactor,
      isMobile: preset.mobile,
      hasTouch: preset.mobile,
    });

    // Land on the origin once, install prefs, then navigate for real.
    await page.goto(`${WEB_ORIGIN}${BOOT_PAGE}`, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT_MS,
    });
    await page.evaluate(
      (keys, vals) => {
        localStorage.setItem(keys.theme, vals.mode);
        localStorage.setItem(keys.skin, vals.skin);
        localStorage.setItem(keys.lang, 'en');
        if (vals.token) localStorage.setItem(keys.token, vals.token);
        else localStorage.removeItem(keys.token);
      },
      { token: TOKEN_KEY, theme: THEME_KEY, skin: SKIN_KEY, lang: LANG_KEY },
      { mode, skin, token: token ?? null },
    );

    await page.goto(`${WEB_ORIGIN}${route}`, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });
    await page.evaluate(() => document.fonts.ready);
    // Settle gate: network-quiet AND visually stable (two byte-identical
    // frames). A page can look "stably blank" while a lazy chunk is still
    // in flight — the inflight check is what makes the gate trustworthy.
    const startedAt = Date.now();
    const settle = async () => {
      const deadline = startedAt + SETTLE_BUDGET_MS;
      let prev = null;
      for (;;) {
        const quiet = inflight.size === 0;
        const frame = await page.screenshot({ type: 'png' });
        const stable = prev !== null && frame.equals(prev);
        if (
          (quiet && stable) ||
          (Date.now() - startedAt >= QUIET_FALLBACK_MS && stable) ||
          Date.now() > deadline
        ) {
          break;
        }
        prev = frame;
        await sleep(SETTLE_POLL_MS);
      }
    };
    await settle();
    // Vite pushes HMR updates while sources are being edited (this rig runs
    // against a dev server); a full-reload landing mid-shot would capture a
    // flash frame. If the vite overlay or an in-flight reload is visible,
    // let it settle and gate once more.
    const overlay = await page.evaluate(
      () => document.querySelector('vite-error-overlay') !== null,
    );
    if (overlay) {
      warn(`${route}: vite error overlay visible — waiting it out`);
      await sleep(2_000);
      await settle();
    }
    // Font race: `document.fonts.ready` awaited right after `load` resolves
    // BEFORE the SPA has rendered (no font requests in flight yet), and skin
    // fonts arrive even later (dynamic css chunks from manifest.load()). Wait
    // for the active skin's sans family to be loaded, then gate on stable
    // frames once more so a late font swap cannot land after the gate.
    const skinFamilies = SKIN_FONT_FAMILIES[skin] ?? SKIN_FONT_FAMILIES.signal;
    await page.evaluate(async (families) => {
      // The gate's clock must be `performance.now()`: INIT_SCRIPT freezes
      // `Date`, and a `Date.now()` deadline therefore NEVER arrives — a page
      // that does not use one of the families (the login page has no mono
      // text, and Chrome's FontFaceSet.check() reports a face as unavailable
      // until it is actually fetched) spun here until the CDP protocol
      // timeout killed the whole run. Fixed 2026-09-24; see test-rig.md.
      const check = () =>
        families.every((f) => document.fonts.check(`16px "${f}"`)) &&
        document.fonts.status === 'loaded';
      const started = performance.now();
      while (performance.now() - started < 10_000) {
        if (check()) return true;
        await new Promise((r) => setTimeout(r, 100));
      }
      // Not used on this page — nothing to wait for; the visuals-only settle
      // gate below still guards a late swap.
      return false;
    }, skinFamilies);
    await settle();
    // Landed where we aimed? A shot that settles on `/login` because the token
    // was not in place yet is a perfectly stable LOGIN page — and the rig spent
    // a whole matrix run writing such frames as baselines (found in P8: the
    // skills-route baseline was a login screenshot, 33% apart from reality).
    // Fail loudly instead; the caller retries once, and a persistent failure
    // stops the run rather than poisoning the baseline set.
    const landed = await page.evaluate(() => ({
      path: location.pathname,
      search: location.search,
    }));
    const wantPath = route.split('?')[0];
    if (landed.path !== wantPath) {
      throw new Error(
        `landed on ${landed.path}${landed.search} instead of ${route}` +
          `${landed.path === '/login' ? ' (token not installed / rejected)' : ''}`,
      );
    }
    // Single-mode skins LOCK the theme (skin-provider forces the manifest's
    // only mode), so a shot for the other mode is a byte-identical duplicate —
    // P3 measured 22 of 88 that way. Ask the document what it actually
    // resolved to, instead of mirroring each manifest here: a skin that starts
    // shipping its second mode is picked up with no edit to this rig.
    const resolvedMode = await page.evaluate(() =>
      document.documentElement.classList.contains('dark') ? 'dark' : 'light',
    );
    if (resolvedMode !== mode) {
      return { skipped: `skin locks ${resolvedMode}` };
    }
    await page.evaluate(MASK_SCRIPT);
    const png = await page.screenshot({ type: 'png' });
    return png;
  } finally {
    await context.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Compare
// ---------------------------------------------------------------------------

function pngFromBuffer(buf) {
  return PNG.sync.read(buf);
}

function compareShot(name, currentBuf, baselineBuf, threshold, driftPct) {
  const img = pngFromBuffer(currentBuf);
  const base = pngFromBuffer(baselineBuf);
  if (img.width !== base.width || img.height !== base.height) {
    return {
      status: 'DIFF',
      detail: `size mismatch: ${img.width}x${img.height} vs ${base.width}x${base.height}`,
      px: img.width * img.height,
      total: img.width * img.height,
      diffPng: null,
    };
  }
  const { width, height } = img;
  const diff = new PNG({ width, height });
  const px = pixelmatch(base.data, img.data, diff.data, width, height, { threshold });
  const pct = (px / (width * height)) * 100;
  const status = pct > driftPct ? 'DIFF' : px > 0 ? 'DRIFT' : 'MATCH';
  return {
    status,
    detail:
      px === 0
        ? ''
        : `${pct.toFixed(4)}% of ${width * height}px${pct > driftPct ? ' (over drift budget)' : ''}`,
    px,
    total: width * height,
    diffPng: PNG.sync.write(diff),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`${usage}\n`);
    return 0;
  }
  installExitHandlers();

  // Build the matrix. Only /login runs logged out; authed routes need the
  // token, and a no-token authed route would just redirect to /login (a
  // duplicate shot with a misleading name).
  const matrix = [];
  for (const route of opts.routes) {
    for (const skin of opts.skins) {
      for (const mode of opts.modes) {
        for (const viewport of opts.viewports) {
          matrix.push({
            route,
            skin,
            mode,
            viewport,
            token: route === '/login' ? null : 'PENDING',
          });
        }
      }
    }
  }
  log(
    `matrix: ${matrix.length} shot(s) = ${opts.routes.length} route(s) x ${opts.skins.length} skin(s) x ` +
      `${opts.modes.length} mode(s) x ${opts.viewports.length} viewport(s)${opts.update ? ' [UPDATE]' : ''}`,
  );

  // ---- boot -------------------------------------------------------------
  // The vite proxy is hardcoded to 127.0.0.1:8080 (apps/web/vite.config.ts),
  // so the API must live there; a busy 8080 is a hard error. Vite itself is
  // port-flexible (the proxy target does not depend on vite's own port):
  // prefer 5173, fall back upward so a stray dev server doesn't wedge the rig.
  if (!(await portFree(8080))) {
    throw new Error(
      'port 8080 is already in use — the API server must bind it (vite proxies /api there)',
    );
  }
  const webPort = await pickPort(5173);
  WEB_ORIGIN = `http://127.0.0.1:${webPort}`;
  const jwtSecret = randomBytes(32).toString('hex');
  log('booting API server (STORAGE_DRIVER=memory, ephemeral JWT secret, :8080)');
  spawnLogged('api-server', 'pnpm', ['--filter', '@harness-nexus/server', 'run', 'dev'], {
    JWT_SECRET: jwtSecret,
    STORAGE_DRIVER: 'memory',
    PORT: '8080',
  });
  log(`booting web dev server (vite, :${webPort}, strictPort)`);
  spawnLogged(
    'web-dev',
    'pnpm',
    [
      '--filter',
      '@harness-nexus/web',
      'run',
      'dev',
      '--',
      '--port',
      String(webPort),
      '--strictPort',
      '--host',
      '127.0.0.1',
    ],
    {},
  );

  await waitForHttp(`${API_ORIGIN}/healthz`, 'api-server', 180_000);
  await waitForHttp(`${WEB_ORIGIN}/`, 'web-dev', 120_000);

  // ---- seed -------------------------------------------------------------
  const token = await obtainToken();
  for (const m of matrix) if (m.token === 'PENDING') m.token = token;
  await seed(token);

  // ---- capture ----------------------------------------------------------
  const chromePath = findChrome();
  log(`launching Chrome: ${chromePath}`);
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-color-profile=srgb',
      '--disable-lcd-text',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  mkdirSync(BASELINE_DIR, { recursive: true });
  if (!opts.update) rmSync(CURRENT_DIR, { recursive: true, force: true });
  mkdirSync(CURRENT_DIR, { recursive: true });

  const results = [];
  try {
    for (let i = 0; i < matrix.length; i++) {
      const shot = matrix[i];
      const name = shotName(shot.route, shot.skin, shot.mode, shot.viewport);
      let png;
      try {
        png = await captureShot(browser, shot);
      } catch (err) {
        // A vite full-reload (HMR from concurrent source edits) can destroy
        // the page context mid-shot — one clean retry usually clears it.
        warn(`${name}: capture failed (${err.message ?? err}) — retrying once`);
        png = await captureShot(browser, shot);
      }
      if (png !== null && typeof png === 'object' && 'skipped' in png) {
        results.push({
          name,
          status: 'SKIPPED',
          detail: png.skipped,
          px: 0,
          total: 0,
        });
        log(`(${i + 1}/${matrix.length}) ${name} -> SKIPPED (${png.skipped})`);
        continue;
      }
      writeFileSync(path.join(CURRENT_DIR, `${name}.png`), png);
      const baselinePath = path.join(BASELINE_DIR, `${name}.png`);

      if (opts.update) {
        writeFileSync(baselinePath, png);
        results.push({ name, status: 'UPDATED', detail: '', px: 0, total: 0 });
      } else if (!existsSync(baselinePath)) {
        results.push({
          name,
          status: 'MISSING',
          detail: 'no baseline (run with --update)',
          px: 0,
          total: 0,
        });
      } else {
        const r = compareShot(name, png, readFileSync(baselinePath), opts.threshold, opts.drift);
        if (r.diffPng) writeFileSync(path.join(CURRENT_DIR, `${name}.diff.png`), r.diffPng);
        results.push({ name, status: r.status, detail: r.detail, px: r.px, total: r.total });
      }
      log(`(${i + 1}/${matrix.length}) ${name} -> ${results[results.length - 1].status}`);
    }
  } finally {
    await browser.close().catch(() => {});
    keepServers = opts.keep;
    if (!opts.keep) {
      await killAllChildren({ verbose: false });
    } else {
      log(`--keep: servers left running (api ${API_ORIGIN}, web ${WEB_ORIGIN})`);
    }
  }

  // ---- report -----------------------------------------------------------
  // A refreshed baseline set must equal the matrix: without pruning, the
  // duplicates a single-mode skin used to produce (`bay__dark__*`) would stay
  // on disk forever and be reported as MISSING on the next compare run.
  //
  // Prune ONLY inside the requested matrix. A run narrowed to one skin or one
  // route (`--skins bay`) must not delete the shots it did not ask for — the
  // first version of this did, which would have silently thrown away the other
  // skin's baselines. A name reads `<skin>__<route>__<mode>__<viewport>.png`.
  let pruned = 0;
  if (opts.update) {
    const produced = new Set(
      results.filter((r) => r.status === 'UPDATED').map((r) => `${r.name}.png`),
    );
    const wanted = new Set(
      matrix.map((s) => `${shotName(s.route, s.skin, s.mode, s.viewport)}.png`),
    );
    for (const file of readdirSync(BASELINE_DIR)) {
      if (!file.endsWith('.png') || produced.has(file) || !wanted.has(file)) continue;
      rmSync(path.join(BASELINE_DIR, file));
      pruned++;
    }
    if (pruned) log(`pruned ${pruned} baseline(s) the matrix no longer produces`);
  }

  const width = Math.max(10, ...results.map((r) => r.name.length));
  process.stdout.write(
    `\n${'SHOT'.padEnd(width)}  ${'RESULT'.padEnd(8)} ${'DIFF PX'.padStart(10)} ${'PCT'.padStart(9)}  DETAIL\n`,
  );
  process.stdout.write(
    `${'-'.repeat(width)}  ${'-'.repeat(8)} ${'-'.repeat(10)} ${'-'.repeat(9)}  ${'-'.repeat(30)}\n`,
  );
  for (const r of results) {
    const pct = r.total ? ((r.px / r.total) * 100).toFixed(4) : '';
    process.stdout.write(
      `${r.name.padEnd(width)}  ${r.status.padEnd(8)} ${String(r.px).padStart(10)} ${pct.padStart(9)}  ${r.detail}\n`,
    );
  }

  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const summary = Object.entries(counts)
    .map(([k, v]) => `${v} ${k.toLowerCase()}`)
    .join(', ');
  process.stdout.write(`\n[ui-snap] summary: ${summary || 'nothing'}\n`);
  process.stdout.write(
    `[ui-snap] baselines: ${BASELINE_DIR}${opts.update ? ' (refreshed)' : ''}; current shots/diffs: ${CURRENT_DIR}\n`,
  );

  const failed = results.filter((r) => r.status === 'DIFF' || r.status === 'MISSING');
  if (opts.update) return 0;
  if (failed.length) {
    process.stdout.write(`[ui-snap] FAIL: ${failed.length} shot(s) differ or lack baselines\n`);
    return 1;
  }
  if (counts.DRIFT)
    warn(`${counts.DRIFT} shot(s) drifted within tolerance (<= ${opts.drift}% differing pixels)`);
  process.stdout.write('[ui-snap] OK: all shots match baseline\n');
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
    process.exit(code);
  },
  async (err) => {
    warn(`fatal: ${err && err.stack ? err.stack : err}`);
    await killAllChildren({ verbose: true }).catch(() => {});
    process.exit(1);
  },
);
