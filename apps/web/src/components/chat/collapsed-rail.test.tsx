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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { CollapsedRail, RailMenuRow, useRailCollapsed } from './collapsed-rail';

/**
 * #122/#126 — the collapsed rail's mechanical contract: the collapse is ONE
 * persisted preference shared by both chat ends (the agent end grew it first;
 * #126 brought the assistant end onto it), the tiles are the pinned sessions
 * with the labels moved to tooltips, and the new-session door follows the
 * expanded rail's gate. Visual correctness is the agent-browser pass.
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
  localStorage.removeItem('hnx.railCollapsed');
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

/** Two mounts = the two chat ends reading the same storage key. */
function FlagProbe({ onRead }: { onRead: (v: boolean) => void }) {
  const [collapsed, toggle] = useRailCollapsed();
  onRead(collapsed);
  return (
    <button type="button" onClick={toggle}>
      toggle
    </button>
  );
}

describe('useRailCollapsed', () => {
  it('defaults open, persists the toggle under hnx.railCollapsed', () => {
    const seen: boolean[] = [];
    const { unmount } = render(<FlagProbe onRead={(v) => seen.push(v)} />, { wrapper: Providers });
    expect(seen.at(-1)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'toggle' }));
    expect(seen.at(-1)).toBe(true);
    expect(localStorage.getItem('hnx.railCollapsed')).toBe('1');
    // The other end mounts fresh and reads the SAME preference.
    unmount();
    render(<FlagProbe onRead={(v) => seen.push(v)} />, { wrapper: Providers });
    expect(seen.at(-1)).toBe(true);
  });

  it('a corrupt/persisted-off value reads open without throwing', () => {
    localStorage.setItem('hnx.railCollapsed', '0');
    const seen: boolean[] = [];
    render(<FlagProbe onRead={(v) => seen.push(v)} />, { wrapper: Providers });
    expect(seen.at(-1)).toBe(false);
  });
});

describe('CollapsedRail', () => {
  const tiles = [
    {
      id: 's1',
      label: 'demo-api',
      detail: '/root/projects/demo-api',
      active: true,
      onClick: vi.fn(),
    },
    { id: 's2', label: 'Survey', active: false, onClick: vi.fn() },
  ];

  it('renders the pinned sessions as first-character tiles with tooltips', () => {
    render(
      <CollapsedRail
        tiles={tiles}
        newSessionLabel="New session"
        onNewSession={vi.fn()}
        onExpand={vi.fn()}
      />,
      { wrapper: Providers },
    );
    const first = screen.getByRole('button', { name: 'demo-api' });
    expect(first.textContent).toBe('d');
    expect(first.getAttribute('title')).toBe('demo-api\n/root/projects/demo-api');
    expect(first.getAttribute('aria-current')).toBe('true');
    const second = screen.getByRole('button', { name: 'Survey' });
    expect(second.getAttribute('title')).toBe('Survey');
    expect(second.getAttribute('aria-current')).toBeNull();
  });

  it('the doors: expand and new session fire, the gate disables new session', () => {
    const onExpand = vi.fn();
    const onNewSession = vi.fn();
    const { rerender } = render(
      <CollapsedRail
        tiles={tiles}
        newSessionLabel="New session"
        onNewSession={onNewSession}
        onExpand={onExpand}
      />,
      { wrapper: Providers },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Expand session rail' }));
    expect(onExpand).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    expect(onNewSession).toHaveBeenCalledTimes(1);
    // The expanded rail's gate reaches the collapsed door too (#126).
    // (rerender re-applies the wrapper itself — bare element here.)
    rerender(
      <CollapsedRail
        tiles={tiles}
        newSessionLabel="New session"
        newSessionDisabled
        onNewSession={onNewSession}
        onExpand={onExpand}
      />,
    );
    expect(
      (screen.getByRole('button', { name: 'New session' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('#127 — renders the sessions switcher only when menu content is provided', () => {
    const menu = (
      <>
        <RailMenuRow title="Active one" meta="now · /tmp" active onPick={vi.fn()} />
        <RailMenuRow title="Other" meta="2m" onPick={vi.fn()} />
      </>
    );
    const { rerender } = render(
      <CollapsedRail
        tiles={tiles}
        sessionMenu={menu}
        newSessionLabel="New session"
        onNewSession={vi.fn()}
        onExpand={vi.fn()}
      />,
      { wrapper: Providers },
    );
    // The switcher button exists only when the end provided menu content
    // (opening Radix's popup itself needs pointer events jsdom doesn't have —
    // the row behaviour is covered below through a default-open menu).
    expect(screen.queryByRole('button', { name: 'Sessions' })).not.toBeNull();

    // without menu content the column has no switcher at all
    rerender(
      <CollapsedRail
        tiles={tiles}
        newSessionLabel="New session"
        onNewSession={vi.fn()}
        onExpand={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Sessions' })).toBeNull();
  });

  it('#127 — a switcher row: the active one stays put, the others pick', () => {
    const pick = vi.fn();
    render(
      <DropdownMenu defaultOpen>
        <DropdownMenuTrigger asChild>
          <button type="button">open</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <RailMenuRow title="Active one" meta="now · /tmp" active onPick={vi.fn()} />
          <RailMenuRow title="Other" meta="2m" onPick={pick} />
        </DropdownMenuContent>
      </DropdownMenu>,
      { wrapper: Providers },
    );
    const active = screen.getByRole('menuitem', { name: /Active one/ });
    expect(active.getAttribute('data-active')).toBe('true');
    // picking the CURRENT session is a no-op that keeps the sheet open
    fireEvent.click(active);
    expect(screen.getByRole('menuitem', { name: /Other/ })).not.toBeNull();
    // any other row picks (the menu closes on select — Radix's own behavior)
    fireEvent.click(screen.getByRole('menuitem', { name: /Other/ }));
    expect(pick).toHaveBeenCalledTimes(1);
  });
});
