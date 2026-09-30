/**
 * #39 — `hnx tui`: the daemon's console. One process runs BOTH the daemon
 * (in-process via startDaemon) and an nmon-style stacked-band dashboard:
 *
 *   header    machine · daemon version · server · uptime
 *   metrics   load · cpu · mem · disk · rss        (toggle m)
 *   agents    live channels + pre-warm pool        (toggle 1)
 *   ops       operation log + captured console     (toggle 2)
 *   comm      /ctl traffic, burst-collapsed        (toggle 3)
 *   tokens    per-(target, model) totals           (toggle t)
 *   keybar    the key legend, off-panes bracketed
 *
 * Data flow: ops/comm ride the #38 logbook bus (comm through its own
 * CommAggregator so the pane collapses bursts exactly like the file view);
 * agents/tokens poll the chat handle's snapshots; metrics samples node:os.
 * A 250ms repaint tick paints when dirty; every key repaints at once.
 * Non-TTY callers get `dumpTuiState` — one text snapshot, no screen takeover.
 */

import { CommAggregator, logbook, type LogbookEntry } from '../daemon/logbook.js';
import { DAEMON_VERSION, type DaemonHandle } from '../daemon/client.js';
import type { PrewarmView, SessionView } from '../daemon/chat.js';
import type { UsageRow } from '../daemon/usage.js';
import { captureConsole } from './console-capture.js';
import { computeLayout, type LayoutResult } from './layout.js';
import {
  commDisplayLine,
  drawPane,
  opsLine,
  PANE_TITLES,
  renderAgentsPane,
  renderTokensPane,
} from './panes.js';
import { Screen } from './screen.js';
import { fmtBytes, fmtDuration, sampleMachineMetrics, type MachineMetrics } from './metrics.js';
import { padEnd } from './width.js';

const PANE_ORDER = ['agents', 'ops', 'comm', 'tokens'] as const;
type PaneId = (typeof PANE_ORDER)[number];
const PANE_KEYS: Record<PaneId, string> = { agents: '1', ops: '2', comm: '3', tokens: 't' };

const OPS_RING = 200;
const COMM_RING = 200;
const POLL_MS = 1000;
const METRICS_MS = 2000;
const REPAINT_MS = 250;

export interface TuiHeader {
  machineId: string;
  serverHost: string;
}

export class TuiApp {
  #visible: Record<PaneId | 'metrics', boolean> = {
    agents: true,
    ops: true,
    comm: true,
    tokens: true,
    metrics: true,
  };
  #opsLines: string[] = [];
  #commLines: string[] = [];
  #commAgg = new CommAggregator((line) => {
    this.#pushBounded(this.#commLines, commDisplayLine(line), COMM_RING);
    this.#dirty = true;
  });
  #metrics: MachineMetrics | null = null;
  #baseline: ReturnType<typeof sampleMachineMetrics>['baseline'] | undefined;
  #startedAt = Date.now();
  #dirty = true;
  #resolveRun: (() => void) | null = null;
  #cleanup: Array<() => void> = [];
  #sessions: SessionView[] = [];
  #prewarm: PrewarmView[] = [];
  #usageRows: UsageRow[] = [];

  constructor(
    private readonly daemon: DaemonHandle,
    private readonly screen: Screen,
    private readonly header: TuiHeader,
  ) {}

  /** Interactive run; resolves when the user quits (q / Ctrl-C). */
  run(): Promise<void> {
    this.screen.enter();
    for (const entry of logbook.recent(OPS_RING + COMM_RING)) this.#busEntry(entry);
    this.#commAgg.flush();
    this.#cleanup.push(
      this.screen.onKey((k) => this.#onKey(k)),
      this.screen.onResize(() => {
        this.#dirty = true;
      }),
      logbook.subscribe((entry) => this.#busEntry(entry)),
    );
    const poll = setInterval(() => {
      this.#sessions = this.daemon.chat.sessionsSnapshot();
      this.#prewarm = this.daemon.chat.prewarmStatus();
      this.#usageRows = this.daemon.chat.usage.rows();
      this.#dirty = true;
    }, POLL_MS);
    poll.unref();
    const sample = setInterval(() => {
      const s = sampleMachineMetrics(this.#baseline);
      this.#baseline = s.baseline;
      this.#metrics = s.metrics;
      this.#dirty = true;
    }, METRICS_MS);
    sample.unref();
    const s0 = sampleMachineMetrics();
    this.#baseline = s0.baseline; // cpu% needs a second sample to diff against
    const repaint = setInterval(() => {
      if (this.#dirty) {
        this.#dirty = false;
        this.#paint();
      }
    }, REPAINT_MS);
    repaint.unref();
    this.#cleanup.push(() => {
      clearInterval(poll);
      clearInterval(sample);
      clearInterval(repaint);
      this.#commAgg.flush();
    });
    return new Promise<void>((resolve) => {
      this.#resolveRun = resolve;
    });
  }

  /** Tear down screen, timers, subscriptions. Idempotent. */
  stop(): void {
    for (const off of this.#cleanup.splice(0)) {
      try {
        off();
      } catch {
        // Cleanup must never throw.
      }
    }
    this.screen.exit();
  }

  /** Quit from outside the key stream (SIGINT when raw mode is unavailable). */
  requestQuit(): void {
    this.#quitNow();
  }

  #quitNow(): void {
    this.stop();
    this.#resolveRun?.();
    this.#resolveRun = null;
  }

  #busEntry(entry: LogbookEntry): void {
    if (entry.kind === 'op' || entry.kind === 'log') {
      this.#pushBounded(this.#opsLines, opsLine(entry), OPS_RING);
      this.#dirty = true;
    } else if (entry.kind === 'comm') {
      this.#commAgg.push(entry);
    }
  }

  #onKey(key: string): void {
    if (key === 'q' || key === 'ctrl-c') {
      this.#quitNow();
      return;
    }
    if (key === ' ') {
      this.#dirty = true;
    } else if (key === 'm') {
      this.#visible.metrics = !this.#visible.metrics;
    } else if (key === 'a') {
      const allOn = PANE_ORDER.every((p) => this.#visible[p]);
      for (const p of PANE_ORDER) this.#visible[p] = !allOn;
      this.#visible.metrics = !allOn;
    } else {
      const hit = PANE_ORDER.find((p) => PANE_KEYS[p] === key);
      if (hit === undefined) return;
      this.#visible[hit] = !this.#visible[hit];
    }
    this.#dirty = true;
    this.#paint();
  }

  #pushBounded(list: string[], line: string, cap: number): void {
    list.push(line);
    if (list.length > cap) list.splice(0, list.length - cap);
  }

  #paint(): void {
    const { w, h } = this.screen.size();
    const layout: LayoutResult = computeLayout(
      w,
      h,
      this.#visible.metrics,
      PANE_ORDER.filter((p) => this.#visible[p]).map((p) => ({ id: p, minRows: 3 })),
    );
    const content: Record<PaneId, string[]> = {
      agents: renderAgentsPane(this.#sessions, this.#prewarm, Date.now()),
      ops: this.#opsLines,
      comm: this.#commLines,
      tokens: renderTokensPane(this.#usageRows),
    };
    const lines: string[] = [this.#headerLine(w)];
    if (layout.metrics !== null) lines.push(this.#metricsLine(w));
    for (const pane of layout.panes) {
      const id = pane.id as PaneId;
      lines.push(
        ...drawPane(PANE_TITLES[id], PANE_KEYS[id], pane.rect.w, pane.rect.h, content[id]),
      );
    }
    while (lines.length < layout.keybar.y) lines.push(' '.repeat(w)); // dropped-pane rows stay blank
    lines.push(this.#keybarLine(w));
    this.screen.render(lines);
  }

  #headerLine(w: number): string {
    const up = fmtDuration((Date.now() - this.#startedAt) / 1000);
    const text = ` hnx tui — machine ${this.header.machineId.slice(0, 8)} · daemon ${DAEMON_VERSION} · server ${
      this.header.serverHost
    } · up ${up} · ses ${String(this.#sessions.length)}`;
    return padEnd(text, w);
  }

  #metricsLine(w: number): string {
    const m = this.#metrics;
    const arms =
      m === null
        ? ['metrics…']
        : [
            `load ${m.loadAvg.map((n) => n.toFixed(2)).join(' ')}`,
            `cpu ${m.cpuPct === null ? '--' : `${String(m.cpuPct)}%`}`,
            `mem ${fmtBytes(m.memUsedBytes)}/${fmtBytes(m.memTotalBytes)}`,
            m.diskTotalBytes !== null && m.diskUsedBytes !== null
              ? `disk ${fmtBytes(m.diskUsedBytes)}/${fmtBytes(m.diskTotalBytes)}`
              : 'disk --',
            `rss ${fmtBytes(m.rssBytes)}`,
          ];
    return padEnd(` ${arms.join(' · ')}`, w);
  }

  #keybarLine(w: number): string {
    const paneKey = (p: PaneId): string =>
      this.#visible[p] ? `${PANE_KEYS[p]} ${p}` : `(${PANE_KEYS[p]}) ${p}`;
    const text = ` ${PANE_ORDER.map(paneKey).join(' · ')} · m metrics · a all · space refresh · q quit`;
    return padEnd(text, w);
  }
}

/** Interactive entry: capture console, run the app, always restore. */
export function runTuiApp(daemon: DaemonHandle, screen: Screen, header: TuiHeader): Promise<void> {
  const restoreConsole = captureConsole();
  const app = new TuiApp(daemon, screen, header);
  // Raw mode normally swallows Ctrl-C as \x03 (handled as a key); this is
  // the fallback for the no-raw-mode degraded case.
  const onSig = (): void => app.requestQuit();
  process.once('SIGINT', onSig);
  return app.run().finally(() => {
    process.removeListener('SIGINT', onSig);
    app.stop();
    restoreConsole();
  });
}
