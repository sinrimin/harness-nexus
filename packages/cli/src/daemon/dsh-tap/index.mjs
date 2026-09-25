// Harness Nexus dsh event tap (Phase 9 W7.1).
// wiki design-phase-9-w7.1-dsh-event-tap.md
//
// A ZERO-DEPENDENCY cordis plugin, insert-mounted at SPAWN TIME via
// `dsh --patch <yml>` (the daemon renders the patch next to this file's
// absolute path — it never touches ~/.dsh). It subscribes dsh's in-process
// session event bus and forwards every event — verbatim, for ALL sessions —
// as JSON lines to the daemon's localhost TapListener (HNX_TAP_PORT /
// HNX_TAP_TOKEN ride the child env). The DAEMON filters by session id; this
// plugin stays deliberately dumb.
//
// Constraints (spike-verified — see the design doc §Spike results):
// - dsh's stdio belongs to the ACP JSON-RPC protocol: this file NEVER writes
//   to stdout/stderr, and swallows its own errors — a broken tap must
//   degrade to the daemon's transcript-tail fallback, never break the agent.
// - Bus events arrive zero-latency in the verbatim SessionEvent envelope
//   (`{type, seq, time, data}`) — the same shape the file tail parses, so
//   both sources feed one mapper. Persistence packing (`text-chunks` rows)
//   never appears on the bus.
// - Depends ONLY on the `apply(ctx)` / `ctx.on` / `ctx.effect` surface —
//   the same surface the reference bridge uses in production.

import { connect as netConnect } from 'node:net';

export const name = 'harness-nexus-tap';

// The listener is up before the spawn, so retries only cover transient
// localhost hiccups and a daemon-side decision timeout — bounded, then the
// tap goes dormant (the daemon will not reopen this port).
const RECONNECT_BASE_MS = 100;
const RECONNECT_MAX_MS = 2000;
const RECONNECT_ATTEMPTS = 10;

export function apply(ctx) {
  const port = Number(process.env.HNX_TAP_PORT);
  const token = process.env.HNX_TAP_TOKEN;
  if (!Number.isInteger(port) || port <= 0 || typeof token !== 'string' || token === '') {
    return; // not spawned by the hnx daemon — stay inert
  }

  let socket = null;
  let writable = false;
  let stopped = false;
  let rejected = false;
  let attempts = 0;
  let retryTimer = null;

  const offEvent = ctx.on('session/event', (session, event) => {
    if (stopped || !writable || socket === null) return;
    let line;
    try {
      line = JSON.stringify({ type: 'event', sessionId: session?.id, event });
    } catch {
      return; // unserializable event — skip rather than break the turn
    }
    socket.write(`${line}\n`);
  });

  const connect = () => {
    if (stopped) return;
    const s = netConnect(port, '127.0.0.1');
    socket = s;
    writable = false;
    s.on('connect', () => {
      attempts = 0;
      writable = true;
      s.write(`${JSON.stringify({ type: 'hello', token, pid: process.pid })}\n`);
    });
    s.on('data', (buf) => {
      try {
        if (JSON.parse(String(buf))?.type === 'reject') {
          // Wrong token: the port belongs to something else — never retry.
          rejected = true;
          s.destroy();
        }
      } catch {
        // not the reject line — ignore (the listener speaks only on reject)
      }
    });
    s.on('error', () => {}); // ECONNREFUSED etc — the close handler retries
    s.on('close', () => {
      if (socket === s) socket = null;
      writable = false;
      if (stopped || rejected || attempts >= RECONNECT_ATTEMPTS) return;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempts, RECONNECT_MAX_MS);
      attempts += 1;
      retryTimer = setTimeout(connect, delay);
    });
  };

  ctx.effect(() => () => {
    stopped = true;
    offEvent();
    if (retryTimer !== null) clearTimeout(retryTimer);
    socket?.destroy();
  });

  connect();
}
