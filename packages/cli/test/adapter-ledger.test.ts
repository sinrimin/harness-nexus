import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  adapterLedgerDir,
  auditAdapterLedger,
  groupSignalTarget,
  groupSignalTargetFor,
  readAdapterLedger,
  sweepAdapterLedger,
  writeAdapterLedgerEntry,
  type AdapterLedgerEntry,
} from '../src/daemon/adapter-ledger.js';

/**
 * Adapter ledger tests (Phase 9 W11 A). The sweep/audit run against REAL
 * detached process groups — the exact shape the daemon spawns — so "reaped"
 * and "dropped" mean what they say, not what a mock was told to answer.
 */

function waitFor<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      const v = fn();
      if (v !== undefined) return resolve(v);
      if (Date.now() - started > ms) return reject(new Error('waitFor: timeout'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

const gone = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

/** A real detached process group (the daemon's spawn shape); returns the pgid. */
function spawnSleeper(): number {
  const proc = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  proc.unref();
  if (proc.pid === undefined) throw new Error('sleeper spawn failed');
  return proc.pid;
}

describe('adapter ledger (9 W11 A)', () => {
  let home = '';
  const live: number[] = [];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'hnx-ledger-'));
  });
  afterEach(() => {
    for (const pgid of live.splice(0)) {
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    rmSync(home, { recursive: true, force: true });
  });

  const entry = (pgid: number): AdapterLedgerEntry => ({
    pgid,
    target: 'codex',
    command: 'npx',
    wireSessionId: 'sess-ledger-1',
    startedAt: Date.now(),
  });

  it('writes one JSON file per adapter and reads it back', () => {
    writeAdapterLedgerEntry(home, entry(1234));
    const read = readAdapterLedger(home);
    expect(read).toHaveLength(1);
    expect(read[0]).toMatchObject({ pgid: 1234, target: 'codex', command: 'npx' });
    expect(read[0]!.wireSessionId).toBe('sess-ledger-1');
    expect(existsSync(join(adapterLedgerDir(home), 'sess-ledger-1.json'))).toBe(true);
    // The native session id is optional (unknown until establishment lands).
    expect(read[0]!.nativeSessionId).toBeUndefined();
  });

  it('rejects unsafe wire session ids (no path traversal into the ledger dir)', () => {
    expect(() =>
      writeAdapterLedgerEntry(home, { ...entry(1), wireSessionId: '../../etc/passwd' }),
    ).toThrow();
    expect(() => writeAdapterLedgerEntry(home, { ...entry(1), wireSessionId: 'a/b' })).toThrow();
    expect(readAdapterLedger(home)).toHaveLength(0);
  });

  it('boot sweep reaps a live group recorded in the ledger (the D1 orphan)', async () => {
    const pgid = spawnSleeper();
    live.push(pgid);
    writeAdapterLedgerEntry(home, entry(pgid));
    expect(gone(pgid)).toBe(false);

    const result = sweepAdapterLedger(home);
    expect(result).toEqual({ reaped: 1, dropped: 0 });
    // The file is deleted AND the process group actually died.
    expect(existsSync(join(adapterLedgerDir(home), 'sess-ledger-1.json'))).toBe(false);
    await waitFor(() => (gone(pgid) ? true : undefined));
  });

  it('sweep drops a DEAD group entry without counting it as reaped', async () => {
    const dead = spawn(process.execPath, ['--eval', 'process.exit(0)'], {
      detached: true,
      stdio: 'ignore',
    });
    dead.unref();
    if (dead.pid === undefined) throw new Error('spawn failed');
    await waitFor(() => (gone(dead.pid) ? true : undefined));

    writeAdapterLedgerEntry(home, entry(dead.pid));
    const result = sweepAdapterLedger(home);
    expect(result).toEqual({ reaped: 0, dropped: 1 });
    expect(readAdapterLedger(home)).toHaveLength(0);
  });

  it('audit keeps live entries and drops them once the group is gone', async () => {
    const pgid = spawnSleeper();
    live.push(pgid);
    writeAdapterLedgerEntry(home, entry(pgid));

    expect(auditAdapterLedger(home)).toBe(0);
    expect(readAdapterLedger(home)).toHaveLength(1);

    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // already gone
    }
    await waitFor(() => (gone(pgid) ? true : undefined));
    expect(auditAdapterLedger(home)).toBe(1);
    expect(readAdapterLedger(home)).toHaveLength(0);
  });

  it('#42 — the signal target is the GROUP on POSIX but the bare LEADER on win32', () => {
    // Windows has no process groups: kill(-pid, …) just throws, which made
    // every liveness probe report dead and the audit reap live sessions.
    expect(groupSignalTargetFor('linux', 4242)).toBe(-4242);
    expect(groupSignalTargetFor('darwin', 4242)).toBe(-4242);
    expect(groupSignalTargetFor('win32', 4242)).toBe(4242);
    // On THIS platform the exported helper follows the platform branch.
    expect(groupSignalTarget(4242)).toBe(process.platform === 'win32' ? 4242 : -4242);
  });

  it('sweep and audit remove junk (torn writes, stranded .tmp) so the dir cannot accumulate', () => {
    const dir = adapterLedgerDir(home);
    rmSync(dir, { recursive: true, force: true });
    writeAdapterLedgerEntry(home, entry(unusedPgid()));
    writeFileSync(join(dir, 'junk.json'), '{not json', 'utf8');
    writeFileSync(join(dir, 'valid-but-wrong-shape.json'), '{"pgid": "x"}', 'utf8');
    writeFileSync(join(dir, 'sess-stranded.json.tmp'), '{}', 'utf8');

    expect(readAdapterLedger(home)).toHaveLength(1); // junk is skipped, not read
    const result = sweepAdapterLedger(home);
    expect(result).toEqual({ reaped: 0, dropped: 1 }); // the unused-pgid entry
    expect(existsSync(dir)).toBe(true);
    for (const f of ['junk.json', 'valid-but-wrong-shape.json', 'sess-stranded.json.tmp']) {
      expect(existsSync(join(dir, f))).toBe(false);
    }
  });

  it('audit alone also removes junk and .tmp files', () => {
    const dir = adapterLedgerDir(home);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'junk.json'), 'garbage', 'utf8');
    writeFileSync(join(dir, 'x.json.tmp'), 'garbage', 'utf8');
    expect(auditAdapterLedger(home)).toBe(2);
    expect(existsSync(join(dir, 'junk.json'))).toBe(false);
    expect(existsSync(join(dir, 'x.json.tmp'))).toBe(false);
  });
});

/** A pgid no Linux kernel will ever allocate — for housekeeping-only cases. */
function unusedPgid(): number {
  return 2_000_000_000;
}
