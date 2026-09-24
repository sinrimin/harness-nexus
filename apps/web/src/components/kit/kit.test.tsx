// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '@/i18n';
import { SkinProvider } from '@/components/skin-provider';
import { CommandLine, commandPlaceholders, markPlaceholders } from './command-line';
import { ConfirmDialog } from './confirm-dialog';
import { Field } from './field';
import { Lamp } from './lamp';
import { Panel } from './panel';
import { TableStateRow, tableState } from './table';
import { Well } from './well';

/**
 * Kit primitives — the mechanical contracts only.
 *
 * Visual correctness is not asserted here (that is ui-snap plus the
 * agent-browser pass); what a unit test can hold is the part a future edit is
 * most likely to break silently: which state word reaches `data-state`, that a
 * destructive dialog cannot be confirmed by accident, that a state row
 * resolves to the right face, and that a copy affordance copies the exact
 * string it displays.
 */

beforeAll(() => {
  // jsdom lacks the observers Radix and the layout code reach for.
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

function renderKit(node: ReactNode) {
  return render(node, { wrapper: Providers });
}

describe('tableState', () => {
  it('lets an error outrank a still-null list', () => {
    expect(tableState({ error: new Error('boom'), loading: true, count: 0 })).toBe('error');
  });

  it('distinguishes an empty list from an empty filter result', () => {
    expect(tableState({ count: 0 })).toBe('empty');
    expect(tableState({ count: 0, filtered: true })).toBe('filtered');
    expect(tableState({ count: 3, filtered: true })).toBe('ready');
  });

  it('treats a null error as no error', () => {
    expect(tableState({ error: null, count: 1 })).toBe('ready');
  });
});

describe('CommandLine', () => {
  it('derives the placeholders from the command itself, deduplicated', () => {
    expect(
      commandPlaceholders('hnx enroll --server <url> --token <your-pat> --again <url>'),
    ).toEqual(['<url>', '<your-pat>']);
    expect(commandPlaceholders('hnx daemon --server http://x')).toEqual([]);
  });

  it('marks the placeholders in place and lists them', () => {
    const { container } = renderKit(<CommandLine command="hnx enroll --token <your-pat>" />);
    const marks = container.querySelectorAll('[data-slot="placeholder"]');
    expect(marks).toHaveLength(1);
    expect(marks[0]?.textContent).toBe('<your-pat>');
    // the note repeats the same token, from the same scan
    expect(screen.getAllByText('<your-pat>')).toHaveLength(2);
  });

  it('keeps multi-line commands intact', () => {
    const { container } = renderKit(<CommandLine command={'a <x>\nb <y>'} />);
    expect(container.querySelector('[data-slot="well-value"]')?.textContent).toBe('a <x>\nb <y>');
    // both lines get their placeholder marked
    expect(container.querySelectorAll('[data-slot="placeholder"]')).toHaveLength(2);
  });
});

describe('Well', () => {
  it('copies exactly the string it shows', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    renderKit(<Well copy="hnx daemon">hnx daemon</Well>);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledWith('hnx daemon');
  });

  it('renders no copy affordance when there is nothing to copy', () => {
    renderKit(<Well>plain</Well>);
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('Lamp', () => {
  it('keeps the state word as the truth and reads the shape from the skin', () => {
    const { container } = renderKit(<Lamp state="offline" word="Offline" />);
    const lamp = container.querySelector('[data-lamp]');
    expect(lamp?.getAttribute('data-state')).toBe('offline');
    expect(lamp?.getAttribute('data-lamp')).toBe('dot'); // signal's statusStyle
    expect(lamp?.getAttribute('data-tone')).toBe('off');
    expect(screen.getByText('Offline')).toBeTruthy();
  });

  it('marks the live lamp for the accent and the breath', () => {
    const { container } = renderKit(<Lamp state="online" live word="Online" />);
    const body = container.querySelector('[data-slot="lamp-body"]');
    expect(body?.className).toContain('lamp-breath');
  });

  it('names the lamp for screen readers when it has no visible word', () => {
    renderKit(<Lamp state="online" label="Online" />);
    expect(screen.getByText('Online')).toBeTruthy();
  });
});

describe('Field', () => {
  it('associates the label and announces the error', () => {
    renderKit(
      <Field label="Name" htmlFor="f-name" error="Required">
        <input id="f-name" />
      </Field>,
    );
    expect(screen.getByLabelText('Name')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('Required');
  });

  it('shows the hint only while there is no error', () => {
    const { rerender } = renderKit(
      <Field label="Name" htmlFor="f-name2" hint="Lowercase only">
        <input id="f-name2" />
      </Field>,
    );
    expect(screen.getByText('Lowercase only')).toBeTruthy();
    // rerender keeps the wrapper — the Router must not be nested a second time
    rerender(
      <Field label="Name" htmlFor="f-name2" hint="Lowercase only" error="Required">
        <input id="f-name2" />
      </Field>,
    );
    expect(screen.queryByText('Lowercase only')).toBeNull();
  });
});

describe('Panel', () => {
  it('renders the nameplate only when it has something to say', () => {
    const { container } = renderKit(
      <Panel label="Enrolled machines" meta="3 online">
        body
      </Panel>,
    );
    expect(container.querySelector('[data-surface="panel"]')).toBeTruthy();
    expect(container.querySelector('[data-slot="panel-title"]')?.textContent).toBe(
      'Enrolled machines',
    );
    expect(container.querySelector('[data-slot="panel-meta"]')?.textContent).toContain('3 online');

    const bare = renderKit(<Panel>body</Panel>);
    expect(bare.container.querySelector('[data-slot="panel-header"]')).toBeNull();
  });
});

describe('TableStateRow', () => {
  const wrap = (node: ReactNode) => (
    <table>
      <tbody>{node}</tbody>
    </table>
  );

  it('empty: the fact, the hint and the action', () => {
    renderKit(
      wrap(
        <TableStateRow
          state="empty"
          columns={3}
          empty={{ title: 'No machines yet', hint: 'Enroll one', action: <button>Enroll</button> }}
        />,
      ),
    );
    expect(screen.getByText('No machines yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enroll' })).toBeTruthy();
  });

  it('filtered: offers to clear the filter instead of pretending the list is empty', () => {
    const onClearFilters = vi.fn();
    renderKit(wrap(<TableStateRow state="filtered" columns={3} onClearFilters={onClearFilters} />));
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onClearFilters).toHaveBeenCalledOnce();
    expect(screen.queryByText('No machines yet')).toBeNull();
  });

  it('error: keeps the code, not just a message, and can be retried', () => {
    const onRetry = vi.fn();
    renderKit(
      wrap(
        <TableStateRow
          state="error"
          columns={3}
          error={{ code: 'hnx/forbidden', message: 'Not allowed' }}
          onRetry={onRetry}
        />,
      ),
    );
    expect(screen.getByText('Not allowed')).toBeTruthy();
    expect(screen.getByText('hnx/forbidden')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('loading: skeleton rows appear only after the 300ms grace period', () => {
    vi.useFakeTimers();
    try {
      const { container } = renderKit(
        wrap(<TableStateRow state="loading" columns={4} loadingRows={2} />),
      );
      expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(0);
      act(() => {
        vi.advanceTimersByTime(300);
      });
      expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(8);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ConfirmDialog', () => {
  it('cannot be confirmed until the phrase is typed exactly', () => {
    const onConfirm = vi.fn();
    renderKit(
      <ConfirmDialog
        open
        onOpenChange={() => {}}
        title="Remove machine"
        consequence="Its token is revoked."
        confirmPhrase="work-laptop"
        actionLabel="Remove machine"
        onConfirm={onConfirm}
      />,
    );
    const button = screen.getByRole('button', { name: 'Remove machine' });
    expect(button.hasAttribute('disabled')).toBe(true);

    const input = screen.getByLabelText('Type work-laptop to confirm');
    fireEvent.change(input, { target: { value: 'work-lapto' } });
    expect(button.hasAttribute('disabled')).toBe(true);

    fireEvent.change(input, { target: { value: 'work-laptop' } });
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(button);
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('a single-step confirm is armed immediately and still cancellable', () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    renderKit(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Delete credential"
        consequence="Anything referencing it stops resolving."
        actionLabel="Delete credential"
        onConfirm={onConfirm}
      />,
    );
    const button = screen.getByRole('button', { name: 'Delete credential' });
    expect(button.hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
