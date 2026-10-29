// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * #92 v2 — the metadata pre-filter: the no-model cheap tier. Two tables:
 * what it allows (verb-pinned Bash metadata commands, in-workspace
 * read-kind tools) and the holes the design reviews carved out of earlier
 * drafts (content readers, find -exec, secret reads, metacharacter
 * smuggling). A `false` is always "fall through to the model", never a
 * denial — that invariant is what makes over-matching safe.
 */
import { describe, expect, it } from 'vitest';
import { prefilterAllows } from '../src/realtime/approvals-prefilter.js';

const W = '/w';

describe('approvals pre-filter (#92 v2) — Bash metadata commands', () => {
  it.each(['pwd', 'echo hello', 'echo -n done', 'which node'])(
    'allows the position/lookup verb: %s',
    (command) => {
      expect(
        prefilterAllows({
          kind: 'execute',
          title: `Bash(${command})`,
          raw: { command },
          workspaceRoot: W,
        }),
      ).toBe(true);
    },
  );

  it('allows ls with paths inside the working area (flags skipped)', () => {
    for (const command of ['ls', 'ls -la', 'ls src', 'ls src test', 'ls ./x', 'ls /w/a /w/b']) {
      expect(
        prefilterAllows({
          kind: 'execute',
          title: `Bash(${command})`,
          raw: { command },
          workspaceRoot: W,
        }),
      ).toBe(true);
    }
  });

  it.each(['git status', 'git diff', 'git log', 'git log --oneline -5', 'git diff --stat'])(
    'allows the verb-pinned git reads: %s',
    (command) => {
      expect(
        prefilterAllows({
          kind: 'execute',
          title: `Bash(${command})`,
          raw: { command },
          workspaceRoot: W,
        }),
      ).toBe(true);
    },
  );

  it('falls back to the Bash( title when the kind is missing', () => {
    expect(
      prefilterAllows({
        title: 'Bash(git status)',
        raw: { command: 'git status' },
        workspaceRoot: W,
      }),
    ).toBe(true);
  });

  it.each([
    'cat README.md', // content reader — always the model's
    'cat ~/.ssh/id_rsa',
    'head -5 .env',
    'grep -r password .',
    'find . -name x',
    'find . -exec rm {} ;', // -exec runs commands with no metacharacter
    'stat secrets.json',
    'wc -l /w/big.log',
    'node -e "1"', // not an allowlisted verb
    'git push', // not a read verb
    'git add .',
  ])('falls through on: %s', (command) => {
    expect(
      prefilterAllows({
        kind: 'execute',
        title: `Bash(${command})`,
        raw: { command },
        workspaceRoot: W,
      }),
    ).toBe(false);
  });

  it.each([
    'pwd; rm -rf /',
    'ls && cat /etc/passwd',
    'echo hi > /w/x',
    'which node | sh',
    'echo $(whoami)', // $(…) — $ is rejected outright
    'echo `whoami`',
    'echo a\\;rm',
  ])('rejects metacharacter smuggling: %s', (command) => {
    expect(
      prefilterAllows({
        kind: 'execute',
        title: `Bash(${command})`,
        raw: { command },
        workspaceRoot: W,
      }),
    ).toBe(false);
  });

  it.each(['sudo pwd', 'sudo ls', 'env ls', 'doas git status'])(
    'rejects privilege/env prefixes: %s',
    (command) => {
      expect(
        prefilterAllows({
          kind: 'execute',
          title: `Bash(${command})`,
          raw: { command },
          workspaceRoot: W,
        }),
      ).toBe(false);
    },
  );

  it.each(['ls /etc', 'ls ..', 'ls ../outside', 'ls ~/docs', 'ls /w/../etc'])(
    'rejects paths outside the working area: %s',
    (command) => {
      expect(
        prefilterAllows({
          kind: 'execute',
          title: `Bash(${command})`,
          raw: { command },
          workspaceRoot: W,
        }),
      ).toBe(false);
    },
  );

  it('ls without a workspace root never allows (no "inside" to check)', () => {
    expect(prefilterAllows({ kind: 'execute', title: 'Bash(ls)', raw: { command: 'ls' } })).toBe(
      false,
    );
  });

  it.each(['ls .ssh', 'which id_rsa', 'git log -- .env', 'echo .npmrc'])(
    'rejects sensitive-name fragments anywhere in the command: %s',
    (command) => {
      expect(
        prefilterAllows({
          kind: 'execute',
          title: `Bash(${command})`,
          raw: { command },
          workspaceRoot: W,
        }),
      ).toBe(false);
    },
  );

  it('rejects overlong commands and missing command fields', () => {
    expect(
      prefilterAllows({
        kind: 'execute',
        title: 'Bash(pwd)',
        raw: { command: `echo ${'x'.repeat(300)}` },
        workspaceRoot: W,
      }),
    ).toBe(false);
    expect(prefilterAllows({ kind: 'execute', title: 'Bash()', raw: {}, workspaceRoot: W })).toBe(
      false,
    );
  });
});

describe('approvals pre-filter (#92 v2) — read-kind tools', () => {
  it('allows an in-workspace Read', () => {
    expect(
      prefilterAllows({
        kind: 'read',
        title: 'Read',
        raw: { file_path: '/w/src/a.ts' },
        workspaceRoot: W,
      }),
    ).toBe(true);
  });

  it('allows Grep/Glob with the default cwd root (no path field)', () => {
    expect(prefilterAllows({ kind: 'search', title: 'Grep', raw: { pattern: 'todo' } })).toBe(true);
    expect(
      prefilterAllows({
        kind: 'search',
        title: 'Glob',
        raw: { pattern: '**/*.ts' },
        workspaceRoot: W,
      }),
    ).toBe(true);
  });

  it('allows a Grep scoped inside the working area', () => {
    expect(
      prefilterAllows({
        kind: 'search',
        title: 'Grep',
        raw: { pattern: 'TODO', path: '/w/src' },
        workspaceRoot: W,
      }),
    ).toBe(true);
  });

  it.each([
    { kind: 'read', title: 'Read', raw: { file_path: '/etc/hosts' } }, // outside
    { kind: 'read', title: 'Read', raw: { file_path: '/w/../.ssh/id_rsa' } }, // escapes + sensitive
    { kind: 'read', title: 'Read', raw: { file_path: '/w/notes/.env.local' } }, // sensitive INSIDE
    { kind: 'search', title: 'Grep', raw: { pattern: 'x', path: '/etc' } }, // outside
  ])('falls through on: %s', (call) => {
    expect(prefilterAllows({ ...call, workspaceRoot: W })).toBe(false);
  });

  it('a Read with no file_path falls through (not path-shaped)', () => {
    expect(prefilterAllows({ kind: 'read', title: 'Read', raw: {}, workspaceRoot: W })).toBe(false);
  });
});

describe('approvals pre-filter (#92 v2) — everything else sees the model', () => {
  it.each([
    { kind: 'edit', title: 'Edit', raw: { file_path: '/w/a.ts' } },
    { kind: 'delete', title: 'Delete', raw: { path: '/w/a.ts' } },
    { kind: 'fetch', title: 'WebFetch', raw: { url: 'https://x.example' } },
    { kind: 'other', title: 'mcp__srv__tool', raw: { q: 'x' } },
    { kind: undefined, title: 'Run job', raw: { target: 'grid.purge' } },
  ])('never pre-filters: %s', (call) => {
    expect(prefilterAllows({ ...call, workspaceRoot: W })).toBe(false);
  });
});
