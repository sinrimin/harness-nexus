import { describe, expect, it } from 'vitest';
import { computeLayout } from '../src/tui/layout.js';
import { fmtBytes, fmtCount, fmtDuration } from '../src/tui/metrics.js';
import { padEnd, padStart, strWidth, truncateToWidth } from '../src/tui/width.js';

/** #39 — the TUI's pure geometry: CJK-aware widths, stacked-band layout. */

describe('width', () => {
  it('counts CJK as two cells, ASCII as one', () => {
    expect(strWidth('abc')).toBe(3);
    expect(strWidth('会话')).toBe(4);
    expect(strWidth('a会b')).toBe(4);
    expect(strWidth('カタカナ')).toBe(8);
    expect(strWidth('ｆｕｌｌ')).toBe(8); // fullwidth forms
    expect(strWidth('🎉')).toBe(2); // emoji plane
  });

  it('treats combining marks and control bytes as zero', () => {
    expect(strWidth('e\u0301')).toBe(1); // e + combining acute
    expect(strWidth('a\u0000b')).toBe(2);
    expect(strWidth('a\u200Db')).toBe(2); // ZWJ
  });

  it('truncates by display width without splitting a pair', () => {
    expect(truncateToWidth('会话日志', 5)).toBe('会话'); // 4 cells fit, 6 don't
    expect(truncateToWidth('abcdef', 3)).toBe('abc');
    expect(truncateToWidth('ab', 10)).toBe('ab');
  });

  it('pads to exact display width in both directions', () => {
    expect(padEnd('会', 5)).toBe('会   ');
    expect(padStart('会', 5)).toBe('   会');
    expect(padEnd('toolong', 3)).toBe('too');
  });
});

describe('computeLayout', () => {
  const panes = [
    { id: 'agents', minRows: 3 },
    { id: 'ops', minRows: 3 },
    { id: 'comm', minRows: 3 },
    { id: 'tokens', minRows: 3 },
  ];

  it('stacks header, metrics, panes, keybar and spreads leftover rows', () => {
    const layout = computeLayout(100, 20, true, panes);
    expect(layout.header).toEqual({ x: 0, y: 0, w: 100, h: 1 });
    expect(layout.metrics).toEqual({ x: 0, y: 1, w: 100, h: 1 });
    expect(layout.keybar).toEqual({ x: 0, y: 19, w: 100, h: 1 });
    expect(layout.panes.map((p) => p.id)).toEqual(['agents', 'ops', 'comm', 'tokens']);
    expect(layout.dropped).toEqual([]);
    // 17 rows between metrics and keybar, 12 minimum → 5 extras round-robin.
    expect(layout.panes.map((p) => p.rect.h)).toEqual([5, 4, 4, 4]);
    let y = 2;
    for (const p of layout.panes) {
      expect(p.rect.y).toBe(y);
      y += p.rect.h;
    }
    expect(y).toBe(19);
  });

  it('omits the metrics rect when toggled off', () => {
    const layout = computeLayout(100, 10, false, panes);
    expect(layout.metrics).toBeNull();
    expect(layout.panes[0]!.rect.y).toBe(1);
  });

  it('drops trailing panes that do not fit instead of crushing them', () => {
    const layout = computeLayout(80, 8, true, panes);
    // 8 rows: header 1 + metrics 1 + keybar 1 = 3 → 5 for panes: 3 + 2? No:
    // panes need 3 each, so one fits, two extra rows, rest dropped.
    expect(layout.panes.map((p) => p.id)).toEqual(['agents']);
    expect(layout.panes[0]!.rect.h).toBe(5);
    expect(layout.dropped).toEqual(['ops', 'comm', 'tokens']);
  });

  it('renders chrome only on a degenerate terminal', () => {
    const layout = computeLayout(40, 2, true, panes);
    expect(layout.panes).toEqual([]);
    expect(layout.dropped).toEqual(['agents', 'ops', 'comm', 'tokens']);
  });
});

describe('formatters', () => {
  it('humanizes token counts, byte counts, and durations', () => {
    expect(fmtCount(999)).toBe('999');
    expect(fmtCount(1_400_000)).toBe('1.4M');
    expect(fmtBytes(96 * 1024 * 1024)).toBe('96.0M');
    expect(fmtBytes(512)).toBe('512B');
    expect(fmtDuration(45)).toBe('45s');
    expect(fmtDuration(125)).toBe('2m05s');
    expect(fmtDuration(3 * 3600 + 12 * 60)).toBe('3h12m');
    expect(fmtDuration(2 * 86400 + 4 * 3600)).toBe('2d4h');
  });
});
