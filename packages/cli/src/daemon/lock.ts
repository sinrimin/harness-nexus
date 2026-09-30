import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * #39 — single-daemon lock (~/.hnx/daemon.lock, advisory, pid-based).
 *
 * A machine may run ONE daemon-owning process (`hnx daemon` or `hnx tui`).
 * This is not cosmetic: job dispatch is a broadcast into the machine's /ctl
 * room, so two attached daemons would BOTH run every deploy/install job.
 * The lock is advisory with pid liveness — a holder that died without
 * releasing (SIGKILL, OOM) is stealable. Pid reuse can in theory pin a lock
 * on an unrelated process; the failure mode is a refusal with a pid to
 * inspect, never a double dispatch.
 */

export interface LockRefusal {
  ok: false;
  pid: number;
}

export interface LockGrant {
  ok: true;
  release: () => void;
}

export function daemonLockPath(home: string): string {
  return join(home, '.hnx', 'daemon.lock');
}

/** Is a process with this pid alive? EPERM = alive but another user's. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Acquire the daemon lock under `<home>/.hnx`. A stale lock (dead holder)
 * is stolen; a live one refuses with its pid.
 */
export function acquireDaemonLock(home: string): LockGrant | LockRefusal {
  const path = daemonLockPath(home);
  if (existsSync(path)) {
    const raw = readFileSync(path, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    if (Number.isFinite(pid) && pid > 0 && pid !== process.pid && pidAlive(pid)) {
      return { ok: false, pid };
    }
    // Dead holder (or unparsable file) — steal it.
  }
  mkdirSync(join(home, '.hnx'), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${String(process.pid)}\n`, { mode: 0o600 });
  let released = false;
  return {
    ok: true,
    release: (): void => {
      if (released) return;
      released = true;
      // Only remove what we wrote — a stolen-then-rewritten lock must not
      // unlink a successor's file.
      try {
        if (readFileSync(path, 'utf8').trim() === String(process.pid)) rmSync(path, { force: true });
      } catch {
        // Already gone.
      }
    },
  };
}
