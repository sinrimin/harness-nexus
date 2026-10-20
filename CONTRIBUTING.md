# Contributing to Harness Nexus

Thanks for your interest in contributing! This document describes how
development is organized and what a contribution looks like.

## Ways to contribute

- **Report a bug** — open an issue with the _Bug report_ template. Include
  repro steps and versions (server / daemon / agent tool); a reproducible
  report gets fixed much faster.
- **Propose a feature** — open an issue with the _Feature request_ template.
  Lead with the problem you're trying to solve, not the solution.
- **Propose a design change** — open an issue with the _Design discussion_
  template. Larger features are discussed in the issue (and, once picked up,
  detailed in the [wiki](https://github.com/sinrimin/harness-nexus/wiki))
  before implementation.
- **Contribute code** — see the workflow below.

## AI contribution policy

Harness Nexus is itself built with coding agents, so AI-assisted
contributions are welcome — with one rule borrowed from the pi project:

> **You must understand what you submit.** If you cannot explain what your
> changes do and how they interact with the rest of the system, the PR will
> be closed.

If you use a coding agent, run it from the repository root so it picks up
`AGENTS.md` automatically, and make it follow that file — it encodes the
project's layering rules, conventions, and hard-won gotchas. Drive-by
agent-generated PRs that ignore `AGENTS.md` will be closed.

## Development setup

- Node.js ≥ 20 and pnpm
- `pnpm install`
- `task dev:server` (API on :8080; `STORAGE_DRIVER=memory` to skip SQLite)
- `task dev:web` (UI on :5173)

`task` is a convenience wrapper — plain `pnpm --filter @harness-nexus/<pkg>`
commands work too. See `AGENTS.md` for the full command list.

## Issue-driven workflow

Every unit of work is anchored to an issue (`#N`):

1. **Issue first.** Bugs and features live in issues before any code. A
   milestone (`vX.Y.Z`) is opened per release; an issue is assigned to a
   milestone when it's selected for that release — the milestone _is_ the
   feature selection.
2. **Branch per issue**, named `feat/123-short-desc`, `fix/124-short-desc`,
   `docs/…`, `chore/…` (issue number first).
3. **Implement** following `AGENTS.md` (layering rules, coding conventions,
   the web UI "Signal" design system, i18n rules).
4. **Verify before merging**: `pnpm -r typecheck` plus the tests covering the
   touched surfaces; extend `scripts/smoke.mjs` for new endpoints. Changes
   heading for a release must pass `task verify` (the Node 22.19 CI-parity
   gate — the server engine floor; the five published packages keep >=20).
5. **Merge with context**: merges use `git merge --no-ff` with a closing
   reference (`closes #123`) in the commit message, which auto-closes the
   issue. Commit message prefixes: `feat:`, `fix:`, `docs:`, `chore:`.
6. **Release**: tag-driven (`vX.Y.Z` → CI publishes npm + Docker). Release
   notes are assembled from the milestone's closed issues.

## Pull requests

- Keep PRs small and single-purpose; reference the issue (`Fixes #123`).
- Don't reformat code you didn't otherwise touch.
- Every first-party source file (`.ts`, `.tsx`, `.js`, `.mjs`, `.css`, …) carries
  the repo's SPDX header — run `pnpm headers:fix` when you add files; CI rejects
  a missing header.
- New behavior needs tests; new endpoints need a smoke entry.

## Where things are documented

| What                                                               | Where                                                             |
| ------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Working guide for humans **and** agents                            | [`AGENTS.md`](AGENTS.md)                                          |
| Architecture contract (layering, storage, MCP transport)           | [`docs/architecture.md`](docs/architecture.md)                    |
| Architecture decision records                                      | [`docs/adr/`](docs/adr/)                                          |
| Feature guides + all PRD/design/research docs + historical roadmap | the [GitHub wiki](https://github.com/sinrimin/harness-nexus/wiki) |

The wiki is itself a git repository
(`https://github.com/sinrimin/harness-nexus.wiki.git`) — edit it through git,
not the web editor, so history and diffs are reviewable. Keep a clone next to
the repo at `../harness-nexus.wiki`.

## Security

Never post real credentials, tokens, or `.env` contents in issues or PRs.
Secret material belongs in the platform's encrypted credential store; if a
secret leaked into an issue or commit, flag it so it can be rotated.
