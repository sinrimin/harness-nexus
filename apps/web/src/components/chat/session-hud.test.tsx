// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '@/i18n';
import { SkinProvider } from '@/components/skin-provider';
import { SessionHud } from './session-hud';
import type { HudEditStats } from './hud-stats';

/**
 * #124/#128 — the HUD's mechanical contract: the fixed instrument face in the
 * reference order CTX · TOK · READ · WRITE · HIT · REQ · FILES, English
 * engraved labels in both locales with localized tooltips, `--` for unknown
 * readings, a real zero state for FILES, hairline rules inside the middle
 * cluster, the wide (16-segment) and phone (8-segment) gauges, and the CTX
 * popover. Visual correctness is the agent-browser pass.
 */

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    })),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.removeItem('hnx.lang');
});

function Providers({ children }: { children: ReactNode }) {
  return (
    <I18nProvider>
      <SkinProvider>
        <MemoryRouter>{children}</MemoryRouter>
      </SkinProvider>
    </I18nProvider>
  );
}

const files: HudEditStats = {
  files: 3,
  added: 42,
  removed: 7,
  pathless: false,
  list: [
    { path: 'src/a.ts', added: 30, removed: 5 },
    { path: 'docs/N.md', added: 12, removed: 2 },
  ],
};

const usage = { contextUsed: 34_100, contextSize: 200_000 };
const sessionUsage = {
  turns: 2,
  inputTokens: 5_000,
  outputTokens: 200,
  cacheReadTokens: 4_000,
  cacheWriteTokens: 1_000,
};

const cellsOf = (root: ParentNode) =>
  [...root.querySelectorAll('[data-slot="hud-cell"]')] as HTMLElement[];

describe('SessionHud', () => {
  it('the fixed face: every slot renders with no data — unknowns read --, FILES holds a real zero', () => {
    const { container } = render(
      <SessionHud usage={null} sessionUsage={null} files={null} historyPartial={false} />,
      { wrapper: Providers },
    );
    const hud = container.querySelector('[data-slot="session-hud"]');
    expect(hud).not.toBeNull();
    const slots = hud?.querySelectorAll('[data-slot="hud-slot"]');
    expect([...(slots ?? [])].map((s) => s.getAttribute('data-kind'))).toEqual([
      'ctx',
      'tok',
      'read',
      'write',
      'hit',
      'req',
      'files',
    ]);
    const cells = cellsOf(hud!);
    expect(cells.length).toBe(7);
    for (const kind of ['ctx', 'tok', 'read', 'write', 'hit', 'req']) {
      const cell = cells.find((c) => c.getAttribute('data-kind') === kind)!;
      expect(cell.getAttribute('data-unknown')).toBe('true');
      expect(cell.textContent).toContain('--');
    }
    const filesCell = cells.find((c) => c.getAttribute('data-kind') === 'files')!;
    expect(filesCell.getAttribute('data-zero')).toBe('true');
    expect(filesCell.textContent).toContain('FILES');
    expect(filesCell.textContent).toContain('0');
    expect(filesCell.textContent).toContain('+0');
    expect(filesCell.textContent).toContain('−0');

    // The CTX gauge keeps its two faces: 16 segments wide, 8 on the phone.
    const bars = hud?.querySelectorAll('[data-slot="hud-bar"]');
    expect([...(bars ?? [])].map((b) => b.getAttribute('data-compact'))).toEqual([
      'false',
      'true',
    ]);
    const wide = hud?.querySelector('[data-slot="hud-bar"][data-compact="false"]');
    const narrow = hud?.querySelector('[data-slot="hud-bar"][data-compact="true"]');
    expect(wide?.querySelectorAll('[data-slot="hud-seg"]').length).toBe(16);
    expect(narrow?.querySelectorAll('[data-slot="hud-seg"]').length).toBe(6);

    // Hairline rules sit INSIDE the middle cluster only (4 edges).
    expect(hud?.querySelectorAll('span.w-px').length).toBe(4);
  });

  it('renders every reading in the reference order', () => {
    const { container } = render(
      <SessionHud usage={usage} sessionUsage={sessionUsage} files={files} historyPartial={false} />,
      { wrapper: Providers },
    );
    const hud = container.querySelector('[data-slot="session-hud"]')!;
    const cells = cellsOf(hud);
    const text = (kind: string) =>
      cells.find((c) => c.getAttribute('data-kind') === kind)?.textContent ?? '';

    expect(text('ctx')).toContain('CTX');
    expect(text('ctx')).toContain('17%');
    expect(text('ctx')).toContain('34.1K/200K');
    // TOK = total through the session (in + out + cache read/written).
    expect(text('tok')).toContain('TOK');
    expect(text('tok')).toContain('10.2K');
    expect(text('read')).toContain('READ');
    expect(text('read')).toContain('4K');
    expect(text('write')).toContain('WRITE');
    expect(text('write')).toContain('1K');
    // 4000 / (5000 + 4000 + 1000) = 40%.
    expect(text('hit')).toContain('HIT');
    expect(text('hit')).toContain('40%');
    expect(text('req')).toContain('REQ');
    expect(text('req')).toContain('2');
    expect(text('files')).toContain('FILES');
    expect(text('files')).toContain('+42');
    expect(text('files')).toContain('−7');

    // The CTX gauge fills by pressure (17% of 16 = 3 segments).
    const on = hud.querySelectorAll('[data-slot="hud-bar"][data-compact="false"] [data-on="true"]');
    expect(on.length).toBe(3);

    // Tooltips carry the detailed sentences.
    expect(cells.find((c) => c.getAttribute('data-kind') === 'tok')?.getAttribute('title')).toContain(
      '10.2K total',
    );
    expect(cells.find((c) => c.getAttribute('data-kind') === 'hit')?.getAttribute('title')).toContain(
      '40%',
    );
    expect(cells.find((c) => c.getAttribute('data-kind') === 'req')?.getAttribute('title')).toContain(
      'Requests in this session: 2',
    );
  });

  it('keeps the labels English under zh while the tooltips localize', () => {
    localStorage.setItem('hnx.lang', 'zh');
    const { container } = render(
      <SessionHud usage={usage} sessionUsage={sessionUsage} files={files} historyPartial={false} />,
      { wrapper: Providers },
    );
    const hud = container.querySelector('[data-slot="session-hud"]')!;
    for (const label of ['CTX', 'TOK', 'READ', 'WRITE', 'HIT', 'REQ', 'FILES']) {
      expect(hud.textContent).toContain(label);
    }
    const readCell = cellsOf(hud).find((c) => c.getAttribute('data-kind') === 'read')!;
    expect(readCell.getAttribute('title')).toContain('缓存读取：4K');
    const reqCell = cellsOf(hud).find((c) => c.getAttribute('data-kind') === 'req')!;
    expect(reqCell.getAttribute('title')).toContain('本会话请求数：2');
    // Unknown is localized too.
    const { container: bare } = render(
      <SessionHud usage={null} sessionUsage={null} files={null} />,
      { wrapper: Providers },
    );
    const hitCell = cellsOf(bare.querySelector('[data-slot="session-hud"]')!).find(
      (c) => c.getAttribute('data-kind') === 'hit',
    )!;
    expect(hitCell.getAttribute('title')).toBe('暂无数据');
  });

  it('opens the shared context details from the CTX cell', () => {
    render(<SessionHud usage={usage} sessionUsage={null} files={null} historyPartial={false} />, {
      wrapper: Providers,
    });
    expect(screen.queryByText('Context window')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Context: 34\.1k of 200k tokens/ }));
    expect(screen.getByText('Context window')).toBeDefined();
    expect(screen.getByText('17% used')).toBeDefined();
  });

  it('bounds the FILES cell for pathological diffs (exact numbers stay in the title)', () => {
    const huge: HudEditStats = {
      files: 1_234,
      added: 52_345,
      removed: 12_890,
      pathless: false,
      list: [{ path: 'src/big.ts', added: 52_345, removed: 12_890 }],
    };
    const { container } = render(
      <SessionHud usage={null} sessionUsage={null} files={huge} historyPartial={false} />,
      { wrapper: Providers },
    );
    const cell = container.querySelector('[data-slot="hud-cell"][data-kind="files"]');
    expect(cell?.textContent).toContain('1.2K');
    expect(cell?.textContent).toContain('+52K');
    expect(cell?.textContent).toContain('−13K');
    expect(cell?.getAttribute('title')).toContain('52345');

    const nearMillion: HudEditStats = { ...huge, added: 999_999, removed: 0 };
    const { container: c2 } = render(
      <SessionHud usage={null} sessionUsage={null} files={nearMillion} historyPartial={false} />,
      { wrapper: Providers },
    );
    const nearCell = c2.querySelector('[data-slot="hud-cell"][data-kind="files"]');
    expect(nearCell?.textContent).toContain('+1M');
  });

  it('marks the FILES count as a lower bound when history is paged', () => {
    render(<SessionHud usage={null} sessionUsage={null} files={files} historyPartial />, {
      wrapper: Providers,
    });
    const fileCell = document.querySelector('[data-slot="hud-cell"][data-kind="files"]');
    expect(fileCell?.getAttribute('title')).toContain('older history not loaded');
    expect(fileCell?.getAttribute('title')).toContain('src/a.ts +30 −5');
  });

  it('a partial snapshot shows only what it reported — the rest stays --', () => {
    const { container } = render(
      <SessionHud
        usage={null}
        sessionUsage={{ turns: 1, inputTokens: 700 }}
        files={null}
      />,
      { wrapper: Providers },
    );
    const cells = cellsOf(container.querySelector('[data-slot="session-hud"]')!);
    const by = (kind: string) => cells.find((c) => c.getAttribute('data-kind') === kind)!;
    expect(by('tok').textContent).toContain('700');
    expect(by('read').textContent).toContain('--');
    expect(by('write').textContent).toContain('--');
    expect(by('hit').textContent).toContain('--');
    expect(by('req').textContent).toContain('1');
  });
});
