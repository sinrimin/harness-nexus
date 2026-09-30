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
});
