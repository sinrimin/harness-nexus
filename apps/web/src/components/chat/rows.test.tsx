// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '@/i18n';
import { SkinProvider } from '@/components/skin-provider';
import { AssistantStepRow, TurnTail } from './rows';
import type { TurnStats } from './fold';

/**
 * #88/#128 — the settled step's action row: save-as-note and copy are
 * ICON-ONLY (a text label read as if the note were already saved; the full
 * phrases live on the tooltips/aria), the copy action writes the step's
 * markdown to the clipboard and confirms with a check, and the turn's
 * telemetry tail merges into the SAME row — actions left, tokens right —
 * instead of riding below as its own line.
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

const settled = {
  status: 'settled' as const,
  blocks: [{ type: 'text' as const, text: 'answer body' }],
};

const stats: TurnStats = {
  stopReason: 'end_turn',
  durationMs: 2500,
  usage: { inputTokens: 740, outputTokens: 232 },
};

describe('AssistantStepRow actions', () => {
  it('save-as-note is icon-only: no visible text, the phrase lives on aria/title', () => {
    render(
      <AssistantStepRow step={settled} onCapture={vi.fn()} tailStats={stats} />,
      { wrapper: Providers },
    );
    const save = screen.getByRole('button', { name: 'Save as note' });
    expect(save.textContent).toBe(''); // icon only — nothing that reads "saved"
    expect(save.getAttribute('title')).toBe('Save as note');
  });

  it('copy writes the step markdown and confirms with a check', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    render(<AssistantStepRow step={settled} onCapture={vi.fn()} />, {
      wrapper: Providers,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('answer body');
    // The check stays up briefly, then the copy glyph returns.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeNull());
  });

  it('the turn tail merges into the action row — actions left, telemetry right', () => {
    const { container } = render(
      <AssistantStepRow step={settled} onCapture={vi.fn()} tailStats={stats} />,
      { wrapper: Providers },
    );
    const row = container.querySelector('.justify-between');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('↑740 ↓232');
    // The save button sits before the telemetry in the same row.
    const buttons = row?.querySelectorAll('button');
    expect(buttons?.length).toBe(2);
    expect(buttons?.[0]?.getAttribute('aria-label')).toBe('Save as note');
  });

  it('a step without the capture surface keeps its standalone tail', () => {
    const { container } = render(
      <AssistantStepRow step={settled} tailStats={stats} />,
      { wrapper: Providers },
    );
    const row = container.querySelector('.justify-between');
    expect(row).toBeNull(); // no action row without onCapture…
    expect(container.textContent).toContain('↑740 ↓232'); // …but the tail still shows
  });

  it('zh tooltips localize while the icons stay wordless', () => {
    localStorage.setItem('hnx.lang', 'zh');
    const { container } = render(
      <AssistantStepRow step={settled} onCapture={vi.fn()} tailStats={stats} />,
      { wrapper: Providers },
    );
    const buttons = container.querySelectorAll('button');
    expect(buttons[0]?.getAttribute('aria-label')).toBe('保存为笔记');
    expect(buttons[1]?.getAttribute('aria-label')).toBe('复制');
  });
});

describe('TurnTail', () => {
  it('prints duration, tokens, and dsh occupancy in order', () => {
    const { container } = render(
      <TurnTail
        stats={{
          stopReason: 'end_turn',
          durationMs: 65_000,
          usage: { inputTokens: 740, outputTokens: 232, contextUsed: 34_100, contextSize: 200_000 },
        }}
      />,
      { wrapper: Providers },
    );
    expect(container.textContent).toContain('1m5s');
    expect(container.textContent).toContain('↑740 ↓232');
    expect(container.textContent).toContain('ctx 34k/200k');
  });
});
