import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * Adapter process ledger (Phase 9 W11 A) — the daemon's crash-proof account
 * of every adapter process GROUP it created. One JSON file per live adapter
 * under `~/.hnx/adapters/<wireSessionId>.json`:
 *
 *   { pgid, target, command, wireSessionId, nativeSessionId?, startedAt }
 *
 * Invariants:
 * - The entry is written INSIDE `AcpAgentConnection.start`, right after the
 *   detached spawn and BEFORE initialize — a hard death during establishment
 *   still leaves a sweepable record (Principle: a crash may orphan a
 *   process, never an UNACCOUNTED one).
 * - Kill paths never unlink: files are removed ONLY by the periodic audit
 *   (group gone) or the boot sweep. Removing at teardown would lose
 *   accounting if the daemon hard-dies inside the SIGTERM→SIGKILL grace —
 *   leaving the file lets the next boot's sweep finish the reap instead.
 * - No secrets: the command name only (credentials live in the target's
 *   native config, never in adapter argv/env).
 * - One daemon per (user, home): a second daemon's boot sweep would reap the
 *   first one's live adapters. Concurrent daemons on one home are already
 *   unsupported (shared ~/.hnx/config.json, double job dispatch).
 */

export interface AdapterLedgerEntry {
  /** The process-group id (the detached leader's pid). */
  pgid: number;
  target: string;
  command: string;
  wireSessionId: string;
  nativeSessionId?: string;
  startedAt: number;
}

/** Wire session ids are server-generated base64url-ish tokens. */
const WIRE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Sanity bound — a daemon owns at most CHAT_MAX_SESSIONS_PER_MACHINE of these. */
const MAX_FILES = 256;

export function adapterLedgerDir(home: string): string {
  return join(home, '.hnx', 'adapters');
}

export function writeAdapterLedgerEntry(home: string, entry: AdapterLedgerEntry): void {
  if (!WIRE_ID.test(entry.wireSessionId)) {
    throw new Error('refusing adapter ledger write: unsafe wire session id');
  }
  if (!Number.isInteger(entry.pgid) || entry.pgid <= 0) {
    throw new Error(`refusing adapter ledger write: invalid pgid ${String(entry.pgid)}`);
  }
  const dir = adapterLedgerDir(home);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${entry.wireSessionId}.json`);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(entry)}\n`, 'utf8');
  // Atomic swap — a crash mid-write can never half-replace an entry.
  renameSync(tmp, file);
}

/**
 * Remove one entry file (Issue #3 — a prewarmed adapter adopted by a channel
 * deletes its `prewarm-<target>` pseudo entry so the audit does not keep a
 * file whose group is the live channel's). Runtime kill paths still never
 * unlink — this is a bookkeeping rename, not a reap.
 */
export function deleteAdapterLedgerEntry(home: string, wireSessionId: string): void {
  if (!WIRE_ID.test(wireSessionId)) return;
  try {
    rmSync(join(adapterLedgerDir(home), `${wireSessionId}.json`), { force: true });
  } catch {
    // best-effort — the audit sweeps leftovers
  }
}

/** Parse one ledger file; null = malformed (not an entry we ever wrote). */
function parseEntry(file: string): AdapterLedgerEntry | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (
    typeof parsed['pgid'] === 'number' &&
    Number.isInteger(parsed['pgid']) &&
    parsed['pgid'] > 0 &&
    typeof parsed['target'] === 'string' &&
    typeof parsed['command'] === 'string' &&
    typeof parsed['wireSessionId'] === 'string' &&
    WIRE_ID.test(parsed['wireSessionId']) &&
    typeof parsed['startedAt'] === 'number'
  ) {
    return parsed as unknown as AdapterLedgerEntry;
  }
  return null;
}

/** All valid entries (malformed files are skipped here, not deleted). */
export function readAdapterLedger(home: string): AdapterLedgerEntry[] {
  const dir = adapterLedgerDir(home);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // no ledger dir yet — nothing was ever spawned here
  }
  const out: AdapterLedgerEntry[] = [];
  for (const name of names.slice(0, MAX_FILES)) {
    if (!name.endsWith('.json')) continue;
    const entry = parseEntry(join(dir, name));
    if (entry !== null) out.push(entry);
  }
  return out;
}

/**
 * Whether the process GROUP has at least one LIVE (non-zombie) member.
 * `kill(-pgid, 0)` alone cannot tell: a ZOMBIE stays answerable forever,
 * and on machines whose PID 1 does not reap (a bare docker CMD, nohup under
 * a plain shell) orphaned grandchildren zombify and would pin their ledger
 * entry past every audit. Linux /proc walk; where /proc is absent the
 * kill() answer stands (conservative).
 */
function groupHasLiveMember(pgid: number): boolean {
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return true;
  }
  for (const name of names) {
    if (!/^[0-9]+$/.test(name)) continue;
    let stat: string;
    try {
      stat = readFileSync(`/proc/${name}/stat`, 'utf8');
    } catch {
      continue; // raced an exit — the next call re-reads
    }
    // Fields after `(comm)`: state ppid pgrp … (comm may contain spaces).
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields.length < 3) continue;
    if (Number.parseInt(fields[2]!, 10) === pgid && fields[0] !== 'Z') return true;
  }
  return false;
}

/**
 * The pid to signal for an adapter's "group": negative (the process GROUP)
 * on POSIX; the bare LEADER pid on win32 (#42) — Windows has no process
 * groups and `kill(-pid, …)` simply throws there, which made every liveness
 * probe report dead. Signaling the leader alone can orphan grandchildren on
 * Windows (a Job Object is the proper later hardening); liveness-wise the
 * leader IS the channel — its stdin/stdout is what we talk to.
 */
export function groupSignalTarget(pgid: number): number {
  return groupSignalTargetFor(process.platform, pgid);
}

/** Platform-parameterized for tests (#42). */
export function groupSignalTargetFor(platform: NodeJS.Platform, pgid: number): number {
  return platform === 'win32' ? pgid : -pgid;
}

/**
 * Whether the process GROUP still exists. EPERM (the group exists but is
 * owned by someone else — pid reuse made it foreign) counts as NOT ours:
 * every caller treats a false answer as "drop the file without signaling",
 * so a foreign process is never killed on our word alone.
 */
export function groupIsAlive(pgid: number): boolean {
  try {
    process.kill(groupSignalTarget(pgid), 0);
  } catch {
    return false;
  }
  // The /proc zombie walk is POSIX-only; on win32 the kill(0) answer stands
  // (probe against the leader pid — no zombie pinning applies).
  if (process.platform === 'win32') return true;
  return groupHasLiveMember(pgid);
}

/** SIGTERM the group, then SIGKILL after `graceMs` (unref'd — mirrors conn.kill). */
export function killProcessGroup(pgid: number, graceMs = 3000): void {
  const target = groupSignalTarget(pgid);
  const sig = (s: NodeJS.Signals): void => {
    try {
      process.kill(target, s);
    } catch {
      // group already gone
    }
  };
  const t = setTimeout(() => sig('SIGKILL'), graceMs);
  t.unref();
  sig('SIGTERM');
}

function unlinkQuiet(home: string, wireSessionId: string): void {
  try {
    unlinkSync(join(adapterLedgerDir(home), `${wireSessionId}.json`));
  } catch {
    // already gone
  }
}

/**
 * Housekeeping shared by the sweep and the audit: junk files — a torn write,
 * hand-dropped garbage, or a `.json.tmp` stranded by a hard death between
 * the tmp write and the rename — must not accumulate.
 */
function dropJunkFiles(home: string): number {
  const dir = adapterLedgerDir(home);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names.slice(0, MAX_FILES)) {
    const isTmp = name.endsWith('.json.tmp');
    if (!isTmp && !name.endsWith('.json')) continue;
    if (!isTmp && parseEntry(join(dir, name)) !== null) continue;
    try {
      unlinkSync(join(dir, name));
      removed++;
    } catch {
      // racing writer — the next pass retries
    }
  }
  return removed;
}

/**
 * Boot sweep — run ONCE at daemon start, before anything here can spawn a
 * new adapter: every still-alive pgid in the ledger is a leftover from a
 * previous instance's hard death (SIGKILL/OOM skip every teardown path; the
 * detached groups survive it). Kills live groups, deletes every file.
 * Returns what happened so the caller can log it.
 */
export function sweepAdapterLedger(home: string): { reaped: number; dropped: number } {
  let reaped = 0;
  let dropped = 0;
  for (const entry of readAdapterLedger(home)) {
    if (groupIsAlive(entry.pgid)) {
      killProcessGroup(entry.pgid);
      reaped++;
    } else {
      dropped++;
    }
    unlinkQuiet(home, entry.wireSessionId);
  }
  dropJunkFiles(home);
  return { reaped, dropped };
}

/**
 * Periodic audit — the ONLY runtime remover of ledger files: an entry whose
 * group is gone (the adapter exited, or a teardown's kill completed) is
 * deleted; live entries stay. Returns how many files were dropped.
 */
export function auditAdapterLedger(home: string): number {
  let dropped = 0;
  for (const entry of readAdapterLedger(home)) {
    if (!groupIsAlive(entry.pgid)) {
      unlinkQuiet(home, entry.wireSessionId);
      dropped++;
    }
  }
  return dropped + dropJunkFiles(home);
}
