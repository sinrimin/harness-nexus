/**
 * #39 — while the TUI owns stdout, NOTHING may print to it: the daemon's
 * own console lines (boot banner, provisioning report, disconnect notices)
 * and any stray print from a dependency would land mid-frame and corrupt the
 * alternate screen. In TUI mode we replace the global console's log/warn/
 * error with logbook `log` entries — the ops pane renders them, ops.log
 * persists them, and `hnx logs --bundle` still carries them after the fact.
 * The restore function puts the originals back (exit paths call it before
 * printing the goodbye line).
 */

import { format } from 'node:util';
import { logLine } from '../daemon/logbook.js';

export function captureConsole(): () => void {
  const original = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  const redirect =
    (level: 'log' | 'warn' | 'error') =>
    (...args: unknown[]): void => {
      try {
        logLine(level, format(...args));
      } catch {
        // Formatting must never break the caller.
      }
    };
  console.log = redirect('log');
  console.warn = redirect('warn');
  console.error = redirect('error');
  return (): void => {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  };
}
