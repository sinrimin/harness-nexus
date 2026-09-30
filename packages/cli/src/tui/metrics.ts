/**
 * #39 — the machine metrics bar's data source. Zero dependencies beyond
 * node:os / node:fs: loadavg, CPU% (cpu-times delta between samples — the
 * first sample has no baseline and reports null, displayed as "--"), memory,
 * root-disk usage (statfs of the daemon's home), and the daemon's own RSS.
 * Child (adapter) processes' RSS would need ps — deliberately out of scope.
 */

import { statfsSync } from 'node:fs';
import { cpus, freemem, homedir, loadavg, totalmem, uptime, type CpuInfo } from 'node:os';

export interface MachineMetrics {
  /** Null until a second sample established the delta baseline. */
  cpuPct: number | null;
  loadAvg: [number, number, number];
  memTotalBytes: number;
  memUsedBytes: number;
  rssBytes: number;
  diskTotalBytes: number | null;
  diskUsedBytes: number | null;
  uptimeSec: number;
}

interface CpuTimes {
  idle: number;
  total: number;
}

function timesOf(list: CpuInfo[]): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of list) {
    idle += cpu.times.idle;
    total += cpu.times.idle + cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.irq;
  }
  return { idle, total };
}

export function sampleMachineMetrics(baseline?: CpuTimes): {
  metrics: MachineMetrics;
  baseline: CpuTimes;
} {
  const now = timesOf(cpus());
  let cpuPct: number | null = null;
  if (baseline !== undefined) {
    const idle = now.idle - baseline.idle;
    const total = now.total - baseline.total;
    if (total > 0) cpuPct = Math.round((1 - idle / total) * 100);
  }
  const memTotal = totalmem();
  let diskTotal: number | null = null;
  let diskUsed: number | null = null;
  try {
    const fs = statfsSync(homedir());
    diskTotal = fs.blocks * Number(fs.bsize);
    diskUsed = (fs.blocks - Number(fs.bfree)) * Number(fs.bsize);
  } catch {
    // Exotic filesystem / platform — hide the arm, show nothing.
  }
  return {
    metrics: {
      cpuPct,
      loadAvg: [loadavg()[0] ?? 0, loadavg()[1] ?? 0, loadavg()[2] ?? 0],
      memTotalBytes: memTotal,
      memUsedBytes: memTotal - freemem(),
      rssBytes: process.memoryUsage().rss,
      diskTotalBytes: diskTotal,
      diskUsedBytes: diskUsed,
      uptimeSec: uptime(),
    },
    baseline: now,
  };
}

// ---- formatting (shared with the pane renderers) ----

export function fmtCount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}G`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

export function fmtBytes(n: number): string {
  // 1024-based, matching the comm log's byte spelling (#38).
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)}G`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)}M`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}K`;
  return `${String(n)}B`;
}

export function fmtDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${String(d)}d${String(h)}h`;
  if (h > 0) return `${String(h)}h${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${String(m)}m${String(s % 60).padStart(2, '0')}s`;
  return `${String(s)}s`;
}

/** USD spend: cents resolution below a dollar, plain cents above. */
export function fmtUsd(n: number): string {
  return `$${n >= 1 ? n.toFixed(2) : n.toFixed(3)}`;
}
