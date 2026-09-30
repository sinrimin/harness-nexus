import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireDaemonLock, daemonLockPath } from '../src/daemon/lock.js';

/**
 * #39 — the single-daemon lock: a live holder refuses, a dead one is
 * stolen, release removes exactly our own file.
 */

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hnx-lock-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('acquireDaemonLock', () => {
  it('grants, records our pid, and release removes the file', () => {
    const grant = acquireDaemonLock(home);
    expect(grant.ok).toBe(true);
    expect(readFileSync(daemonLockPath(home), 'utf8').trim()).toBe(String(process.pid));
    if (grant.ok) grant.release();
    // A second acquire after release succeeds.
    const again = acquireDaemonLock(home);
    expect(again.ok).toBe(true);
    if (again.ok) again.release();
  });

  it('refuses while another live process holds it', () => {
    // pid 1 (init) is alive and is not us on any POSIX box.
    mkdirSync(join(home, '.hnx'), { recursive: true });
    writeFileSync(daemonLockPath(home), '1\n');
    const refusal = acquireDaemonLock(home);
    expect(refusal).toEqual({ ok: false, pid: 1 });
  });

  it("steals a dead holder's lock", () => {
    mkdirSync(join(home, '.hnx'), { recursive: true });
    writeFileSync(daemonLockPath(home), '99999999\n'); // no such pid
    const grant = acquireDaemonLock(home);
    expect(grant.ok).toBe(true);
    if (grant.ok) grant.release();
  });

  it('steal rewrites the file with OUR pid (a stolen lock is owned, not shared)', () => {
    mkdirSync(join(home, '.hnx'), { recursive: true });
    writeFileSync(daemonLockPath(home), 'garbage\n'); // unparsable — stealable
    const grant = acquireDaemonLock(home);
    expect(grant.ok).toBe(true);
    expect(readFileSync(daemonLockPath(home), 'utf8').trim()).toBe(String(process.pid));
    if (grant.ok) grant.release();
  });

  it('our own leftover pid never refuses (self-hold is re-licensable)', () => {
    // A file carrying OUR pid (e.g. written by this process through an
    // earlier handle whose file outlived its release) is not "another
    // daemon" — re-acquire must grant, not deadlock on ourselves.
    mkdirSync(join(home, '.hnx'), { recursive: true });
    writeFileSync(daemonLockPath(home), `${String(process.pid)}\n`);
    const grant = acquireDaemonLock(home);
    expect(grant.ok).toBe(true);
    if (grant.ok) grant.release();
  });

  it('release after a steal never removes a successor file', () => {
    mkdirSync(join(home, '.hnx'), { recursive: true });
    writeFileSync(daemonLockPath(home), '99999999\n');
    const grant = acquireDaemonLock(home);
    expect(grant.ok).toBe(true);
    // Another process stole our (live) file out from under us — the path now
    // holds pid 1. Our release must leave it alone.
    writeFileSync(daemonLockPath(home), '1\n');
    if (grant.ok) grant.release();
    expect(readFileSync(daemonLockPath(home), 'utf8').trim()).toBe('1');
    rmSync(daemonLockPath(home));
  });
});
