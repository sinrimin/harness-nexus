import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  attachCommLog,
  CommAggregator,
  commLogPath,
  flushCommBursts,
  logLine,
  logOp,
  logbook,
  opsLogPath,
  rotateAppend,
  type CommSocket,
} from '../src/daemon/logbook.js';

/**
 * #38 — the daemon's local logbook: rotation, single-line ops entries, the
 * comm log's burst aggregation, and the bus that will feed a future TUI (#39).
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hnx-logbook-'));
  process.env.HNX_LOG_DIR = dir;
});

afterEach(() => {
  delete process.env.HNX_LOG_DIR;
  delete process.env.HNX_LOG_COMM;
  rmSync(dir, { recursive: true, force: true });
});

describe('rotateAppend', () => {
  it('shifts the .N chain and drops the oldest once the cap is hit', () => {
    const file = join(dir, 'x.log');
    // The cap is checked BEFORE each append: a 1B line, a 12B line (total 14),
    // then any further append rotates.
    rotateAppend(file, 'a', 8, 2);
    rotateAppend(file, 'b'.repeat(12), 8, 2);
    rotateAppend(file, 'c', 8, 2); // 14 ≥ 8 → rotate #1
    rotateAppend(file, 'd'.repeat(12), 8, 2);
    rotateAppend(file, 'e', 8, 2); // rotate #2 → .2 born
    expect(existsSync(`${file}.2`)).toBe(true);
    rotateAppend(file, 'f'.repeat(12), 8, 2);
    rotateAppend(file, 'g', 8, 2); // rotate #3 → keep=2 drops the oldest
    expect(existsSync(`${file}.3`)).toBe(false);
    expect(readFileSync(`${file}.2`, 'utf8')).toBe(`c\n${'d'.repeat(12)}\n`);
    expect(readFileSync(file, 'utf8')).toBe('g\n');
  });
});

describe('logOp', () => {
  it('writes one line per op with squashed detail', () => {
    logOp({ op: 'deploy', target: 'codex', outcome: 'ok', ms: 1200, detail: 'profile p1' });
    logOp({
      op: 'harness.install',
      target: 'deepseek',
      outcome: 'error',
      detail: 'npm install exited 1:\n  long tail\n  more tail',
    });
    const lines = readFileSync(opsLogPath(), 'utf8')
      .split('\n')
      .filter((l) => l !== '');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z op=deploy target=codex outcome=ok ms=1200 "profile p1"$/,
    );
    expect(lines[1]).toContain('outcome=error');
    // The multi-line detail was squashed into the single line.
    expect(lines[1]).toContain('npm install exited 1: long tail more tail');
    expect(lines[1].match(/\n/)).toBeNull();
  });
});

/** A minimal CommSocket double. `fire('tx')` goes through `sock.emit`, i.e.
 * through the REAL wrap path attachCommLog installs (JS property lookup is
 * late-bound, so it picks up the wrapped emit). */
function fakeSocket(): {
  sock: CommSocket;
  fire(dir: 'rx' | 'tx', event: string, args?: unknown[]): void;
  handlers: { connect: (() => void)[]; disconnect: ((r: unknown) => void)[] };
} {
  const anyIn: Array<(...args: unknown[]) => void> = [];
  const handlers = { connect: [] as (() => void)[], disconnect: [] as ((r: unknown) => void)[] };
  const sock: CommSocket = {
    onAny: (fn) => {
      anyIn.push(fn);
    },
    // Replaced in place by attachCommLog's wrap; this stub is the innermost
    // passthrough the wrap ends up calling.
    emit: () => true,
    on: (event: string, fn: never) => {
      if (event === 'connect') handlers.connect.push(fn as unknown as () => void);
      if (event === 'disconnect') handlers.disconnect.push(fn as unknown as (r: unknown) => void);
    },
  };
  return {
    sock,
    fire(dir, event, args = []) {
      if (dir === 'tx') void sock.emit(event, ...args);
      else anyIn.forEach((fn) => fn(event, ...args));
    },
    handlers,
  };
}

describe('attachCommLog', () => {
  it('logs one line per ordinary event, verbatim lifecycle markers', () => {
    const ctx = fakeSocket();
    attachCommLog(ctx.sock);
    ctx.handlers.connect.forEach((fn) => fn());
    ctx.fire('tx', 'machine:hello', [{ daemonVersion: '0.1.0' }]);
    ctx.fire('rx', 'inventory:scan', [{ requestId: 'r1' }]);
    ctx.handlers.disconnect.forEach((fn) => fn('transport close'));
    flushCommBursts();
    const lines = readFileSync(commLogPath(), 'utf8')
      .split('\n')
      .filter((l) => l !== '');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain('-- connect');
    expect(lines[1]).toMatch(/tx machine:hello \d+B$/);
    expect(lines[2]).toMatch(/rx inventory:scan \d+B$/);
    expect(lines[3]).toContain('-- disconnect transport close');
  });

  it('collapses a chat:event burst into a marker + one summary line', () => {
    const ctx = fakeSocket();
    attachCommLog(ctx.sock);
    for (let i = 0; i < 200; i++) ctx.fire('tx', 'chat:event', [{ sessionId: 's', i }]);
    ctx.fire('rx', 'job:dispatch', [{ id: 'j1' }]); // different event closes the burst
    flushCommBursts();
    const lines = readFileSync(commLogPath(), 'utf8')
      .split('\n')
      .filter((l) => l !== '');
    // First occurrence + summary + the interleaved event = 3 lines for 201 packets.
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/tx chat:event \d+B$/);
    expect(lines[1]).toMatch(/tx chat:event ×200 total \d+(\.\d+)?(KB|B) over \d+(\.\d+)?s$/);
    expect(lines[2]).toMatch(/rx job:dispatch \d+B$/);
  });

  it('payload mode adds a capped payload line (opt-in only)', () => {
    process.env.HNX_LOG_COMM = 'payload';
    const ctx = fakeSocket();
    attachCommLog(ctx.sock);
    ctx.fire('rx', 'chat:history', [{ items: 'x'.repeat(9000) }]);
    flushCommBursts();
    const lines = readFileSync(commLogPath(), 'utf8')
      .split('\n')
      .filter((l) => l !== '');
    expect(lines.some((l) => l.includes('payload=') && l.length < 4300)).toBe(true);
  });

  it('publishes every entry to the bus (TUI feed) even when the file aggregates', () => {
    const seen: number[] = [];
    const off = logbook.subscribe((e) => {
      if (e.kind === 'comm' && e.event === 'chat:event') seen.push(e.bytes);
    });
    const ctx = fakeSocket();
    attachCommLog(ctx.sock);
    for (let i = 0; i < 50; i++) ctx.fire('tx', 'chat:event', [{ i }]);
    flushCommBursts();
    off();
    expect(seen).toHaveLength(50); // unaggregated live feed
    const fileLines = readFileSync(commLogPath(), 'utf8')
      .split('\n')
      .filter((l) => l !== '');
    expect(fileLines).toHaveLength(2); // marker + summary
  });
});

describe('logbook bus', () => {
  it('keeps a bounded ring and honors unsubscribe', () => {
    const off = logbook.subscribe(() => {});
    off();
    logOp({ op: 'install', outcome: 'ok' });
    expect(logbook.recent(10).some((e) => e.kind === 'op' && e.op === 'install')).toBe(true);
  });
});

describe('logLine (#39 console capture)', () => {
  it('squashes onto one line, publishes to the bus, and rides the ops file', () => {
    const seen: string[] = [];
    const off = logbook.subscribe((e) => {
      if (e.kind === 'log') seen.push(`${e.level}:${e.text}`);
    });
    logLine('warn', 'adapter provisioning — installed\n  second line');
    off();
    expect(seen).toEqual(['warn:adapter provisioning — installed second line']);
    const line = readFileSync(opsLogPath(), 'utf8').trim();
    expect(line).toMatch(/^\S+ \[warn\] adapter provisioning — installed second line$/);
  });
});

describe('CommAggregator as a second view (#39)', () => {
  it('collapses a burst identically for an independent TUI-side instance', () => {
    const lines: string[] = [];
    const agg = new CommAggregator((l) => lines.push(l), 60_000);
    const at = '2026-09-30T04:00:00.000Z';
    agg.push({ kind: 'comm', at, dir: 'tx', event: 'chat:event', bytes: 100 });
    agg.push({ kind: 'comm', at, dir: 'tx', event: 'chat:event', bytes: 50 });
    // A different event closes the burst: marker + summary, then its own line.
    agg.push({ kind: 'comm', at, dir: 'rx', event: 'job:dispatch', bytes: 10 });
    expect(lines).toEqual([
      `${at} tx chat:event 100B`,
      expect.stringMatching(/^.* tx chat:event ×2 total 150B over 0\.0s$/),
      `${at} rx job:dispatch 10B`,
    ]);
    agg.flush(); // nothing was left open
    expect(lines).toHaveLength(3);
  });
});
