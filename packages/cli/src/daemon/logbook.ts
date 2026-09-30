import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The daemon's local logbook (#38) — two files under `~/.hnx/logs/` plus an
 * in-process event bus:
 *
 *   ops.log  — one line per OPERATION the daemon performs on this machine
 *              (adapter provisioning, harness install/upgrade, profile
 *              deploys, runtime-config applies, marketplace deploys, and
 *              manual `hnx install`). Low volume, always on, no content.
 *   comm.log — the /ctl socket traffic, metadata only by default: direction,
 *              event name, byte size. High-frequency stream events
 *              (`chat:event` deltas) collapse into one summary line per
 *              burst, so a chat turn costs ~3 lines instead of hundreds and
 *              cannot wash the interesting lines out of the rotation window.
 *              `HNX_LOG_COMM=payload` adds full payloads (4KB/line cap) —
 *              DEBUG ONLY: payloads carry chat content.
 *
 * Both files rotate by size (ops 256KB×3, comm 1MB×5 — a hard disk ceiling),
 * and `hnx logs` tails or bundles them.
 *
 * TUI groundwork: nothing writes to disk directly. Every entry is published
 * to `logbook` (a ring-buffered bus) FIRST; the rotating file sinks are just
 * subscribers. A future `hnx tui` (#39) runs the daemon in-process
 * (`runDaemon`) and subscribes to the same bus for its comm/ops panes — live,
 * unaggregated where it wants, without tailing files.
 */

export interface OpEntry {
  kind: 'op';
  at: string;
  op: string;
  target?: string;
  outcome: 'ok' | 'error';
  ms?: number;
  detail?: string;
}

export type CommDirection = 'tx' | 'rx' | '--';

export interface CommEntry {
  kind: 'comm';
  at: string;
  dir: CommDirection;
  event: string;
  bytes: number;
}

export interface LogLineEntry {
  kind: 'log';
  at: string;
  level: 'log' | 'warn' | 'error';
  text: string;
}

export type LogbookEntry = OpEntry | CommEntry | LogLineEntry;

type Listener = (entry: LogbookEntry) => void;

/** Ring-buffered fan-out: files subscribe, the future TUI subscribes. */
class LogbookBus {
  #ring: LogbookEntry[] = [];
  #subs = new Set<Listener>();
  readonly capacity = 500;

  publish(entry: LogbookEntry): void {
    this.#ring.push(entry);
    if (this.#ring.length > this.capacity) this.#ring.splice(0, this.#ring.length - this.capacity);
    for (const fn of this.#subs) {
      try {
        fn(entry);
      } catch {
        // A listener must never take the daemon down.
      }
    }
  }

  subscribe(fn: Listener): () => void {
    this.#subs.add(fn);
    return () => {
      this.#subs.delete(fn);
    };
  }

  recent(n = 100): LogbookEntry[] {
    return this.#ring.slice(-n);
  }
}

export const logbook = new LogbookBus();

// ---- files ----

export function logsDir(): string {
  const base = process.env.HNX_LOG_DIR ?? join(homedir(), '.hnx', 'logs');
  mkdirSync(base, { recursive: true, mode: 0o700 });
  return base;
}

export function opsLogPath(): string {
  return join(logsDir(), 'ops.log');
}

export function commLogPath(): string {
  return join(logsDir(), 'comm.log');
}

const OPS_MAX_BYTES = 256 * 1024;
const OPS_KEEP = 3;
const COMM_MAX_BYTES = 1024 * 1024;
const COMM_KEEP = 5;

/**
 * Size-rotated append: once `file` reaches `maxBytes`, shift the `.1…` chain
 * (dropping the oldest) and start fresh. A missing link in the chain is a
 * GAP, not an error — each shift tolerates ENOENT separately, or the very
 * first rotation (no `.1` yet) would abort the whole shift and the file
 * would grow past the cap forever.
 */
export function rotateAppend(file: string, line: string, maxBytes: number, keep: number): void {
  try {
    if (statSync(file).size >= maxBytes) {
      const shift = (from: string, to: string): void => {
        try {
          renameSync(from, to);
        } catch {
          // Missing source — a gap in the chain is fine.
        }
      };
      rmSync(`${file}.${String(keep)}`, { force: true });
      for (let i = keep - 1; i >= 1; i--) {
        shift(`${file}.${String(i)}`, `${file}.${String(i + 1)}`);
      }
      shift(file, `${file}.1`);
    }
  } catch {
    // No existing file (or stat race) — fall through to the append.
  }
  appendFileSync(file, `${line}\n`);
}

// ---- ops ----

/** Record one operation. Never throws — logging must not break the daemon. */
export function logOp(e: {
  op: string;
  target?: string;
  outcome: 'ok' | 'error';
  ms?: number;
  detail?: string;
}): void {
  const entry: OpEntry = {
    kind: 'op',
    at: new Date().toISOString(),
    op: e.op,
    ...(e.target !== undefined ? { target: e.target } : {}),
    outcome: e.outcome,
    ...(e.ms !== undefined ? { ms: e.ms } : {}),
    ...(e.detail !== undefined ? { detail: e.detail } : {}),
  };
  logbook.publish(entry);
  try {
    rotateAppend(
      opsLogPath(),
      `${entry.at} op=${entry.op} target=${entry.target ?? '-'} outcome=${entry.outcome} ms=${
        entry.ms ?? '-'
      }${entry.detail !== undefined ? ` ${singleLine(entry.detail, 500)}` : ''}`,
      OPS_MAX_BYTES,
      OPS_KEEP,
    );
  } catch {
    // Disk full / permissions — the bus still notified live listeners.
  }
}

/** Collapse whitespace and cap length; JSON-quote so the line stays one line. */
function singleLine(text: string, cap: number): string {
  const squashed = JSON.stringify(text.replace(/\s+/g, ' ').trim());
  return squashed.length > cap ? `${squashed.slice(0, cap)}…"` : squashed;
}

/**
 * #39 — one captured console line (the TUI redirects the daemon's console
 * output here so stray prints reach the logbook instead of corrupting the
 * alternate screen). Rides the ops file so `hnx logs` sees them too.
 */
export function logLine(level: 'log' | 'warn' | 'error', text: string): void {
  const entry: LogLineEntry = {
    kind: 'log',
    at: new Date().toISOString(),
    level,
    text: singleLine(text, 500).slice(1, -1), // squashed, but unquoted: not a detail field
  };
  logbook.publish(entry);
  try {
    rotateAppend(
      opsLogPath(),
      `${entry.at} [${entry.level}] ${entry.text}`,
      OPS_MAX_BYTES,
      OPS_KEEP,
    );
  } catch {
    // Never fatal.
  }
}

// ---- comm ----

/** Events whose consecutive runs collapse into one summary line per burst. */
const CHATTY_EVENTS = new Set(['chat:event']);

/** A burst closes this long after its last event (also on any different event). */
const BURST_IDLE_MS = 2_000;

interface Burst {
  dir: CommDirection;
  event: string;
  count: number;
  bytes: number;
  firstAt: number;
  lastAt: number;
}

/**
 * Burst-collapsing line producer (#39): feeds bus comm entries in, gets one
 * display line per ordinary event out — a chatty event's consecutive run
 * yields its opening line immediately (the liveness marker) and one summary
 * line when the burst closes (different event, `idleMs` quiet, or an explicit
 * flush). The comm FILE and the TUI's comm pane both render through this one
 * class so the two views collapse identically.
 */
export class CommAggregator {
  #open: Burst | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly sink: (line: string) => void,
    private readonly idleMs: number = BURST_IDLE_MS,
  ) {}

  push(entry: CommEntry): void {
    if (entry.dir === '--') {
      this.flush();
      this.sink(`${entry.at} -- ${entry.event}`);
      return;
    }
    if (this.#open !== null && this.#open.event === entry.event && this.#open.dir === entry.dir) {
      this.#open.count += 1;
      this.#open.bytes += entry.bytes;
      this.#open.lastAt = Date.parse(entry.at);
      this.#arm();
      return;
    }
    this.flush();
    const line = `${entry.at} ${entry.dir} ${entry.event} ${fmtBytes(entry.bytes)}`;
    if (CHATTY_EVENTS.has(entry.event)) {
      const now = Date.parse(entry.at);
      this.#open = {
        dir: entry.dir,
        event: entry.event,
        count: 1,
        bytes: entry.bytes,
        firstAt: now,
        lastAt: now,
      };
      this.#arm();
      // The opening line is the liveness marker; the summary covers the burst.
      this.sink(line);
      return;
    }
    this.sink(line);
  }

  /** Close the open burst (if any) with its summary line. */
  flush(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const burst = this.#open;
    this.#open = null;
    if (burst === null || burst.count <= 1) return;
    const span = ((burst.lastAt - burst.firstAt) / 1000).toFixed(1);
    this.sink(
      `${new Date().toISOString()} ${burst.dir} ${burst.event} ×${String(burst.count)} total ${fmtBytes(
        burst.bytes,
      )} over ${span}s`,
    );
  }

  #arm(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.flush();
    }, this.idleMs);
    this.#timer.unref();
  }
}

/** The file view's aggregator instance (the sink rotates into comm.log). */
const fileAggregator = new CommAggregator((line) => {
  try {
    rotateAppend(commLogPath(), line, COMM_MAX_BYTES, COMM_KEEP);
  } catch {
    // Never fatal.
  }
});

/** The minimal socket surface `attachCommLog` needs (socket.io-client Socket
 * satisfies it; tests pass a fake). tx has no client-side catch-all
 * (`onAnyOutbound` is a server feature), so the attach WRAPS `emit`. */
export interface CommSocket {
  onAny(fn: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): unknown;
  on(event: 'connect', fn: () => void): void;
  on(event: 'disconnect', fn: (reason: unknown) => void): void;
}

/**
 * Wire a daemon socket into the logbook. Every packet is published to the bus
 * immediately (live listeners see the real cadence); the FILE view is burst-
 * aggregated for chatty events. Lifecycle markers (`-- connect`, `--
 * disconnect <reason>`) are logged verbatim — for "why did my session drop"
 * those two lines are the headline.
 */
export function attachCommLog(socket: CommSocket): void {
  const payloadMode = process.env.HNX_LOG_COMM === 'payload';

  const record = (dir: CommDirection, event: string, args: unknown[]): void => {
    const bytes = jsonBytes(args);
    logbook.publish({
      kind: 'comm',
      at: new Date().toISOString(),
      dir,
      event,
      bytes,
    });
    commFileFeed(dir, event, bytes);
    if (payloadMode) {
      try {
        rotateAppend(
          commLogPath(),
          `${new Date().toISOString()} ${dir} ${event} payload=${truncate(
            JSON.stringify(args[0] ?? null),
            4096,
          )}`,
          COMM_MAX_BYTES,
          COMM_KEEP,
        );
      } catch {
        // Never fatal.
      }
    }
  };

  socket.onAny((...args) => {
    const [event, ...rest] = args as [string, ...unknown[]];
    record('rx', event, rest);
  });
  // tx: wrap the instance's emit (transparent to every handler that keeps
  // calling socket.emit — ack callbacks pass through untouched).
  const originalEmit = socket.emit.bind(socket);
  socket.emit = ((event: string, ...args: unknown[]): unknown => {
    record('tx', event, args);
    return originalEmit(event, ...args);
  }) as CommSocket['emit'];
  socket.on('connect', () => {
    record('--', 'connect', []);
  });
  socket.on('disconnect', (reason) => {
    record('--', `disconnect ${String(reason)}`, []);
    flushCommBursts();
  });
}

/** File-side feed: one line per event, except chatty bursts. */
function commFileFeed(dir: CommDirection, event: string, bytes: number): void {
  fileAggregator.push({ kind: 'comm', at: new Date().toISOString(), dir, event, bytes });
}

/** Close the file view's open burst (if any). Public for tests. */
export function flushCommBursts(): void {
  fileAggregator.flush();
}

function jsonBytes(args: unknown[]): number {
  try {
    return Buffer.byteLength(JSON.stringify(args));
  } catch {
    return 0;
  }
}

function truncate(text: string, cap: number): string {
  return text.length > cap ? text.slice(0, cap) : text;
}

function fmtBytes(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${String(n)}B`;
}
