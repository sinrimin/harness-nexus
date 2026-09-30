import { existsSync, readFileSync, statSync } from 'node:fs';
import { platform, arch } from 'node:os';
import { writeFileSync } from 'node:fs';
import { cliVersion } from './version.js';
import { commLogPath, logsDir, opsLogPath } from './daemon/logbook.js';

/**
 * `hnx logs` (#38) — inspect the daemon's local logbook without remembering
 * where it lives. Default: print each file (ops.log, comm.log, plus their
 * rotated siblings) with size/mtime and a short tail. `--bundle <path>`
 * writes a single shareable text file (or `-` for stdout): a header with the
 * client/OS/Node build info plus a longer tail of each log — the artifact to
 * attach to a bug report.
 */

export interface LogsArgs {
  tail: number;
  bundle?: string;
}

const BUNDLE_TAIL = 200;

export function runLogsCommand(args: LogsArgs): number {
  const dir = logsDir();
  const files = collectLogFiles();

  // eslint-disable-next-line no-console
  console.log(`hnx logs — ${dir}`);
  if (files.length === 0) {
    // eslint-disable-next-line no-console
    console.log('  (no log files yet — start the daemon with: hnx daemon)');
    return 0;
  }

  const sections: string[] = [];
  for (const file of files) {
    const st = statSync(file);
    const name = file.slice(dir.length + 1);
    // eslint-disable-next-line no-console
    console.log(`  ${name}  ${fmtSize(st.size)}  ${st.mtime.toISOString()}`);
    const lines = tail(file, args.tail);
    if (lines.length > 0)
      sections.push(`${name} (last ${String(lines.length)}):\n${lines.join('\n')}`);
  }
  if (sections.length > 0) {
    // eslint-disable-next-line no-console
    console.log(`\n${sections.join('\n\n')}`);
  }

  if (args.bundle !== undefined) {
    const body = [
      `harness-nexus client ${cliVersion()} · ${platform()} ${arch()} · node ${process.version}`,
      `generated ${new Date().toISOString()}`,
      '',
      ...files.map(
        (f) =>
          `${f.slice(dir.length + 1)} (last ${String(BUNDLE_TAIL)} lines)\n${tail(f, BUNDLE_TAIL)}`,
      ),
    ].join('\n');
    if (args.bundle === '-') {
      // eslint-disable-next-line no-console
      console.log(`\n${body}`);
    } else {
      writeFileSync(args.bundle, `${body}\n`);
      // eslint-disable-next-line no-console
      console.log(`\nbundle written: ${args.bundle}`);
    }
  }
  return 0;
}

/** ops.log/comm.log plus their rotated `.N` siblings that exist on disk. */
function collectLogFiles(): string[] {
  const out: string[] = [];
  for (const base of [opsLogPath(), commLogPath()]) {
    if (existsSync(base)) out.push(base);
    for (let i = 1; i <= 5; i++) {
      const rotated = `${base}.${String(i)}`;
      if (existsSync(rotated)) out.push(rotated);
    }
  }
  return out;
}

function tail(file: string, n: number): string[] {
  const lines = readFileSync(file, 'utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-n);
}

function fmtSize(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${String(n)}B`;
}
