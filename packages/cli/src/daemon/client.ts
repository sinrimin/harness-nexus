import { arch, homedir, hostname, platform } from 'node:os';
import { io } from 'socket.io-client';
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
import { attachChatHandlers } from './chat.js';
import { attachSessionsHandlers } from './sessions.js';
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

  socket.on('connect_error', (err: Error) => {
    // eslint-disable-next-line no-console
    console.error(`hnx daemon: connection error: ${err.message}`);
  });
  socket.on('disconnect', (reason: string) => {
    // eslint-disable-next-line no-console
    console.error(`hnx daemon: disconnected (${reason})`);
  });

  return new Promise((resolve) => {
    const stop = (): void => {
      socket.close();
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
