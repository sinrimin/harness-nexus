import { arch, homedir, hostname, platform } from 'node:os';
import { io, type Socket } from 'socket.io-client';
import {
  compareVersions,
  inventoryCollectRequestSchema,
  inventoryScanRequestSchema,
  runtimeConfigGetRequestSchema,
  workspaceListRequestSchema,
  type InventorySnapshot,
  type MachineHelloAck,
} from '@harness-nexus/shared';
import { collectItems, scanAllTargets, scanTarget, scannerFor } from '../inventory/scan.js';
import { probeRuntimes } from '../inventory/runtime.js';
import { runtimeConfigViewPayload } from './config-view.js';
import { listDirectories, listFiles } from './workspace.js';
import { sweepAdapterLedger } from './adapter-ledger.js';
import { attachCommLog, logOp } from './logbook.js';
import { provisionAdapters } from './acp/adapter-provision.js';
import { attachJobHandlers } from './jobs.js';
import { attachChatHandlers, type ChatHandlersHandle } from './chat.js';
import { attachSessionsHandlers } from './sessions.js';
import { acquireDaemonLock } from './lock.js';
import { InstallError } from '../errors.js';
import { cliVersion } from '../version.js';

/** Client daemon version (#37) — the CLI package version, reported in every
 * `machine:hello` and compared against the server's on connect. */
export const DAEMON_VERSION = cliVersion();

/**
 * Capabilities this daemon build carries (C3: inventory; C4: deploy; C5:
 * chat; 9 W1: runtime probe; 9 W2: harness install/upgrade/pin jobs;
 * 9 W3: provider-config apply; 9 W4: redacted config view; 9 W6: workspace
 * directory listing for the chat picker; 9 W7: native session list/resume;
 * 9 W9: session-config selectors, prompt images, workspace files;
 * #6: claude-code marketplace deploys via the local `claude` CLI).
 */
export const DAEMON_CAPABILITIES = [
  'inventory',
  'deploy',
  'chat',
  'runtime',
  'harness',
  'runtime-config',
  'runtime-config-view',
  'workspace',
  'sessions',
  'marketplace-deploy',
];

/** Placeholder snapshot for a target this daemon build has no scanner for. */
export function emptySnapshot(target: InventorySnapshot['target']): InventorySnapshot {
  const home = `~/.${target}`;
  return {
    target,
    scannedAt: new Date().toISOString(),
    agents: [{ name: home, directory: home, profileApplied: false, items: [] }],
  };
}

export interface DaemonOptions {
  server: string;
  /** Machine PAT (scopes ['machine-ctl']). */
  token: string;
  machineId: string;
  /**
   * #45 — invoked when the server rules this daemon must stand down (a second
   * daemon socket per machine means every prompt and dispatched job would run
   * twice). Defaults to exiting the process; the TUI keeps the default too —
   * there is no meaningful degraded mode for a duplicate daemon.
   */
  onFatal?: (message: string) => void;
}

/** What `startDaemon` hands back: everything the TUI (#39) needs in-process. */
export interface DaemonHandle {
  socket: Socket;
  /** #39 — the chat manager's introspection surface (TUI panes). */
  chat: ChatHandlersHandle;
  /** Close the socket and release the daemon lock. Idempotent. */
  stop(): void;
}

/**
 * Boot the daemon WITHOUT owning the process lifetime: connect, attach every
 * handler, take the daemon lock. The TUI runs this in-process; `runDaemon`
 * wraps it for the classic wait-forever `hnx daemon`.
 *
 * Throws InstallError (DAEMON_LOCKED) when another daemon-owning process
 * holds the machine — two /ctl sockets would double-run every dispatched job.
 */
export function startDaemon(options: DaemonOptions): DaemonHandle {
  const lock = acquireDaemonLock(homedir());
  if (!lock.ok) {
    throw new InstallError(
      `Another daemon is already running (pid ${String(lock.pid)}) — stop it first.`,
      'DAEMON_LOCKED',
    );
  }

  // 9 W11 A — boot sweep BEFORE anything here can spawn an adapter: every
  // still-alive process group in the ledger was orphaned by a previous
  // instance's hard death (SIGKILL/OOM skips every teardown path while the
  // detached groups survive it), or is mid-grace from an interrupted
  // shutdown — either way the sweep finishes the reap. Safe by construction:
  // the ledger only ever holds pgids this user's daemon created, and no new
  // one exists yet to collide with.
  const swept = sweepAdapterLedger(homedir());
  if (swept.reaped > 0 || swept.dropped > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `hnx daemon: adapter sweep — reaped ${String(swept.reaped)} orphaned group(s), dropped ${String(swept.dropped)} stale ledger entries`,
    );
  }

  // Issue #2 — pinned adapter provisioning (once per machine, then only
  // patch re-checks). Fire-and-forget: npx stays the spawn path until it
  // lands, and any failure just leaves that fallback in place.
  if (process.env.HN_ACP_NO_AUTO_PROVISION !== '1') {
    const provisionStartedAt = Date.now();
    void provisionAdapters(homedir())
      .then((r) => {
        // eslint-disable-next-line no-console
        console.log(
          `hnx daemon: adapter provisioning — ${r.installed ? 'installed pinned adapters' : 'pinned adapters present'}${r.applied.length > 0 ? `, patches applied: ${r.applied.join(', ')}` : ''}${r.already.length > 0 ? `, patches already in place: ${r.already.join(', ')}` : ''}${r.failed.length > 0 ? `, patch issues: ${r.failed.map((f) => `${f.id} (${f.reason})`).join('; ')}` : ''}${r.error !== undefined ? ` — install FAILED (${r.error}), npx fallback stays` : ''}`,
        );
        // #38 — the operation trail remembers installs even when the console
        // scrollback is long gone.
        logOp({
          op: r.installed ? 'adapter-provision' : 'adapter-provision-check',
          outcome: r.error !== undefined ? 'error' : 'ok',
          ms: Date.now() - provisionStartedAt,
          ...(r.error !== undefined ? { detail: r.error } : {}),
        });
      })
      .catch((e: unknown) => {
        logOp({
          op: 'adapter-provision',
          outcome: 'error',
          ms: Date.now() - provisionStartedAt,
          detail: e instanceof Error ? e.message : String(e),
        });
      });
  }

  const socket = io(`${options.server}/ctl`, {
    auth: { token: options.token, machineId: options.machineId },
    transports: ['websocket'],
  });
  // #38 — every packet lands in ~/.hnx/logs/comm.log (metadata level; see
  // logbook.ts for the payload escape hatch).
  attachCommLog(socket);

  attachJobHandlers(socket, { server: options.server, token: options.token });
  // Issue #2 — the sessions listing reuses a live channel's adapter
  // connection instead of spawning a fresh one per rail paint.
  const chat = attachChatHandlers(socket);
  attachSessionsHandlers(socket, { liveConnectionFor: chat.liveConnectionFor });

  const reportAll = (requestId?: string): void => {
    void (async () => {
      // One runtime probe per scan cycle (Phase 9 W1) — folded into EVERY
      // report so each target's row carries its own runtime arm.
      const runtimes = await probeRuntimes().catch(() => undefined);
      for (const snapshot of scanAllTargets()) {
        socket.emit('inventory:report', {
          ...(requestId ? { requestId } : {}),
          ...(runtimes ? { runtimes } : {}),
          snapshot,
        });
      }
    })();
  };

  socket.on('connect', () => {
    socket.emit(
      'machine:hello',
      {
        daemonVersion: DAEMON_VERSION,
        os: platform(),
        arch: arch(),
        hostname: hostname(),
        capabilities: DAEMON_CAPABILITIES,
      },
      (res: unknown) => {
        const ack = res as MachineHelloAck | { error: string };
        if (ack && 'error' in ack) {
          // eslint-disable-next-line no-console
          console.error(`hnx daemon: hello rejected: ${ack.error}`);
          return;
        }
        const hello = ack as MachineHelloAck;
        // eslint-disable-next-line no-console
        console.log(
          `hnx daemon: online (cli ${DAEMON_VERSION}, proto ${hello.proto}, machine ${hello.machineId})`,
        );
        // #37 — an older CLI warns once per connect (never blocks: the proto
        // number above is the compatibility gate, and the five packages
        // version in lockstep so a skew means an un-upgraded client).
        if (
          hello.serverVersion !== undefined &&
          compareVersions(DAEMON_VERSION, hello.serverVersion) < 0
        ) {
          // eslint-disable-next-line no-console
          console.warn(
            `hnx daemon: client ${DAEMON_VERSION} is older than server ${hello.serverVersion} — upgrade with: npm install -g @harness-nexus/cli@latest`,
          );
        }
        reportAll();
      },
    );
  });

  socket.on('inventory:scan', (payload: unknown, ack?: (res: unknown) => void) => {
    const parsed = inventoryScanRequestSchema.safeParse(payload);
    if (!parsed.success) {
      ack?.({ error: 'proto:invalid' });
      return;
    }
    ack?.({ accepted: true });
    const { requestId, targets } = parsed.data;
    void (async () => {
      // One runtime probe per scan cycle (Phase 9 W1) — folded into every
      // report so each target's row carries its own runtime arm.
      const runtimes = await probeRuntimes().catch(() => undefined);
      for (const target of targets) {
        // No scanner for this target on this build — still report the empty
        // shape so the server's waiter never hangs on it.
        const snapshot = scannerFor(target) ? scanTarget(target) : emptySnapshot(target);
        socket.emit('inventory:report', {
          requestId,
          ...(runtimes ? { runtimes } : {}),
          snapshot,
        });
      }
    })();
  });

  socket.on('inventory:collect', (payload: unknown, ack?: (res: unknown) => void) => {
    const parsed = inventoryCollectRequestSchema.safeParse(payload);
    if (!parsed.success) {
      ack?.({ error: 'proto:invalid' });
      return;
    }
    ack?.({ accepted: true });
    const { requestId, target, items } = parsed.data;
    void (async () => {
      // Bodies are read fresh (paths re-derived) and secrets redacted
      // daemon-side before anything crosses the wire.
      const payloadItems = await collectItems(target, items);
      socket.emit('inventory:payload', { requestId, items: payloadItems });
    })();
  });

  // 9 W4 — redacted effective-config read-back. Masking happens HERE, before
  // anything crosses the wire (the same rule as inventory collect).
  socket.on('runtime:config.get', (payload: unknown, ack?: (res: unknown) => void) => {
    const parsed = runtimeConfigGetRequestSchema.safeParse(payload);
    if (!parsed.success) {
      ack?.({ error: 'proto:invalid' });
      return;
    }
    ack?.({ accepted: true });
    try {
      socket.emit('runtime:config', {
        requestId: parsed.data.requestId,
        ...runtimeConfigViewPayload(parsed.data.target),
      });
    } catch (e) {
      socket.emit('runtime:config', {
        requestId: parsed.data.requestId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  // 9 W6 — one level of subdirectories under the (server-validated) base
  // workspace path, for the chat session's directory picker.
  socket.on('workspace:list', (payload: unknown, ack?: (res: unknown) => void) => {
    const parsed = workspaceListRequestSchema.safeParse(payload);
    if (!parsed.success) {
      ack?.({ error: 'proto:invalid' });
      return;
    }
    ack?.({ accepted: true });
    void (async () => {
      try {
        // 9 W9 C — files ride next to the directories (the picker surfaces
        // them; the W6 dir-picker ignores them). One readdir would be nicer,
        // but the listing is capped and rare — keep the helpers simple.
        const [directories, files] = await Promise.all([
          listDirectories(parsed.data.path),
          listFiles(parsed.data.path),
        ]);
        socket.emit('workspace:list', {
          requestId: parsed.data.requestId,
          directories,
          files,
        });
      } catch (e) {
        socket.emit('workspace:list', {
          requestId: parsed.data.requestId,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })();
  });

  // #45 — the server refuses a second daemon socket per machine. A refusal
  // CAN be transient (a blip whose stale socket has not timed out yet), so
  // retries ride the normal reconnect backoff; but a persistent refusal means
  // another daemon genuinely owns this machine — after enough consecutive
  // ones there is nothing to do but stand down (running anyway would bill
  // every prompt twice and run every dispatched job twice).
  const ALREADY_CONNECTED_LIMIT = 10;
  let alreadyConnectedStreak = 0;
  let fatalFired = false;
  const fatal = (message: string): void => {
    if (fatalFired) return;
    fatalFired = true;
    // eslint-disable-next-line no-console
    console.error(`hnx daemon: ${message}`);
    (options.onFatal ?? ((_: string) => process.exit(1)))(message);
  };

  socket.on('connect', () => {
    alreadyConnectedStreak = 0;
  });
  socket.on('connect_error', (err: Error) => {
    if (err.message.includes('machine already connected')) {
      alreadyConnectedStreak += 1;
      // eslint-disable-next-line no-console
      console.error(
        `hnx daemon: server refuses this machine's second daemon socket ` +
          `(attempt ${String(alreadyConnectedStreak)}/${String(ALREADY_CONNECTED_LIMIT)}) — ` +
          `another daemon is live, or a stale socket has not timed out yet`,
      );
      if (alreadyConnectedStreak >= ALREADY_CONNECTED_LIMIT) {
        fatal(
          'another daemon holds this machine (10 straight refusals) — stop it ' +
            '(or remove a stale ~/.hnx/daemon.lock) before starting this one',
        );
        return;
      }
      // Socket.IO treats a middleware refusal as PERMANENT (it tears the
      // manager down instead of retrying, and an idle daemon process then
      // exits). A refusal can be transient — a blip whose stale socket has
      // not timed out yet (~ping timeout) — so this daemon retries itself,
      // long enough to outlive any stale socket. NOT unref'd: this timer is
      // what keeps a rejected-but-not-yet-fatal daemon alive.
      const delay = Math.min(2000 * 2 ** (alreadyConnectedStreak - 1), 30000);
      setTimeout(() => socket.connect(), delay);
      return;
    }
    alreadyConnectedStreak = 0;
    // eslint-disable-next-line no-console
    console.error(`hnx daemon: connection error: ${err.message}`);
  });
  // The post-handshake duplicate fence disconnects us with this event; the
  // reason fallback covers a lost event packet.
  socket.on('ctl:duplicate', () => {
    fatal(
      'the server stood this daemon down: another daemon socket already holds ' +
        'this machine (duplicate /ctl socket refused)',
    );
  });
  socket.on('disconnect', (reason: string) => {
    if (reason === 'io server disconnect') {
      // Server-initiated and NOT the duplicate fence's delayed teardown
      // (that one exits through ctl:duplicate above): still fatal — a daemon
      // the server cut loose must not linger socketless forever.
      fatal(`server disconnected this daemon (${reason})`);
      return;
    }
    // eslint-disable-next-line no-console
    console.error(`hnx daemon: disconnected (${reason})`);
  });

  let stopped = false;
  return {
    socket,
    chat,
    stop: (): void => {
      if (stopped) return;
      stopped = true;
      socket.close();
      lock.release();
    },
  };
}

/**
 * The on-demand Harness Nexus daemon (Phase 8 C1): connects to the server's
 * `/ctl` namespace, says `machine:hello` on every (re)connect so presence and
 * metadata stay fresh, and stays attached until SIGINT/SIGTERM. Socket.IO
 * handles reconnection with backoff; each reconnect re-runs hello and — since
 * C3 — re-reports every target's inventory (fresh snapshots whenever the
 * daemon comes up).
 *
 * The machine shows online exactly while this process is running — that is
 * the honest-presence contract; MCP serving (C2) does NOT depend on it.
 */
export function runDaemon(options: DaemonOptions): Promise<void> {
  const daemon = startDaemon(options);
  return new Promise((resolve) => {
    const stop = (): void => {
      daemon.stop();
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
