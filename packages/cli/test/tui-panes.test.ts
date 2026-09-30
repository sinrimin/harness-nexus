import { describe, expect, it } from 'vitest';
import type { PrewarmView, SessionView } from '../src/daemon/chat.js';
import type { UsageRow } from '../src/daemon/usage.js';
import {
  commDisplayLine,
  drawPane,
  opsLine,
  renderAgentsPane,
  renderTokensPane,
} from '../src/tui/panes.js';
import { strWidth } from '../src/tui/width.js';

/** #39 — pane renderers: column discipline, honesty ('-' not 0), box math. */

const NOW = 1_800_000_000_000;

describe('renderAgentsPane', () => {
  it('lists prewarm rows and session rows with clamped columns', () => {
    const prewarm: PrewarmView[] = [{ key: 'claude-code', state: 'ready', ageMs: 41_000 }];
    const sessions: SessionView[] = [
      {
        sessionId: 'f3c9aa11-2222',
        acpSessionId: 'native-1',
        target: 'claude-code',
        command: 'node adapter.js',
        startedAt: NOW - 12 * 60_000,
        busy: true,
        model: 'sonnet-4.6-with-a-very-long-name',
        turns: 18,
        inputTokens: 412_000,
        outputTokens: 21_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        events: 400,
      },
      {
        sessionId: '77a1',
        acpSessionId: 'n2',
        target: 'pi',
        command: 'pi',
        startedAt: NOW - 41 * 60_000,
        busy: false,
        model: null,
        turns: 3,
        inputTokens: 9_000,
        outputTokens: 2_000,
        cacheReadTokens: 6_100_000,
        cacheWriteTokens: 0,
        events: 40,
      },
    ];
    const lines = renderAgentsPane(sessions, prewarm, NOW);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('warm');
    expect(lines[0]).toContain('claude-code');
    expect(lines[0]).toContain('ready');
    expect(lines[0]).toContain('41s');
    expect(lines[1]).toContain('BUSY');
    expect(lines[1]).toContain('f3c9aa11');
    expect(lines[1]).toContain('412.0k/21.0k');
    expect(lines[2]).toContain('idle');
    expect(lines[2]).toContain(' - '); // model unknown renders '-', never fabricated
  });
});

describe('renderTokensPane', () => {
  it('renders a header plus one row per (target, model) with right-aligned counts', () => {
    const rows: UsageRow[] = [
      {
        target: 'claude-code',
        model: 'sonnet-4.6',
        turns: 41,
        inputTokens: 1_200_000,
        outputTokens: 84_000,
        cacheReadTokens: 3_400_000,
        cacheWriteTokens: 210_000,
        costUsd: 1.25,
        sessions: 3,
        lastAt: '2026-09-30T12:00:00.000Z',
      },
    ];
    const lines = renderTokensPane(rows);
    expect(lines[0]).toContain('target/model');
    expect(lines[0]).toContain('$');
    expect(lines[1]).toContain('claude-code/sonnet-4.6');
    expect(lines[1]).toContain('1.2M');
    expect(lines[1]).toContain('84.0k');
    expect(lines[1]).toContain('3.4M');
    expect(lines[1]).toContain('210.0k');
    expect(lines[1]).toContain('$1.25');
  });
});

describe('line formatting', () => {
  it('opsLine formats op and captured-console entries', () => {
    expect(
      opsLine({
        kind: 'op',
        at: '2026-09-30T12:01:33.123Z',
        op: 'install',
        target: 'claude-code',
        outcome: 'ok',
        ms: 240,
      }),
    ).toBe('12:01:33 op=install target=claude-code outcome=ok ms=240');
    expect(
      opsLine({ kind: 'log', at: '2026-09-30T12:04:10.000Z', level: 'warn', text: 'provisioned' }),
    ).toBe('12:04:10 [warn] provisioned');
  });

  it('commDisplayLine drops the date but keeps the burst summary shape', () => {
    expect(commDisplayLine('2026-09-30T12:05:02.987Z tx chat:event 2.1KB')).toBe(
      '12:05:02 tx chat:event 2.1KB',
    );
    expect(
      commDisplayLine('2026-09-30T12:05:02.987Z tx chat:event ×200 total 402.0KB over 3.4s'),
    ).toBe('12:05:02 tx chat:event ×200 total 402.0KB over 3.4s');
  });
});

describe('drawPane', () => {
  it('draws an exact-width box, content top-aligned, short content blank-filled', () => {
    const lines = drawPane('ops log', '2', 30, 6, ['one', 'two']);
    expect(lines).toHaveLength(6);
    for (const l of lines) expect(strWidth(l)).toBe(30);
    expect(lines[0].startsWith('┌─ ops log ')).toBe(true);
    expect(lines[0].endsWith('2 ┐')).toBe(true);
    expect(lines[1]).toBe(`│${'one'.padEnd(28)}│`);
    expect(lines[3]).toBe(`│${' '.repeat(28)}│`); // blank-filled
    expect(lines[4]).toBe(`│${' '.repeat(28)}│`);
    expect(lines[5]).toBe(`└${'─'.repeat(28)}┘`);
  });

  it('shows only the tail rows when content exceeds the box', () => {
    const lines = drawPane('comm log', '3', 20, 4, ['a', 'b', 'c', 'd', 'e']);
    expect(lines[1]).toContain('d');
    expect(lines[2]).toContain('e');
    expect(lines.some((l) => l.includes('a'))).toBe(false);
  });

  it('clamps CJK content to the inner width without wrapping', () => {
    const lines = drawPane('agents', '1', 12, 3, ['会话日志很长很长很长']);
    expect(lines).toHaveLength(3);
    for (const l of lines) expect(strWidth(l)).toBe(12);
  });
});
