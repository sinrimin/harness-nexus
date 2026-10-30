// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

/**
 * #92 v2 — the no-model cheap tier (design-delegated-approvals-v2.md layer 2).
 * A metadata-only allowlist that auto-allows cards whose ANSWER cannot depend
 * on file CONTENTS: pure position/lookup commands and read-kind tools whose
 * paths sit inside the working area. Everything the matcher is unsure about
 * falls through to the decision model — the return value is `false`, never a
 * denial. Claude Code routes ~1 of 6 Bash calls to its judge for the same
 * reason; the cheap tier is worth having, it just has to be metadata-only.
 *
 * Deliberately NOT here (review findings, kept as tests): content readers
 * (`cat`/`head`/`tail`/`grep`/`rg`/`wc`/`stat`/`file`) — read-only ≠ safe when
 * secrets are the contents; `find` — `-exec` runs arbitrary commands with no
 * shell metacharacter at all. Both always see the model, where severity 6
 * grades credential-shaped reads regardless of how innocuous the verb looks.
 */

/** Credential-shaped name fragments, matched as lower-case substrings. */
const SENSITIVE_FRAGMENTS: readonly string[] = [
  '.ssh',
  '.env',
  '.aws',
  '.pem',
  '.netrc',
  '.npmrc',
  '.git-credentials',
  '/etc/shadow',
  '.hnx',
  'id_rsa',
  'id_ed25519',
  '.gnupg',
  '.kube',
  '.docker',
  'gcloud',
  'credentials.json',
  'service-account',
];

function hasSensitiveFragment(s: string): boolean {
  const lower = s.toLowerCase();
  return SENSITIVE_FRAGMENTS.some((f) => lower.includes(f));
}

/**
 * Bash metacharacters that smuggle a second command or leak environment
 * (`;`, pipes, redirects, backticks, `$(…)`, escaping, newlines). Their
 * presence demotes the command to the model — an over-match is always safe.
 */
const BASH_REJECT_CHARS: readonly string[] = [';', '|', '&', '>', '<', '`', '$', '\\', '\n', '\r'];

/** Lexically resolve a path against `root`; null when unresolvable (tilde). */
function resolveInside(p: string, root: string): string | null {
  if (p.startsWith('~')) return null; // home-relative — unresolvable here ⇒ model
  const absolute = p.startsWith('/') ? p : `${root}/${p}`;
  const out: string[] = [];
  for (const part of absolute.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

/** Inside the working area (the channel's cwd), with `..` resolved lexically. */
function pathInsideWorkspace(p: string, root: string | undefined): boolean {
  if (root === undefined || root === '') return false;
  const rootR = resolveInside(root, '/');
  const abs = resolveInside(p, rootR ?? '/');
  if (rootR === null || abs === null) return false;
  return abs === rootR || abs.startsWith(`${rootR}/`);
}

/** The verb-pinned Bash allowlist. Single command, bounded, metadata only. */
function bashMetadataAllows(command: string, workspaceRoot: string | undefined): boolean {
  const cmd = command.trim();
  if (cmd === '' || cmd.length > 200) return false;
  if (BASH_REJECT_CHARS.some((c) => cmd.includes(c))) return false;
  if (hasSensitiveFragment(cmd)) return false;
  const tokens = cmd.split(/\s+/);
  const verb = tokens[0];
  if (verb === 'pwd') return tokens.length === 1;
  if (verb === 'echo' || verb === 'which') return true; // `$` already rejected above
  if (verb === 'ls') {
    // `ls` (no args) lists the cwd — inside ONLY when we know the root;
    // without one there is no "inside" to check, so the model decides.
    if (workspaceRoot === undefined || workspaceRoot === '') return false;
    return tokens
      .slice(1)
      .filter((t) => !t.startsWith('-'))
      .every((p) => pathInsideWorkspace(p, workspaceRoot));
  }
  if (verb === 'git') {
    return tokens[1] === 'status' || tokens[1] === 'diff' || tokens[1] === 'log';
  }
  return false;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * May this card be auto-allowed without the model? Kinds follow the ACP
 * `ToolCallKind` enum: `execute` is the Bash-class card; read-kind tools are
 * `read` (Read) and `search` (Grep/Glob). Writes, fetches, deletes and every
 * unrecognized shape always see the model.
 */
export function prefilterAllows(call: {
  kind?: string | undefined;
  title: string;
  /** Parsed tool arguments (the card's `rawInput`/`args`). */
  raw?: unknown;
  /** The session's working directory — the "inside the working area" root. */
  workspaceRoot?: string | undefined;
}): boolean {
  const raw = isRecord(call.raw) ? call.raw : undefined;

  if (call.kind === 'execute' || call.title.startsWith('Bash(')) {
    const command = typeof raw?.command === 'string' ? raw.command : undefined;
    if (command === undefined) return false; // nothing parseable ⇒ model
    return bashMetadataAllows(command, call.workspaceRoot);
  }

  if (call.kind === 'read' || call.kind === 'search') {
    // A card-carrying read-kind call is by nature reading OUTSIDE the working
    // area (in-workspace reads never card) — but the card can also fire under
    // a strict mode, so re-check the actual paths instead of the card's origin.
    const paths: string[] = [];
    if (typeof raw?.file_path === 'string') paths.push(raw.file_path);
    if (typeof raw?.path === 'string') paths.push(raw.path);
    if (paths.length === 0) {
      // Grep/Glob default their search root to the cwd — inside by
      // construction (a card with neither path field is not path-shaped).
      return call.kind === 'search';
    }
    return (
      paths.every((p) => pathInsideWorkspace(p, call.workspaceRoot)) &&
      !paths.some((p) => hasSensitiveFragment(p))
    );
  }

  return false;
}
