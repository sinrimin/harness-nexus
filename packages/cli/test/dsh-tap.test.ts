// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';
// Plain .mjs, outside tsc's program (vitest transforms it).
import { apply as applyTapPlugin } from '../src/daemon/dsh-tap/index.mjs';
import { TapListener, tapPluginPath, writeTapPatch } from '../src/daemon/dsh-tap-listener.js';

/**
 * 9 W7.1 tap tests, layer 1+2: the plugin's wire behavior against a local
 * net server (handshake, forwarding, reject, dispose) and the TapListener's
 * line protocol (token gate, dispatch, loss, handshake race). The
 * end-to-end path (fixture agent speaking the plugin protocol through the
 * chat session manager) lives in chat.test.ts.
 */

function waitFor<T>(fn: () => T | undefined, ms = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      const v = fn();
      if (v !== undefined) return resolve(v);
      if (Date.now() - started > ms) return reject(new Error('waitFor: timeout'));
      setTimeout(tick, 15);
    };
    tick();
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Invoke `cb` for every newline-delimited string arriving on a socket. */
function onSocketLine(sock: Socket, cb: (line: string) => void): void {
  let buf = '';
  sock.on('data', (c: Buffer) => {
    buf += c.toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\n')) !== -1) {
      cb(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  });
}

/** Collect newline-delimited strings from a socket. */
function lineTap(sock: Socket): string[] {
  const lines: string[] = [];
  onSocketLine(sock, (l) => lines.push(l));
  return lines;
}

/** The fake cordis ctx the plugin needs: `on` + `effect`, recorded. */
function fakeCtx(): {
  on: (name: string, h: (...args: unknown[]) => void) => () => void;
  effect: (fn: () => () => unknown) => void;
  emit: (name: string, ...args: unknown[]) => void;
  disposeNow: () => void;
} {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  let dispose: (() => unknown) | null = null;
  return {
    on(name, h) {
      const list = handlers.get(name) ?? [];
      list.push(h);
      handlers.set(name, list);
      return () =>
        handlers.set(
          name,
          (handlers.get(name) ?? []).filter((x) => x !== h),
        );
    },
    effect(fn) {
      dispose = fn();
    },
    emit(name, ...args) {
      for (const h of handlers.get(name) ?? []) h(...args);
    },
    disposeNow: () => {
      dispose?.();
    },
  };
}

const disposers: (() => void)[] = [];

afterEach(() => {
  for (const d of disposers) d();
  disposers.length = 0;
  delete process.env.HNX_TAP_PORT;
  delete process.env.HNX_TAP_TOKEN;
});

describe('the tap plugin (index.mjs) vs a local net server', () => {
  it('handshakes (hello + pid), forwards bus events verbatim, disposes cleanly', async () => {
    const collected: string[] = [];
    const srv = createServer((sock) => onSocketLine(sock, (l) => collected.push(l)));
    const port = await new Promise<number>((res, rej) => {
      srv.once('error', rej);
      srv.listen(0, '127.0.0.1', () => res((srv.address() as { port: number }).port));
    });

    process.env.HNX_TAP_PORT = String(port);
    process.env.HNX_TAP_TOKEN = 'tok-1';
    const ctx = fakeCtx();
    disposers.push(ctx.disposeNow);
    applyTapPlugin(ctx as never);

    const hello = await waitFor(() =>
      collected[0] !== undefined
        ? (JSON.parse(collected[0]!) as Record<string, unknown>)
        : undefined,
    );
    expect(hello).toEqual({ type: 'hello', token: 'tok-1', pid: process.pid });

    ctx.emit(
      'session/event',
      { id: 's1' },
      { type: 'assistant/message', seq: 1, time: 1, data: { turn: 1, step: 0 } },
    );
    const forwarded = await waitFor(() =>
      collected[1] !== undefined
        ? (JSON.parse(collected[1]!) as Record<string, unknown>)
        : undefined,
    );
    expect(forwarded).toEqual({
      type: 'event',
      sessionId: 's1',
      event: { type: 'assistant/message', seq: 1, time: 1, data: { turn: 1, step: 0 } },
    });

    // #46 — the second subscription: agent/assistant-stream frames ride
    // `frame` lines, session identity from agent.session.id.
    const frame = {
      type: 'chunk',
      attemptId: 's1:1',
      revision: 2,
      index: 0,
      time: 1,
      chunk: { type: 'text-delta', index: 0, text: 'tok' },
    };
    ctx.emit('agent/assistant-stream', { agent: { session: { id: 's1' } }, frame });
    const forwardedFrame = await waitFor(() =>
      collected[2] !== undefined
        ? (JSON.parse(collected[2]!) as Record<string, unknown>)
        : undefined,
    );
    expect(forwardedFrame).toEqual({ type: 'frame', sessionId: 's1', frame });
    // A malformed frame payload (no session identity) still forwards — the
    // DAEMON filters; the plugin stays deliberately dumb.
    ctx.emit('agent/assistant-stream', { agent: null, frame });
    await waitFor(() => (collected[3] !== undefined ? true : undefined));
    expect(JSON.parse(collected[3]!)).toEqual({ type: 'frame', sessionId: null, frame });

    ctx.disposeNow();
    await sleep(150); // disposed — further bus lines must not write
    const disposed = collected.length;
    ctx.emit(
      'session/event',
      { id: 's1' },
      { type: 'assistant/message', seq: 2, time: 2, data: {} },
    );
    ctx.emit('agent/assistant-stream', { agent: { session: { id: 's1' } }, frame });
    expect(collected.length).toBe(disposed);
    await new Promise<void>((r) => srv.close(() => r()));
  });

  it('stops for good on a token reject (never spams a foreign port)', async () => {
    let connections = 0;
    const srv = createServer((sock) => {
      onSocketLine(sock, (line) => {
        const msg = JSON.parse(line) as { type?: string; token?: string };
        if (msg.type === 'hello' && msg.token !== 'expected') {
          sock.write(`${JSON.stringify({ type: 'reject' })}\n`);
          sock.destroy();
        }
      });
    });
    srv.on('connection', () => connections++);
    const port = await new Promise<number>((res, rej) => {
      srv.once('error', rej);
      srv.listen(0, '127.0.0.1', () => res((srv.address() as { port: number }).port));
    });

    process.env.HNX_TAP_PORT = String(port);
    process.env.HNX_TAP_TOKEN = 'wrong-token';
    const ctx = fakeCtx();
    disposers.push(ctx.disposeNow);
    applyTapPlugin(ctx as never);

    // A broken plugin would retry at ~100/300/700ms — the window catches it.
    await sleep(900);
    expect(connections).toBe(1);
    await new Promise<void>((r) => srv.close(() => r()));
  }, 4000);

  it('stays inert without tap env (a normal dsh run never connects)', async () => {
    delete process.env.HNX_TAP_PORT;
    delete process.env.HNX_TAP_TOKEN;
    let connections = 0;
    const srv = createServer(() => {
      connections++;
    });
    srv.on('connection', () => connections++);
    await new Promise<void>((res, rej) => {
      srv.once('error', rej);
      srv.listen(0, '127.0.0.1', () => res());
    });
    const ctx = fakeCtx();
    disposers.push(ctx.disposeNow);
    applyTapPlugin(ctx as never);
    await sleep(200);
    expect(connections).toBe(0);
    await new Promise<void>((r) => srv.close(() => r()));
  });
});

describe('TapListener', () => {
  it('gates on the hello token, dispatches events, reports loss, memoizes the handshake', async () => {
    const events: [string, Record<string, unknown>][] = [];
    const frames: [string, Record<string, unknown>][] = [];
    let losses = 0;
    const listener = await TapListener.create({
      onEvent: (sid, ev) => events.push([sid, ev]),
      onFrame: (sid, fr) => frames.push([sid, fr]),
      onLoss: () => losses++,
    });
    expect(listener.port).toBeGreaterThan(0);
    expect(listener.token).toBeTruthy();

    // Wrong token: reject line + destroyed, no handshake.
    const wrong = connect(listener.port, '127.0.0.1');
    const wrongLines = lineTap(wrong);
    let wrongClosed = false;
    wrong.on('close', () => {
      wrongClosed = true;
    });
    wrong.write(`${JSON.stringify({ type: 'hello', token: 'nope', pid: 1 })}\n`);
    expect(JSON.parse((await waitFor(() => wrongLines[0]))!)).toEqual({ type: 'reject' });
    await waitFor(() => (wrongClosed ? true : undefined));
    // The rejected hello did NOT count as a handshake: the race stays pending.
    const helloP = listener.waitHello(Date.now() + 3000);
    expect(
      await Promise.race([helloP.then(() => 'resolved'), sleep(150).then(() => 'pending')]),
    ).toBe('pending');

    // Correct hello: the pending race resolves and later calls memoize.
    const good = connect(listener.port, '127.0.0.1');
    good.write(`${JSON.stringify({ type: 'hello', token: listener.token, pid: 42 })}\n`);
    expect(await helloP).toBe(true);
    expect(await listener.waitHello(Date.now() + 1)).toBe(true);

    // Event lines dispatch; malformed ones are dropped, never fatal.
    const ev = {
      type: 'assistant/message',
      seq: 1,
      time: 1,
      data: {},
    };
    good.write(`${JSON.stringify({ type: 'event', sessionId: 's1', event: ev })}\n`);
    good.write(`${JSON.stringify({ type: 'event', event: ev })}\n`);
    good.write(`${JSON.stringify({ type: 'event', sessionId: 's2', event: 42 })}\n`);
    good.write('not json\n');
    // #46 — frame lines dispatch through onFrame with the same gating.
    const fr = { type: 'start', attemptId: 's1:1', revision: 1, turn: 1, step: 0 };
    good.write(`${JSON.stringify({ type: 'frame', sessionId: 's1', frame: fr })}\n`);
    good.write(`${JSON.stringify({ type: 'frame', sessionId: 's2', frame: 42 })}\n`);
    await waitFor(() => (events.length > 0 && frames.length > 0 ? true : undefined));
    await sleep(80);
    expect(events).toEqual([['s1', ev]]);
    expect(frames).toEqual([['s1', fr]]);

    // Post-hello socket loss → onLoss; an intentional close does not fire it.
    good.destroy();
    await waitFor(() => (losses === 1 ? true : undefined));
    listener.close();
    await sleep(80);
    expect(losses).toBe(1);
  });

  it('waitHello resolves false past the deadline and on close()', async () => {
    const l1 = await TapListener.create({ onEvent: () => {} });
    expect(await l1.waitHello(Date.now() + 80)).toBe(false);
    l1.close();

    const l2 = await TapListener.create({ onEvent: () => {} });
    const pending = l2.waitHello(Date.now() + 5000);
    l2.close();
    expect(await pending).toBe(false);
    l2.close(); // idempotent
  });
});

describe('tap plugin packaging', () => {
  it('tapPluginPath points inside the package; writeTapPatch renders a valid insert overlay', async () => {
    expect(tapPluginPath()).toMatch(/daemon[/\\]dsh-tap[/\\]index\.mjs$/);

    const home = mkdtempSync(join(tmpdir(), 'hnx-tap-patch-'));
    const path = writeTapPatch(home, '/abs/path/to/index.mjs');
    expect(path).toBe(join(home, '.hnx', 'dsh-tap.patch.yml'));
    const parsed = yaml.load(readFileSync(path!, 'utf8')) as unknown;
    // The spike-proven mount shape: patch entries are id-targeted, NEW rows
    // require the `- insert:` directive.
    expect(parsed).toEqual([{ insert: [{ id: 'hnx-tap', name: '/abs/path/to/index.mjs' }] }]);
  });
});
