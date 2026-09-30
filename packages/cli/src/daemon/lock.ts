import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * #39 — single-daemon lock (~/.hnx/daemon.lock, advisory, pid-based).
 *
 * A machine may run ONE daemon-owning process (`hnx daemon` or `hnx tui`).
 * This is not cosmetic: job dispatch is a broadcast into the machine's /ctl
 * room, so two attached daemons would BOTH run every deploy/install job (#45
 * saw it bill one prompt three times). The lock is advisory with pid
 * liveness — a holder that died without releasing (SIGKILL, OOM) is
 * stealable. Pid reuse can in theory pin a lock on an unrelated process; the
 * failure mode is a refusal with a pid to inspect, never a double dispatch.
 *
 * #45 — creation is ATOMIC (O_CREAT|O_EXCL): two daemons starting in the same
 * instant race on `open` and exactly one wins; the loser reads the winner's
 * pid and refuses. The steal path (dead holder) unlinks and retries the same
 * atomic create, so concurrent steals also converge on a single winner. A
 * manually deleted lock file is still re-licensable by anyone — that hole is
 * closed server-side (the /ctl handshake refuses a second live socket per
 * machine), not here.
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

/** Upper bound on unlink-and-retry cycles when a stale lock keeps racing us. */
const MAX_STEAL_ATTEMPTS = 3;

/**
 * Acquire the daemon lock under `<home>/.hnx`. A live holder refuses with its
 * pid; a dead/unparsable one is stolen via atomic-create retries.
 */
export function acquireDaemonLock(home: string): LockGrant | LockRefusal {
  const path = daemonLockPath(home);
  mkdirSync(join(home, '.hnx'), { recursive: true, mode: 0o700 });
  for (let attempt = 0; ; attempt++) {
    let fd: number | undefined;
    try {
      fd = openSync(path, 'wx', 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    if (fd !== undefined) {
      try {
        writeSync(fd, `${String(process.pid)}\n`);
      } finally {
        closeSync(fd);
      }
      let released = false;
      return {
        ok: true,
        release: (): void => {
          if (released) return;
          released = true;
          // Only remove what we wrote — a stolen-then-rewritten lock must not
          // unlink a successor's file.
          try {
            if (readFileSync(path, 'utf8').trim() === String(process.pid)) {
              rmSync(path, { force: true });
            }
          } catch {
            // Already gone.
          }
        },
      };
    }
    // EEXIST — someone created the file. A live holder (never ourselves: our
    // own pid means this process already holds it through another handle)
    // refuses; anything else is stealable.
    let raw = '';
    try {
      raw = readFileSync(path, 'utf8').trim();
    } catch {
      // Vanished mid-read — the retry below re-races the atomic create.
    }
    const pid = Number.parseInt(raw, 10);
    const live = Number.isFinite(pid) && pid > 0 && pid !== process.pid && pidAlive(pid);
    if (live || attempt >= MAX_STEAL_ATTEMPTS - 1) {
      // Refuse rather than force: a lock we cannot reason about must never
      // license a second daemon (the failure mode is a refusal, never a
      // double dispatch).
      return { ok: false, pid: Number.isFinite(pid) && pid > 0 ? pid : 0 };
    }
    try {
      rmSync(path, { force: true });
    } catch {
      // Raced away — the next atomic create decides.
    }
  }
}
