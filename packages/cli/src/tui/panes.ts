/**
 * #39 — the TUI pane renderers: pure functions from snapshots to display
 * lines (unit-tested; the app owns polling and subscriptions). Rendering
 * rules: every cell is clamped to its column (never wrapped), numbers are
 * right-aligned and ride the shared humanizers, and absence renders as '-'
 * (never a fabricated zero — the console honesty rule applies to the TUI too).
 */

import type { PrewarmView, SessionView } from '../daemon/chat.js';
import type { LogLineEntry, OpEntry } from '../daemon/logbook.js';
import type { UsageRow } from '../daemon/usage.js';
import { fmtCount, fmtDuration, fmtUsd } from './metrics.js';
import { padEnd, padStart, strWidth, truncateToWidth } from './width.js';

export const PANE_TITLES = {
  agents: 'agents & sessions',
  ops: 'ops log',
  comm: 'comm log',
  tokens: 'tokens (this daemon run)',
} as const;

// ---- agents & sessions ----

const COL_TARGET = 13;
const COL_SID = 9;
const COL_MODEL = 20;
const COL_STATE = 5;
const COL_AGE = 6;
const COL_TURNS = 4;
const COL_TOK = 8;

export function renderAgentsPane(
  sessions: SessionView[],
  prewarm: PrewarmView[],
  now: number,
): string[] {
  const lines: string[] = [];
  for (const p of prewarm) {
    lines.push(
      `${padEnd('warm', 5)}${padEnd(p.key, COL_TARGET)}${padEnd(p.state, COL_STATE)}${padStart(
        fmtDuration(p.ageMs / 1000),
        COL_AGE,
      )}`,
    );
  }
  for (const s of sessions) {
    const inOut = `${fmtCount(s.inputTokens)}/${fmtCount(s.outputTokens)}`;
    lines.push(
      `${padEnd(s.target, COL_TARGET)}${padEnd(s.sessionId.slice(0, 8), COL_SID)}${padEnd(
        s.model ?? '-',
        COL_MODEL,
      )}${padStart(s.busy ? 'BUSY' : 'idle', COL_STATE)}${padStart(
        fmtDuration((now - s.startedAt) / 1000),
        COL_AGE,
      )}${padStart(`${String(s.turns)}t`, COL_TURNS + 1)}${padStart(inOut, COL_TOK + COL_TOK + 1)}`,
    );
  }
  return lines;
}

// ---- tokens ----

const COL_NAME = 30;
const COL_FIELD = 9;

export function renderTokensPane(rows: UsageRow[]): string[] {
  const lines = [
    `${padEnd('target/model', COL_NAME)}${padStart('in', COL_FIELD)}${padStart('out', COL_FIELD)}${padStart(
      'cacheW',
      COL_FIELD,
    )}${padStart('cacheR', COL_FIELD)}${padStart('$', 8)}${padStart('ses', 5)}${padStart('turns', 7)}`,
  ];
  for (const r of rows) {
    lines.push(
      `${padEnd(`${r.target}/${r.model}`, COL_NAME)}${padStart(fmtCount(r.inputTokens), COL_FIELD)}${padStart(
        fmtCount(r.outputTokens),
        COL_FIELD,
      )}${padStart(fmtCount(r.cacheWriteTokens), COL_FIELD)}${padStart(
        fmtCount(r.cacheReadTokens),
        COL_FIELD,
      )}${padStart(fmtUsd(r.costUsd), 8)}${padStart(String(r.sessions), 5)}${padStart(String(r.turns), 7)}`,
    );
  }
  return lines;
}

// ---- ops / comm line formatting ----

/** `2026-09-30T10:20:30.123Z` → `10:20:30`. */
function hhmmss(iso: string): string {
  return iso.length >= 19 ? iso.slice(11, 19) : iso;
}

export function opsLine(e: OpEntry | LogLineEntry): string {
  if (e.kind === 'log') {
    return `${hhmmss(e.at)} [${e.level}] ${e.text}`;
  }
  return `${hhmmss(e.at)} op=${e.op} target=${e.target ?? '-'} outcome=${e.outcome} ms=${
    e.ms ?? '-'
  }${e.detail !== undefined ? ` ${e.detail}` : ''}`;
}

/** The aggregator's file-format line, shortened for the pane (date dropped). */
export function commDisplayLine(line: string): string {
  return line.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?Z? ?/, '$2 ');
}

// ---- box drawing ----

/**
 * One bordered band: `┌─ title ───── k ┐`, content rows (newest last, filled
 * or blanked to the box height), `└──┘`. Returns exactly `h` lines of
 * exactly `w` cells.
 */
export function drawPane(
  title: string,
  key: string,
  w: number,
  h: number,
  content: string[],
): string[] {
  const inner = Math.max(0, w - 2);
  const left = `┌─ ${truncateToWidth(title, Math.max(1, inner - 8))} `;
  const right = ` ${key} ┐`;
  const fill = Math.max(0, w - strWidth(left) - strWidth(right));
  const top = `${left}${'─'.repeat(fill)}${right}`;
  const bodyCount = Math.max(0, h - 2);
  const shown = content.slice(-bodyCount);
  const body: string[] = [];
  for (let i = 0; i < bodyCount; i++) {
    body.push(`│${padEnd(shown[i] ?? '', inner)}│`);
  }
  const bottom = `└${'─'.repeat(inner)}┘`;
  return [top, ...body, bottom];
}
