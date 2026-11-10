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
import { ContextMeter } from './composer';

/**
 * The context meter's mechanical contract (#26, reshaped by #122): the
 * adapter is the only source (no occupancy -> nothing renders), the ONE
 * inline shape is the ring (the figures live in the popover), ring and
 * popover bar carry the same tone, and the details the ring cannot show are
 * one activation away. Visual correctness is not asserted here — that is the
 * agent-browser pass and ui-snap.
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

function renderMeter(usage: { contextUsed?: number; contextSize?: number } | null) {
  return render(<ContextMeter usage={usage} />, { wrapper: Providers });
}

describe('ContextMeter', () => {
  it('renders nothing when the adapter reports no occupancy', () => {
    const { container } = renderMeter(null);
    expect(container.querySelector('[data-slot="meter-trigger"]')).toBeNull();
    expect(container.querySelector('[data-slot="meter-ring"]')).toBeNull();
  });

  it('renders nothing when the window size is unknown or zero', () => {
    const { container } = renderMeter({ contextUsed: 1200, contextSize: 0 });
    expect(container.querySelector('[data-slot="meter-trigger"]')).toBeNull();
  });

  it('carries one tone across the ring (the figures live in the popover)', () => {
    const { container } = renderMeter({ contextUsed: 40_000, contextSize: 200_000 });

    const trigger = container.querySelector('[data-slot="meter-trigger"]');
    expect(trigger?.getAttribute('aria-label')).toContain('40k');
    expect(trigger?.getAttribute('aria-label')).toContain('200k');
    // #122 — one inline shape: no figures, no 62px bar, the ring at EVERY size.
    expect(container.querySelector('[data-slot="meter-ring"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="meter"]:not([data-variant])')).toBeNull();

    // Neutral pressure: every form says so in `data-tone`.
    for (const el of container.querySelectorAll('[data-tone]')) {
      expect(el.getAttribute('data-tone')).toBe('neutral');
    }
    // The ring draws the fraction it was given: 20% of the circumference left
    // unfilled.
    const fill = container.querySelector('[data-slot="meter-ring-fill"]');
    const circumference = 2 * Math.PI * 8;
    expect(Number(fill?.getAttribute('stroke-dashoffset'))).toBeCloseTo(circumference * 0.8, 5);
  });

  it('marks near-full windows as danger on the ring and the popover bar', () => {
    const { container } = renderMeter({ contextUsed: 197_000, contextSize: 200_000 });
    // A skin keys its tone rules on the FILL elements, so the tone has to reach
    // them too — a ring that only colours its wrapper stays steel.
    for (const sel of ['[data-slot="meter-ring"]', '[data-slot="meter-ring-fill"]']) {
      expect(container.querySelector(sel)?.getAttribute('data-tone')).toBe('danger');
    }
  });

  it('opens the details on activation — the same figures, plus what the ring cannot say', () => {
    renderMeter({ contextUsed: 34_100, contextSize: 200_000 });
    expect(screen.queryByText('Context window')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Context: 34\.1k of 200k tokens/ }));

    expect(screen.getByText('Context window')).toBeDefined();
    // The percentage is the qualifier the ring cannot carry.
    expect(screen.getByText('17% used')).toBeDefined();
    // …and the wide bar carries the same danger/warn tone rules as the ring.
    const wide = document.querySelector('[data-slot="meter"][data-variant="wide"]');
    expect(wide).not.toBeNull();
  });
});
