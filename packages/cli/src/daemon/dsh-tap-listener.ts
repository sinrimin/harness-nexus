// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Daemon side of the dsh in-process event tap (Phase 9 W7.1; #46 tap v2).
 * wiki design-phase-9-w7.1-dsh-event-tap.md
 *
 * `dsh --patch` insert-mounts the zero-dep plugin shipped at
 * `daemon/dsh-tap/index.mjs`; the plugin dials back this localhost listener
 * (one per chat channel: ephemeral port, one-time token) and streams dsh's
 * in-process buses as JSON lines — zero latency, verbatim shapes, no
 * persistence encoding involved. Two line kinds feed the SAME live mapper
 * the transcript tail uses (chat.ts): `session/event` bus rows (settlement,
 * tools, turn markers — the `{type, seq, time, data}` envelope) and, since
 * dsh 0.1.3 (#46), `agent/assistant-stream` FRAMES carrying the per-token
 * deltas. The wire's committed chunks stay suppressed while the tap is live.
 * Everything here is best-effort by construction: any failure (plugin load
 * error, listen failure) degrades to the W7 file tail — worst case equals
 * block-at-commit streaming.
 */

/** Absolute path of the shipped tap plugin (dist in builds, src under tsx dev). */
export function tapPluginPath(): string {
  return fileURLToPath(new URL('./dsh-tap/index.mjs', import.meta.url));
}

/**
 * Render the spawn-time overlay that insert-mounts the tap plugin, into the
 * daemon's config dir (`~/.hnx/dsh-tap.patch.yml`) — NEVER into `~/.dsh`
 * (the user's home patch is their surface; W3 owns its marked region). The
 * same file serves every channel: the per-channel port/token ride env, not
 * the patch. Null on any write failure — the caller then skips the tap.
 */
export function writeTapPatch(home: string, pluginPath: string): string | null {
  const body = [
    '# Harness Nexus dsh event tap — spawn-time overlay (regenerated per boot,',
    '# safe to delete). Applied ONLY via `dsh --patch` on processes the hnx',
    '# daemon spawns; never merged into ~/.dsh.',
    '- insert:',
    '    - id: hnx-tap',
    `      name: ${JSON.stringify(pluginPath)}`,
    '',
  ].join('\n');
  try {
    const dir = join(home, '.hnx');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, 'dsh-tap.patch.yml');
    writeFileSync(path, body, { mode: 0o600 });
    return path;
  } catch {
    return null;
  }
}

/** Whether the tap plugin asset actually exists (guards broken installs). */
export function tapPluginAvailable(): boolean {
  try {
    return existsSync(tapPluginPath());
  } catch {
    return false;
  }
}

export interface TapListenerEvents {
  /** Every `session/event` bus row of every session — settlement, tools, turn markers. */
  onEvent: (sessionId: string, event: Record<string, unknown>) => void;
  /** Every `agent/assistant-stream` frame (dsh ≥0.1.3) — the token-delta arm. */
  onFrame?: (sessionId: string, frame: Record<string, unknown>) => void;
  /** A post-handshake socket loss: the tap is dead (committed-only ensues). */
  onLoss?: () => void;
}

/**
 * The localhost JSON-line endpoint the dsh tap plugin dials. Line protocol:
 * the plugin's first line must be `{"type":"hello","token","pid"}` — a token
 * mismatch gets a `{"type":"reject"}` and the socket destroyed (the plugin
 * then stops; the port is not its listener). Every later line is
 * `{"type":"event","sessionId","event"}` (bus rows) or
 * `{"type":"frame","sessionId","frame"}` (assistant-stream frames).
 * `waitHello(deadlineAt)` is the handshake race: true once a valid hello
 * landed, false past the deadline or after `close()` — the caller treats
 * false as "no tap, fall back".
 */
export class TapListener {
  readonly token: string;

  private readonly server: Server;
  private socket: Socket | null = null;
  private closed = false;
  private helloSeen = false;
  private readonly helloWaiters = new Set<(ok: boolean) => void>();

  private constructor(
    token: string,
    private readonly events: TapListenerEvents,
  ) {
    this.token = token;
    this.server = createServer((s) => this.onConnection(s));
  }

  static async create(events: TapListenerEvents): Promise<TapListener> {
    const listener = new TapListener(randomBytes(24).toString('base64url'), events);
    await new Promise<void>((resolve, reject) => {
      const onError = (e: Error): void => reject(e);
      listener.server.once('error', onError);
      listener.server.listen(0, '127.0.0.1', () => {
        listener.server.off('error', onError);
        resolve();
      });
    });
    if (listener.port === 0) throw new Error('tap listener has no port');
    return listener;
  }

  /** The ephemeral port the plugin dials (0 before `create` resolves). */
  get port(): number {
    const addr = this.server.address();
    return typeof addr === 'object' && addr !== null ? addr.port : 0;
  }

  /** Resolves on a valid hello (true) or the deadline / close (false). */
  waitHello(deadlineAt: number): Promise<boolean> {
    if (this.helloSeen) return Promise.resolve(true);
    if (this.closed) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const settled = (ok: boolean): void => {
        clearTimeout(timer);
        this.helloWaiters.delete(settled);
        resolve(ok);
      };
      this.helloWaiters.add(settled);
      const timer = setTimeout(() => settled(this.helloSeen), Math.max(0, deadlineAt - Date.now()));
      timer.unref?.();
    });
  }

  /** Destroy the socket and stop listening (idempotent). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket?.destroy();
    this.socket = null;
    this.server.close();
    for (const w of this.helloWaiters) w(false);
    this.helloWaiters.clear();
  }

  private onConnection(sock: Socket): void {
    if (this.closed || this.socket !== null) {
      // One plugin per listener; a stray second connection is not ours.
      sock.destroy();
      return;
    }
    this.socket = sock;
    let buffer = '';
    sock.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        this.onLine(sock, line);
        if (this.socket !== sock) return; // destroyed mid-parse
      }
    });
    sock.on('close', () => {
      if (this.socket !== sock) return;
      this.socket = null;
      if (this.helloSeen && !this.closed) this.events.onLoss?.();
    });
    sock.on('error', () => {}); // close follows; the loss path handles it
  }

  private onLine(sock: Socket, line: string): void {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return; // noise on the wire — skip
    }
    const m = msg as {
      type?: unknown;
      token?: unknown;
      sessionId?: unknown;
      event?: unknown;
      frame?: unknown;
    };
    if (!this.helloSeen) {
      if (m.type === 'hello' && m.token === this.token) {
        this.helloSeen = true;
        for (const w of this.helloWaiters) w(true);
        this.helloWaiters.clear();
      } else {
        // Not our plugin (port collision) — reject so it stops retrying.
        sock.write(`${JSON.stringify({ type: 'reject' })}\n`);
        sock.destroy();
        if (this.socket === sock) this.socket = null;
      }
      return;
    }
    if (m.type === 'event' && typeof m.sessionId === 'string' && m.sessionId !== '') {
      const event = (m.event ?? {}) as Record<string, unknown>;
      if (event !== null && typeof event === 'object' && !Array.isArray(event)) {
        this.events.onEvent(m.sessionId, event);
      }
      return;
    }
    if (m.type === 'frame' && typeof m.sessionId === 'string' && m.sessionId !== '') {
      const frame = (m.frame ?? {}) as Record<string, unknown>;
      if (frame !== null && typeof frame === 'object' && !Array.isArray(frame)) {
        this.events.onFrame?.(m.sessionId, frame);
      }
    }
  }
}
