/**
 * #39 — the `hnx tui` command: interactive dashboard by default, one-shot
 * text snapshot with --dump (or automatically when stdout is not a TTY —
 * scripts get the data, never a broken alt-screen).
 */

import { startDaemon, type DaemonHandle } from '../daemon/client.js';
import { CommAggregator, logbook } from '../daemon/logbook.js';
import { runTuiApp } from './app.js';
import { commDisplayLine, opsLine, renderAgentsPane, renderTokensPane } from './panes.js';
import { Screen } from './screen.js';
import { fmtBytes, fmtDuration, sampleMachineMetrics } from './metrics.js';

export interface TuiCommandArgs {
  server: string;
  token: string;
  machineId: string;
  dump: boolean;
}

function serverHost(server: string): string {
  try {
    return new URL(server).host;
  } catch {
    return server;
  }
}

/** How long the dump waits for hello + first snapshots before printing. */
const DUMP_SETTLE_MS = 1500;

export async function runTuiCommand(args: TuiCommandArgs): Promise<number> {
  const ttyError = Screen.ttyError(process.stdout, process.stdin);
  if (args.dump || ttyError !== null) {
    if (ttyError !== null && !args.dump) {
      process.stdout.write(`hnx tui: ${ttyError} — printing a one-shot snapshot instead.\n`);
    }
    const daemon = startDaemon({
      server: args.server,
      token: args.token,
      machineId: args.machineId,
    });
    try {
      await new Promise((r) => setTimeout(r, DUMP_SETTLE_MS));
      dumpTuiState(daemon, args.machineId);
    } finally {
      daemon.stop();
    }
    return 0;
  }

  const daemon = startDaemon({
    server: args.server,
    token: args.token,
    machineId: args.machineId,
  });
  const screen = new Screen(process.stdout, process.stdin);
  try {
    await runTuiApp(daemon, screen, {
      machineId: args.machineId,
      serverHost: serverHost(args.server),
    });
  } finally {
    daemon.stop();
  }
  process.stdout.write('hnx tui: stopped.\n');
  return 0;
}

/** One-shot text snapshot (dump mode / non-TTY). */
function dumpTuiState(daemon: DaemonHandle, machineId: string): void {
  const out: string[] = [];
  const m = sampleMachineMetrics().metrics;
  out.push(
    `hnx tui snapshot — machine ${machineId.slice(0, 8)} · load ${m.loadAvg
      .map((n) => n.toFixed(2))
      .join(' ')} · mem ${fmtBytes(m.memUsedBytes)}/${fmtBytes(m.memTotalBytes)} · rss ${fmtBytes(
      m.rssBytes,
    )} · up ${fmtDuration(m.uptimeSec)}`,
  );

  const sessions = daemon.chat.sessionsSnapshot();
  const prewarm = daemon.chat.prewarmStatus();
  out.push(
    '',
    `agents & sessions (${String(sessions.length)} channel(s), ${String(prewarm.length)} warm):`,
  );
  const agents = renderAgentsPane(sessions, prewarm, Date.now());
  out.push(...(agents.length > 0 ? agents.map((l) => `  ${l}`) : ['  (none)']));

  const rows = daemon.chat.usage.rows();
  out.push('', 'tokens (this daemon run):');
  out.push(
    ...(rows.length > 0 ? renderTokensPane(rows).map((l) => `  ${l}`) : ['  (no usage reported)']),
  );

  const ops = logbook
    .recent(60)
    .filter((e) => e.kind === 'op' || e.kind === 'log')
    .map((e) => opsLine(e as Parameters<typeof opsLine>[0]));
  out.push('', 'recent ops:');
  out.push(...(ops.length > 0 ? ops.slice(-12).map((l) => `  ${l}`) : ['  (none)']));

  const commLines: string[] = [];
  const agg = new CommAggregator((line) => commLines.push(commDisplayLine(line)));
  for (const entry of logbook.recent(120)) {
    if (entry.kind === 'comm') agg.push(entry);
  }
  agg.flush();
  out.push('', 'recent comm:');
  out.push(...(commLines.length > 0 ? commLines.slice(-12).map((l) => `  ${l}`) : ['  (none)']));

  process.stdout.write(`${out.join('\n')}\n`);
}
