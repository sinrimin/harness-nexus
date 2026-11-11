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
 * #124 — the HUD's mechanical contract: English engraved labels in both
 * locales, a cell only when its source reported a value, the CTX cell opens
 * the shared details card, and the strip renders nothing at all when no
 * source has data. Visual correctness is the agent-browser pass.
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
  inputTokens: 500,
  outputTokens: 20,
  cacheReadTokens: 400,
  cacheWriteTokens: 100,
};

describe('SessionHud', () => {
  it('renders nothing when no source reported a value', () => {
    const { container } = render(
      <SessionHud usage={null} sessionUsage={null} files={null} historyPartial={false} />,
      { wrapper: Providers },
    );
    expect(container.querySelector('[data-slot="session-hud"]')).toBeNull();
  });

  it('keeps its labels English under the zh locale and formats every cell', () => {
    localStorage.setItem('hnx.lang', 'zh');
    const { container } = render(
      <SessionHud usage={usage} sessionUsage={sessionUsage} files={files} historyPartial={false} />,
      { wrapper: Providers },
    );
    const hud = container.querySelector('[data-slot="session-hud"]');
    expect(hud).not.toBeNull();
    expect(hud?.textContent).toContain('CTX');
    expect(hud?.textContent).toContain('TOK');
    expect(hud?.textContent).toContain('CACHE');
    expect(hud?.textContent).toContain('FILES');
    expect(hud?.textContent).toContain('17%');
    expect(hud?.textContent).toContain('34.1K/200K');
    expect(hud?.textContent).toContain('500');
    expect(hud?.textContent).toContain('20');
    // 400 / (500 + 400 + 100) = 40%.
    expect(hud?.textContent).toContain('40%');
    expect(hud?.textContent).toContain('+42');
    expect(hud?.textContent).toContain('−7');

    // Unknown fields never become zeros: a turn-only snapshot shows no TOK.
    const { container: bare } = render(
      <SessionHud usage={usage} sessionUsage={{ turns: 1 }} files={null} historyPartial={false} />,
      { wrapper: Providers },
    );
    const bareHud = bare.querySelector('[data-slot="session-hud"]');
    expect(bareHud?.textContent).toContain('CTX');
    expect(bareHud?.textContent).not.toContain('TOK');
    expect(bareHud?.textContent).not.toContain('CACHE');
    expect(bareHud?.textContent).not.toContain('FILES');
  });

  it('has no divider rules: the strip is one face, so a missing first cell leaves no leading mark', () => {
    // Full strip — nothing but the four cells at the top level.
    const { container } = render(
      <SessionHud usage={usage} sessionUsage={sessionUsage} files={files} historyPartial={false} />,
      { wrapper: Providers },
    );
    const hud = container.querySelector('[data-slot="session-hud"]');
    expect(hud?.children.length).toBe(4);
    expect(hud?.querySelectorAll('[data-slot="hud-cell"]').length).toBe(4);

    // No CTX report: the strip STARTS with the TOK cell (no leading rule).
    const { container: noCtx } = render(
      <SessionHud usage={null} sessionUsage={sessionUsage} files={files} historyPartial={false} />,
      { wrapper: Providers },
    );
    const strip = noCtx.querySelector('[data-slot="session-hud"]');
    expect(strip?.firstElementChild?.getAttribute('data-kind')).toBe('tok');
    expect(strip?.firstElementChild?.tagName).toBe('DIV');
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
    render(<SessionHud usage={null} sessionUsage={null} files={huge} historyPartial={false} />, {
      wrapper: Providers,
    });
    const cell = document.querySelector('[data-slot="hud-cell"][data-kind="files"]');
    expect(cell?.textContent).toContain('1.2K');
    expect(cell?.textContent).toContain('+52K');
    expect(cell?.textContent).toContain('−13K');
    // The exact figures remain available on the tooltip.
    expect(cell?.getAttribute('title')).toContain('52345');

    // Just under a million rounds to M, never the five-character "1000K".
    const nearMillion: HudEditStats = { ...huge, added: 999_999, removed: 0 };
    const { container } = render(
      <SessionHud usage={null} sessionUsage={null} files={nearMillion} historyPartial={false} />,
      { wrapper: Providers },
    );
    const nearCell = container.querySelector('[data-slot="hud-cell"][data-kind="files"]');
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
});
