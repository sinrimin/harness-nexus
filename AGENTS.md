# AGENTS.md — Harness Nexus workspace guide

This file orients future ZCode (and Claude Code) agents working in this repo.
Read it before making changes; respect the layering below. Feature specifics
live on the wiki — this file is orientation, index, and rules.

## What this project is

**Harness Nexus** (`harnessnexus`, npm scope `@harness-nexus/*`) is a unified management
platform for Agent-tool assets (Claude Code, ZCode, Hermes) across machines. Four
pillars:

1. **MCP proxy** — consume upstream MCP servers once, re-expose one aggregated
   server to every tool. (`packages/server/src/mcp/`)
2. **Resources & profiles** — versioned skills/hooks/sub-agents/rules/MCP defs,
   bundled into installable profiles. (`packages/core/src/domain/`)
3. **Third-party harness import** — ECC / Superpower release packages folded into
   profiles. (Import adapters: not yet built — the remaining Phase 3 work.)
4. **Users, roles, PATs** — global vs. personal scoping + personal access tokens.
   (`packages/core/src/domain/user.ts`)

> The directory is still named `mcp-proxy` for historical reasons; the project
> name is `harnessnexus`. Don't be confused by the path.

## Stack

Node.js ≥20 · TypeScript (strict) · Fastify · pnpm workspaces · zod ·
SQLite (`better-sqlite3`, default; pluggable) · official `@modelcontextprotocol/sdk` ·
React + Vite (web).

## Repository layout

```
packages/
  core/        domain entities + repository PORTS (pure TS — NO I/O, NO frameworks)
  shared/      zod schemas + utils — single source of truth for manifest shapes
  server/      Fastify API + MCP proxy + storage DRIVERS (sqlite/memory)
  sdk-ts/      HTTP client SDK
  cli/         `hnx` one-click install tool (fetches profiles from a server via the SDK)
  acp-bridge/  local ACP <-> Harness Nexus daemon (roadmap)
apps/web/      React + TS + Vite admin UI
docs/          architecture.md + adr/ — code-coupled contract docs ONLY
```

> **Process & feature docs live in the GitHub wiki**, not in this repo:
> feature guides (`features/`), PRDs, technical designs, research notes, and
> the historical roadmap (`dev/…`). The wiki is itself a git repository —
> keep a clone next to this repo at `../harness-nexus.wiki`
> (`https://github.com/sinrimin/harness-nexus.wiki.git`; browse:
> <https://github.com/sinrimin/harness-nexus/wiki>) and edit it through git,
> never the web editor. Doc references in this file of the form
> `design-…`, `research-…`, `prd-…` resolve inside that clone.
> Exception: `docs/dev/test-rig.md` (verification-rig notes) is
> machine-specific and stays **local + git-ignored** — it is NOT on the wiki.
> Contributing workflow (issues, milestones, PRs): root `CONTRIBUTING.md`.

## Architecture rules (enforced — a regression if violated)

1. **`packages/core` stays pure.** Only domain types and repository _interfaces_
   (ports). Never import Fastify, the MCP SDK, `better-sqlite3`, or any storage
   driver here. Concrete repository implementations live ONLY under
   `packages/server/src/infra/storage/*`.
2. **Dependencies flow one way.** `server`, `cli`, `sdk-ts`, `acp-bridge`, `web`
   may depend on `core`/`shared`. `core` depends on nothing in this repo.
3. **Storage is pluggable via `UnitOfWork`** (`core/src/ports/repository.ts`).
   Adding a backend = new folder under `server/src/infra/storage/`, implement all
   five repositories, add a case in `server/src/infra/storage/factory.ts`. Nothing
   else changes. The in-memory driver (`memory/index.ts`) is the reference shape.
4. **MCP transport is decoupled from REST routes.** Keep aggregation in
   `server/src/mcp/` (`McpRegistry` + `packages/mcp-runtime`) so the same
   registry can serve stdio, SSE, and streamable-http. Do not push MCP logic
   into route handlers.
5. **Manifest schemas live in `packages/shared`.** Server, web, and CLI must all
   validate via those zod schemas — keep them in sync with `core` domain types.
6. **The CLI fetches profiles from a server.** `packages/cli` resolves a profile
   via `@harness-nexus/sdk` against a running Harness Nexus server and installs
   it into a target Agent tool. It does **not** read local manifests — a profile
   is a reference bundle (its `entries` point at server-side resources by id),
   so the resource bodies and the aggregated `/mcp` endpoint both require the
   server. This replaces an earlier "must run standalone" rule that was written
   before the reference-style profile model landed.

## Git discipline — branch always, merge explicitly, push only on request

- **No direct commits to `main`.** Every unit of work is anchored to a GitHub
  issue (`#N`), lands on a short-lived branch named after it
  (`feat/123-…`, `fix/124-…`, `docs/…`, `chore/…`), and is merged back with an
  explicit merge commit (`git merge --no-ff <branch>`) whose message references
  the issue — use `closes #123` (GitHub only auto-closes on the closing
  keywords; a bare `(#123)` is just a link) — mirroring the standard
  open-source PR flow (issue → branch → reviewable commits → merge). Never
  build on top of an unmerged branch unless intended.
- **Milestones are release buckets.** A `vX.Y.Z` milestone is opened per
  release; assigning an issue to it = selecting it for that release. Closing
  the milestone accompanies the release tag; release notes come from its
  closed issues.
- **Verify before merging:** typecheck + the relevant tests/smoke for the touched
  surfaces. Unverified code must not reach `main`.
- **Run the CI-parity gate before pushing:** CI (`.github/workflows/ci.yml`) is
  `pnpm -r build` + `pnpm -r typecheck` + `pnpm -r test` on **Node 20** — the
  documented engine floor. A dev box on a newer Node masks floor-only paths
  (e.g. `zlib.zstd*` exists ≥22.15; a zstd-absent test guard once errored only
  in CI). `task verify` (Taskfile) runs the same quartet with a Node 20
  toolchain from `/opt/node-v20.20.2-linux-x64/bin` (override via `NODE20_BIN`);
  without `task`, prepend that bin dir to PATH and run the three `pnpm -r`
  commands yourself. Green locally ⇒ green in CI.
- **Never push without an explicit user request.** `git push` — and any outward
  publish (`npm publish`, `gh pr create`, `gh release`) — happens ONLY when the user
  asks for it in the current session. Committing/merging locally is fine. This
  overrides any workflow text that says "merge main and push".

## Common commands

The repo uses [Task](https://taskfile.dev) as a convenience wrapper around pnpm.
Either form works.

```bash
pnpm install                 # first-time setup
task dev          | pnpm dev               # all packages, watch mode (parallel)
task dev:server   | pnpm --filter @harness-nexus/server run dev   # API on :8080
task dev:web      | pnpm --filter @harness-nexus/web run dev      # UI on :5173
task build        | pnpm -r run build
task test         | pnpm -r run test
task typecheck    | pnpm -r run typecheck
task lint         | pnpm -r run lint
task format       | pnpm format
task clean        | pnpm clean
```

Run a single package by filter, e.g. `pnpm --filter @harness-nexus/core run build`.

To boot the server without SQLite set up: `STORAGE_DRIVER=memory pnpm dev:server`.

### Releasing to npm & Docker Hub

Five packages publish in lockstep (`@harness-nexus/{core,shared,mcp-runtime,sdk,cli}`).
**The flow is tag-driven (2026-09-11 onward):**

1. Bump `version` in all five manifests on a branch, merge to main — after the
   CI-parity gate (`task verify`, Node 20) ran green.
2. `git tag vX.Y.Z && git push origin vX.Y.Z` — pushing the tag triggers the
   `release` workflow. The tag MUST equal the manifests' version (the workflow
   guards it and fails on mismatch); the tag is the release record.
3. Each publish SKIPS versions already on npm, so re-running the same tag or
   retrying a partially failed run is a no-op for what already landed.
   Manual dispatch from main (`workflow_dispatch`) remains the fallback — it
   publishes whatever the manifests say, unguarded by any tag.

The SAME tag push also publishes the Docker images (`docker.yml`, 2026-09-15):
`sinrimin/harness-nexus-server` + `sinrimin/harness-nexus-web` on Docker Hub,
tagged `X.Y.Z` + `latest` (pre-1.0 the alphas ARE latest, mirroring npm),
`linux/amd64` only for now (QEMU-emulated arm64 builds are prohibitively slow).
Credentials are ENVIRONMENT secrets on the `release` environment
(`DOCKERHUB_USERNAME`/`DOCKERHUB_TOKEN` — a Docker Hub PAT, Read & Write,
repo-scoped); the job declares `environment: release`, the environment's
deployment rule restricts it to `v*` tags, and adding required reviewers to
the environment later gates publishes behind approval. `docker.yml` re-uses
release.yml's tag-must-match-manifests guard so a mistyped tag fails BOTH
workflows. Manual dispatch from main (`workflow_dispatch`) is the fallback —
it publishes the manifests' version, and it is the ONLY way to image an
already-released version (re-pushing an old tag fires nothing: a workflow
only runs if it exists in the tagged commit). The environment's deployment
allowlist must therefore include the `main` BRANCH alongside the `v*` tags,
or dispatch runs are rejected by the environment gate. Unlike npm, Docker
tags are mutable — re-pushing a tag just
overwrites with identical content. `docker-compose.yml` carries both image
names with `build:` still primary, so this box keeps deploying from source
while `docker compose pull` fetches the published images.

Publishing uses **OIDC trusted publishing** — zero npm credentials in GitHub
(per-package trusted publisher registered on npmjs.com: sinrimin/harness-nexus +
`release.yml`). pnpm itself doesn't support tokenless publishing, so the workflow
`pnpm pack`s each package (which substitutes `workspace:` versions) and
`npm publish`es the tarballs with `--tag latest` (npm ≥ 12 demands an explicit
tag for prereleases; pre-1.0 the alphas ARE latest so `npx` works out of the
box). Manual channel from a dev machine:
`npm_config_registry=https://registry.npmjs.org/ pnpm -r publish` with a granular
bypass-2FA token in `~/.npmrc` — a machine whose `~/.npmrc` defaults to a
registry mirror MUST override the registry explicitly or auth silently targets
the mirror.

## Coding conventions

- **TypeScript strict**, ESM (`"type": "module"`), `moduleResolution: "Bundler"`,
  `verbatimModuleSyntax: true`. Shared flags in `tsconfig.base.json`.
- **Use `import type` for type-only imports** (required by `verbatimModuleSyntax`).
- **Relative imports inside a package use `.js` extensions** (e.g.
  `./domain/user.js`) — ESM output expects them even for TS sources.
- **Cross-package imports use the scoped name**, e.g.
  `import type { Resource } from '@harness-nexus/core'`.
- **Ports vs. implementations**: define interfaces in `core/src/ports/`,
  implement them in `server/src/infra/`. Route modules depend on the interface,
  never a concrete driver.
- **Errors**: throw `AppError` from `@harness-nexus/shared` for expected failures;
  Fastify maps `statusCode`/`code` to the response.
- **Formatting**: Prettier (single quotes, trailing comma `all`, 100 cols). Run
  `pnpm format` before committing.
- **Config from env**, with defaults, in `packages/server/src/config.ts`. Don't
  read `process.env` ad hoc inside modules.
- **Logging**: use the Fastify logger (`app.log` / `req.log`), not `console.*`
  (the CLI/bridge daemons may use `console` until they get a logger).

## Web UI design system ("Signal")

The `apps/web` UI follows a deliberate system, not stock shadcn defaults. Read
this before adding screens or components so the look stays consistent.

- **Concept.** The interface is a _signal console_. Color encodes connection
  state only; everything else is a disciplined cool neutral. The single accent
  — `--signal` (cyan) — marks what is live: links, focus, the brand mark, and
  (once Phase 2.2 ships) online connections. Spend that accent in one place per
  view; do not sprinkle it as decoration.
- **Tokens live in `apps/web/src/index.css`.** Light + dark are both defined;
  `color-scheme` is set per theme. Do not hardcode hex in components — derive
  from the CSS variables (`bg-background`, `text-signal`, etc.). The semantic
  palette maps through the `chart-*` tokens: `--signal`, `--ok`, `--warn`,
  `--danger` are the only colors that carry meaning.
- **Typography.** IBM Plex Sans (UI + body) and IBM Plex Mono (URLs, headers,
  tokens, transport types, all numeric data) are **self-hosted via Fontsource**
  — never load external font CDNs; this product handles secrets and makes no
  outbound requests for assets. Use the `.nums` helper or `tabular-nums` for any
  column of figures or monospaced protocol strings.
- **Brand.** The mark (hexagonal ribbon), wordmark, and favicon are inline SVG
  (`components/brand-mark.tsx`, `public/favicon.svg`); the full logo asset is
  `docs/assets/logo.svg` (used by the README headers). The mark carries its own
  brand blues via `--brand-{bright,mid,deep}` tokens (deep navy is lifted in
  dark theme) — separate from the UI's `--signal` accent. Reuse `<Brand>`;
  don't introduce a raster logo.
- **Honesty over decoration.** The Dashboard mesh topology (`components/
mesh-topology.tsx`) renders upstreams as "configured" (muted), **never** a
  green "online" dot — live aggregation is Phase 2.2 and faking status would
  mislead. When 2.2 lands, swap the `Dot` variant per real state; the geometry
  already supports it.
- **Chrome.** `AppShell` provides the sidebar + header and a skip link to
  `#main`. The mobile nav is a Radix `Dialog` drawer (`components/mobile-nav.tsx`)
  that mirrors the same `navItems()`. Add new routes to `navItems()` in
  `app-shell.tsx` so both surfaces stay in sync.
- **Theme.** Defaults to the OS preference (`system`), user-overridable via the
  header toggle. The toggle keys off `resolvedTheme` so the icon is correct even
  while following the system.
- **Form hygiene (Web Interface Guidelines).** Every text input sets
  `autoComplete`, and protocol/identifier inputs also set `spellCheck={false}`
  and `inputMode` where applicable. Destructive actions confirm first. Headings
  keep a strict hierarchy and get `text-wrap: balance` from the base layer.
- **Frontend perf (Vercel React best practices).** Fetch independent lists with
  `Promise.all` (see `Dashboard.tsx`). Define sub-components at module scope,
  never inside another component. Prefer functional `setState`. Render
  conditionals with ternaries, not `&&`. Hoist static objects/JSX out of
  components.
- **Skins (#23, second theme axis).** Signal is the baseline; other skins live
  under `src/skins/<id>/` (tokens.css + skin.css + manifest, selector prefixes
  `:root[data-skin='<id>']` and `[data-skin='<id>']` only). Components must use
  contract token names and `StateSignal` for status dots (truth in
  `data-state`), fonts go through the `--app-font-*` hooks, and layout hooks
  are `data-region` / `data-nav-group` / `data-surface` annotations — skins
  restyle, never restructure. Run `scripts/ui-snap.mjs` before merging
  skin-visible changes. Full contract: `design-skin-system.md` (wiki).

## Web UI i18n (en / zh-CN)

The web UI is fully internationalized with a **zero-dependency, compile-time-checked**
system in `apps/web/src/i18n/`. Rules for daily work:

- **Never hardcode user-visible strings in pages.** Add them to a namespace file
  under `src/i18n/strings/<page>.ts`, which holds the English `en` object and the
  Chinese `zh` object SIDE BY SIDE, with `const zh: typeof en = { ... }` — the
  annotation makes a missing/mismatched key a compile error. The aggregator
  (`strings/index.ts`) zips them into the two runtime dictionaries and derives
  the `TranslationKey` dot-path union that `t()` is typed against, so a typo'd
  key also fails `tsc`.
- **Usage:** `const { t, lang } = useI18n();` (from `@/i18n`) in every component
  that renders text — including module-scope sub-components. `t('ns.key',
{ name })` interpolates `{name}` placeholders. Never call `t()` at module
  scope; module-scope tables may hold `TranslationKey`s resolved at render.
- **Dates** must pass `dateLocale(lang)` instead of `undefined` to
  `toLocaleDateString`/`toLocaleString`.
- **Language choice** persists in `localStorage` (`hnx.lang`), first visit
  follows `navigator.language`, `<html lang>` is kept in sync; the header
  toggle is `components/language-toggle.tsx`.
- **What stays English in both locales:** wire/protocol values rendered from
  data in mono badges (transport types, status enums, hook events, resource
  kinds, AgentTarget values), `${cred:...}` placeholders, code/`<pre>` contents,
  product names (Harness Nexus, Claude Code, MCP). Scope/role values are
  data-mapped via `common.scopeGlobal/scopePersonal/roleAdmin/roleUser`.
- **Terminology** (keep consistent): profile→配置集, credential→凭据, access
  token→访问令牌, machine→机器, daemon→守护进程, deploy→部署, job→作业, agent
  instance→代理实例, inventory→清单, dial site→拨号端 (server-/client-dialed→服务端/
  客户端拨号), scope→作用域, skill→技能, hub→技能中心, marketplace→市场. Chinese
  copy uses full-width punctuation and a half-width space between CJK and
  Latin/numbers.
- `index.css` `--font-sans`/`--font-mono` carry the CJK fallback chain (IBM Plex
  has no CJK glyphs) — don't remove it.

## Feature development workflow (issue-driven)

Development is organized around GitHub issues + milestones (the full contract
is root `CONTRIBUTING.md`). When building a new feature pillar (one spanning
multiple packages and introducing new domain concepts), follow this loop:

1. **Issue first, design in the open.** Open (or claim) the issue. If the
   design needs weighing — data model, API surface, scope/permission rules,
   explicit out-of-scope items — run the discussion on the issue (use the
   _Design discussion_ template for the open questions + options). Once
   agreed, write the durable version on the **wiki** in the
   `../harness-nexus.wiki` clone: `design-<topic>.md` for the design,
   `research-<topic>.md` for option comparisons / adapter ground truth /
   rig findings, linking back to the issue. No phase numbering for new work —
   the issue number is the anchor.
2. **Then implement** on `feat/<issue>-<topic>`. Work inward from the
   dependency boundary: `core` (domain types + ports) → `shared` (zod
   schemas) → `server` (storage + routes) → `sdk-ts` (client methods) →
   `apps/web` (UI). Build each package before moving to the one that depends
   on it (composite project references need `dist`).
3. **Then verify.** `pnpm -r typecheck`, the relevant `pnpm --filter … build`,
   and extend `scripts/smoke.mjs` for the new endpoints.
4. **Update the wiki doc and refresh the feature's row in the index below**
   (one line: area → doc → the one thing to remember — never a new section
   here; sections are what bloated this file past its context-injection
   limit) and close the issue via the merge commit (`(#N)`); make sure the
   issue sits in the right release milestone.

## Feature index — the wiki is the durable home

Every feature's full design (data model, wire, rig findings, post-ship
notes) lives on the wiki — keep a clone at `../harness-nexus.wiki`
(`https://github.com/sinrimin/harness-nexus.wiki.git`), indexed by
`doc-map.md`. **Read the linked doc before touching an area**; the row's
one-liner is the reminder, not the substitute. `docs/architecture.md` (repo)
covers layering; `docs/adr/` the stack decisions.

| Area                                   | Durable doc (wiki)                                  | The one thing to remember                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth & roles                           | `design-phase-1-auth.md`                            | Two roles; JWT + PAT channels; the `onRequest` hook lives on the ROOT instance; not-found hides as 404                                                                                                                                                                                                                                                                                                                      |
| MCP credentials                        | `design-phase-2.1-credentials.md`                   | Credential ≠ PAT (outbound secret); `${cred:NAME}` placeholder injection; AES-GCM at rest, never returned                                                                                                                                                                                                                                                                                                                   |
| MCP registry / proxy / profiles        | `design-phase-2.2-registry.md`                      | Pool = server-dialed rows only; tools namespaced `srv__tool`; `/mcp?profile=` visibility-gated; unresolvable rows skipped, `409 not_dialable`                                                                                                                                                                                                                                                                               |
| Proxy connect & tool inspection        | `design-phase-2.4-connect-tools.md`                 | 4 registry methods + routes; `RegistryError` → HTTP mapping stays in the route (rule #4); connect is best-effort                                                                                                                                                                                                                                                                                                            |
| Profile install pipeline               | `design-phase-3-install.md`                         | Adapters plan/apply + install-state ledger; `hnx install` / `hnx uninstall` restores snapshots                                                                                                                                                                                                                                                                                                                              |
| Marketplace emitter (CC)               | `design-phase-3.5-marketplace-emitter.md`           | Emit-token-in-path (marketplace-scope PAT, REST-rejected); one marketplace per user; `PUBLIC_BASE_URL` must be public https in prod                                                                                                                                                                                                                                                                                         |
| Resources & editors                    | `design-phase-4-web-ui.md`                          | Kind gated by the ROUTE allowlist (`AVAILABLE_KINDS`); `kind`/`scope` immutable; `key` unique per (key, scope, owner)                                                                                                                                                                                                                                                                                                       |
| Skill plugin source                    | `design-phase-7.1-plugin-source.md`                 | `plugin` variant + trust tiers riding `labels`; `git`/`tarball`/`local` rejected for skills                                                                                                                                                                                                                                                                                                                                 |
| Marketplace fetch                      | `design-phase-7.2-marketplace-fetch.md`             | Outbound HTTP surface #1 — no other module may fetch; allowlist + TTL cache + in-flight dedup                                                                                                                                                                                                                                                                                                                               |
| Skill hub UI                           | `design-phase-7.3-hub-ui.md`                        | Trust badges stay neutral (Signal); community-without-pin warns                                                                                                                                                                                                                                                                                                                                                             |
| Multi-source skill search              | `design-phase-7.4-multi-source.md`                  | Parallel adapters, per-source timeout; dedupe by `identifier`; partial results, never throws                                                                                                                                                                                                                                                                                                                                |
| Machines & daemon (8 C1)               | `design-phase-8-c1.md`                              | Machine PATs are realtime-only (REST-rejected); enroll token returned once; delete revokes + drops sockets                                                                                                                                                                                                                                                                                                                  |
| Dial site & stdio shim (8 C2)          | `design-phase-8-c2.md`                              | `dialSite` derived from credential distributability; `/api/client/mcp-config` = machine-PAT REST exception #1                                                                                                                                                                                                                                                                                                               |
| Inventory / import (8 C3)              | `design-phase-8-c3.md`                              | Values redacted daemon-side before upload; re-import of identical bodies = full reuse                                                                                                                                                                                                                                                                                                                                       |
| Deploy jobs (8 C4)                     | `design-phase-8-c4.md`                              | Queued→dispatched→running→terminal; disconnect requeues with attempt cap; deploy-bundle = machine-PAT exception #2                                                                                                                                                                                                                                                                                                          |
| ACP chat (8 C5)                        | `design-phase-8-c5.md`                              | Chat is owner-ONLY; two budgets per machine; open joins the room AT OPEN; W7 replaced the AcSession store                                                                                                                                                                                                                                                                                                                   |
| dsh target (8 T1)                      | `design-phase-8-t1-deepseek.md`                     | dsh's update dialect differs (flat fields, `content`, occupancy) — extend `mapAcpUpdate`, never replace                                                                                                                                                                                                                                                                                                                     |
| Runtime probe & detected agents (9 W1) | `design-phase-9-harness-runtime.md`                 | `AgentInstance.source` deploy\|detected; detected sync has two-report hysteresis; every report carries `runtimes[]`                                                                                                                                                                                                                                                                                                         |
| Harness jobs (9 W2)                    | same, §4.2/§9                                       | npm-only channel; native `claude update` for upgrades; tests use a fake npm shim, never the network                                                                                                                                                                                                                                                                                                                         |
| RuntimeConfig push (9 W3)              | same, §4.3/§9                                       | The spec never carries the secret — daemon fetches at execution (machine-PAT exception #3); writers 0600, merge-preserving                                                                                                                                                                                                                                                                                                  |
| Redacted config viewer (9 W4)          | same, §5/§6                                         | Live round-trip, never cached; masking is daemon-side BEFORE upload; `.env` wholesale                                                                                                                                                                                                                                                                                                                                       |
| Portal modals & chat (9 W5+W6)         | `design-phase-9-portal-ui.md`                       | Every create/edit opens the shared `FormDialog`; chat = Agent cards → session page; new sessions pick a directory under `baseWorkspace`                                                                                                                                                                                                                                                                                     |
| Native sessions (9 W7/W7.1)            | `design-phase-9-w7-native-sessions.md` (+ `-w7.1-`) | Platform persists NOTHING session-shaped; resume follows the advertised capability; dsh streams via the in-process tap, file tail is fallback                                                                                                                                                                                                                                                                               |
| Composer (9 W8)                        | `design-phase-9-w8-sender.md`                       | `<Composer>` is presentational; send control is `bg-primary`, never `--signal`                                                                                                                                                                                                                                                                                                                                              |
| Sender controls (9 W9)                 | `design-phase-9-w9-sender-controls.md`              | Standard ACP session-config surface; option values are OPAQUE; daemon-side optimistic merge after `chat:config.set`                                                                                                                                                                                                                                                                                                         |
| LLM providers (9 W10)                  | `design-phase-9-w10-llm-providers.md`               | The provider never holds the key (credential by name); query-models = outbound surface #2 (GET-only, capped)                                                                                                                                                                                                                                                                                                                |
| Adapter lifecycle (9 W11)              | `design-phase-9-w11-adapter-lifecycle.md`           | Pid ledger + boot sweep; NO open path closes other channels; liveness USER-scoped; rail rides a 15s listing cache                                                                                                                                                                                                                                                                                                           |
| opencode target (9 W12)                | `design-phase-9-w12-opencode.md`                    | Full runtime surface, zero new concepts; api flavors anthropic\|openai-chat only; baseURL `/v1`-normalized; key file RAW, no newline                                                                                                                                                                                                                                                                                        |
| Multi-model picker (9 W13)             | `design-phase-9-w13-multi-model.md`                 | Dropdown = configured set only; codex row BUILT (never intersected), opencode/pi intersected, dsh tuple-intersected                                                                                                                                                                                                                                                                                                         |
| Plan/todo panel (9 W14)                | `design-phase-9-w14-plan-todo.md`                   | ACP `plan` is a full-replace snapshot; claude needs `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` in the adapter env                                                                                                                                                                                                                                                                                                                    |
| Ask User / elicitation (9 W14.1)       | `design-phase-9-w14.1-claude-elicitation.md`        | Top-level `elicitation/create`; only claude bridges today; empty field list is valid; server + cli deploy together                                                                                                                                                                                                                                                                                                          |
| Slash commands (9 W15)                 | `design-phase-9-w15-commands.md`                    | Catalog = `available_commands_update`; invocation is an ordinary prompt; the server relay must carry new stream kinds                                                                                                                                                                                                                                                                                                       |
| pi target (9 W16)                      | `design-phase-9-w16-pi-agent.md`                    | Self-developed `PiRpcConnection` (no ACP); payload under `data`; `switch_session` takes the session FILE path; Node ≥22.19                                                                                                                                                                                                                                                                                                  |
| Fast session pipeline (#2)             | `design-fast-session-pipeline.md`                   | Pinned wrapper provisioning (npx fallback, `HN_ACP_NO_AUTO_PROVISION`); dist patch set; rail reuses `liveConnectionFor`                                                                                                                                                                                                                                                                                                     |
| Adapter pre-warm pool (#3–#4)          | `design-adapter-prewarm.md`                         | Machine-scoped `chatPrewarm` map, strict 4-key replace (legacy 3-key → 400; web normalizes); pool holds ONE initialized adapter per target; TTL 120s; opencode default OFF                                                                                                                                                                                                                                                  |
| claude-code marketplace deploy (#6)    | `design-cc-marketplace-deploy.md`                   | claude-code deploys ride the emitter: daemon drives CC's plugin CLI headless (`-y`), state read from CC's JSON files; emitter accepts machine-ctl PATs; web Edit dialog = name/desc + entry re-pick (version auto-numbered since #18: bumps on entry changes only — the bump is the publish switch); no AgentInstance                                                                                                       |
| Live sender (#10)                      | `design-live-sender.md`                             | Queue is SERVER-owned (depth-1 slot on the live session, `queue_state` event, flush on busy→idle, turn-cancel drops); config selects stay writable mid-turn (next-turn effect); #11: `user_message` echo broadcasts the prompt to every viewer + busy sessions re-assert status after history replay                                                                                                                        |
| Skin system (#23)                      | `design-skin-system.md`                             | Two axes: next-themes mode + `data-skin` (pre-paint, `hnx.skin`); skins = tokens + scoped css + manifest under `src/skins/` (Signal is the zero-package baseline, BAY shipped); status truth is `data-state` — `Lamp` is the device and `StateSignal` the inline mark, both rendering one `lamp-body` slot (D-13); extra regions ride base `Region` slots (empty = no footprint); the two hard skin rules are test-enforced |

## Authentication & authorization (permission interceptors)

Full design in `design-phase-1-auth.md` — read it before touching auth. Summary for daily work:

- **Two roles only:** `admin` and `user`. Each user has exactly one role
  (`User.role`, not an array). Branch all access decisions on this field.
- **Two credential channels**, both via `Authorization: Bearer <credential>`:
  - **JWT access token** (primary, for the web UI) — signed with `JWT_SECRET`,
    verified statelessly by `jose`. Lifetime `JWT_ACCESS_TTL` (default `7d`).
  - **PAT** — `hnpat_<base64url(32)>`, stored as sha256. For CLI/automation.
- **Backend interceptors** (`packages/server/src/plugins/auth.ts`):
  - `onRequest` (registered on the **root** instance, not inside a child plugin
    context — Fastify hooks added in `app.register()` only apply to that scope)
    resolves either channel into `req.user = { id, role } | null`.
  - `app.requireAuth` / `app.requireAdmin` are **per-route preHandlers**:
    `{ preHandler: [app.requireAdmin] }`. 401 when anonymous, 403 when non-admin.
- **Frontend interceptors** (`apps/web/src/guards.tsx`):
  - `<RequireAuth>` redirects to `/login` when unauthenticated.
  - `<RequireAdmin>` renders a 403 view for non-admins.
  - The SDK wrapper logs out on any 401 response (`withAuthGuard` in `auth.tsx`).
- **Registration switch:** `SystemSettings.allowRegistration` (default open) gates
  `POST /api/auth/register`. `POST /api/users` (admin) bypasses it. The first user
  to register becomes the bootstrap admin. Admin toggles via
  `PUT /api/settings/registration`.
- **Safety rails:** last-admin protection (no deleting/demoting the final admin,
  409 `LAST_ADMIN`) and no self-delete (409 `NO_SELF_DELETE`). Disabled users'
  tokens are rejected by a fresh user lookup on each protected request.
- **Global vs personal scoping** (future): resources/profiles/MCP servers carry
  `scope: 'global' | 'personal'` and `ownerId`. The role check above is the
  _instance-level_ gate; per-resource ownership checks layer on top when those
  modules land.

## Required environment

`JWT_SECRET` is **required** (≥16 chars) — the server refuses to boot without it.
For local dev: `JWT_SECRET="$(openssl rand -base64 48)"`. For an ephemeral run
without SQLite, also set `STORAGE_DRIVER=memory`.

## Current status

Shipped: Phases 1–4 + 7 (auth, credentials, MCP registry/proxy/profiles,
profile install pipeline, CC marketplace emitter, resources + web UI, skill
hub + multi-source search); Phase 8 C1–C5 + T1 (machines/daemon, dial site +
stdio shim, inventory/import, deploy jobs, ACP chat, the dsh target); the
Phase 9 runtime-lifecycle waves W1–W16 (runtime inventory + detected agents,
harness jobs, provider config push, config viewer, portal chat UI, native
sessions W7/W7.1, composer W8–W9, LLM providers W10, adapter lifecycle W11,
opencode W12, multi-model W13, plan/todo W14, elicitation W14.1, commands
W15, pi W16); and the issue-era fast session pipeline (#2) + adapter
pre-warm pool (#3–#4). Release state: the five `@harness-nexus/*` packages
are on npm (pre-1.0 alphas ARE `latest` by design, so `npx` works), with CI,
OIDC trusted publishing, and tag-driven Docker images — see "Releasing to
npm & Docker Hub" above.

Open / not built: C6 (orchestration) is the only scoped follow-up; Phase 2.3
(callable-function scripts) is on hold; hermes runtime management and
hermes native sessions were cancelled with the user (2026-09-17); the
ECC/Superpower import adapters and the local-write CC fallback adapter
remain; `zcode` sits in the `AgentTarget` enum with no install adapter (no
reproducible reference). The live tracker is GitHub issues + milestones; the
wiki's `roadmap.md` is the historical phase record.

When you add real logic for a pillar: add tests, update the feature's wiki
doc, and refresh its row in the index above — never a new section here.
Vitest is wired in `@harness-nexus/{shared,server,cli}` (`test/` dirs,
excluded from build tsconfigs; `pnpm --filter … run test`); throwaway E2E
scripts live in `scripts/smoke*.mjs` / `scripts/test-*.mjs`.
