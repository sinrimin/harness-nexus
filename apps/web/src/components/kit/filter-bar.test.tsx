// @vitest-environment jsdom
/**
 * `TableSearch` — the one control on the toolbar with timing (§3.5).
 *
 * The rules that are easy to break later: a burst of keystrokes is ONE URL
 * write, the × is immediate (not debounced), and an external clear wins over a
 * pending draft instead of being overwritten by it 250ms later.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { I18nProvider } from '@/i18n';
import { useListQuery, type ListQuerySpec } from '@/lib/list-query';
import { SEARCH_DEBOUNCE_MS, TableSearch } from './filter-bar';

const spec: ListQuerySpec = { filters: { kind: ['skill'] }, sort: ['name'] };

function Host() {
  const query = useListQuery(spec);
  const location = useLocation();
  return (
    <>
      <output data-testid="search">{location.search}</output>
      <TableSearch query={query} placeholder="Search resources" />
      <button onClick={() => query.setQ('')}>external-clear</button>
    </>
  );
}

const mount = (search = ''): void => {
  render(
    <MemoryRouter initialEntries={[`/resources${search}`]}>
      <I18nProvider>
        <Host />
      </I18nProvider>
    </MemoryRouter>,
  );
};

const box = (): HTMLInputElement => screen.getByRole('searchbox') as HTMLInputElement;
const settled = async (): Promise<void> => {
  await act(async () => {
    vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2);
  });
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('TableSearch', () => {
  it('writes once for a burst of keystrokes', async () => {
    vi.useFakeTimers();
    mount('');
    fireEvent.change(box(), { target: { value: 'a' } });
    fireEvent.change(box(), { target: { value: 'ab' } });
    fireEvent.change(box(), { target: { value: 'abc' } });
    expect(screen.getByTestId('search').textContent).toBe(''); // still only a draft
    await settled();
    expect(screen.getByTestId('search').textContent).toBe('?q=abc');
  });

  it('clears immediately, without waiting for the debounce', () => {
    mount('?q=abc');
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(screen.getByTestId('search').textContent).toBe('');
    expect(box().value).toBe('');
  });

  it('adopts an external clear rather than writing the stale draft back', async () => {
    vi.useFakeTimers();
    mount('');
    fireEvent.change(box(), { target: { value: 'ab' } });
    await settled();
    expect(screen.getByTestId('search').textContent).toBe('?q=ab');

    fireEvent.change(box(), { target: { value: 'abc' } }); // draft, write still pending
    fireEvent.click(screen.getByText('external-clear'));
    await settled();

    expect(screen.getByTestId('search').textContent).toBe('');
    expect(box().value).toBe('');
  });

  it('follows a deep link into the box', () => {
    mount('?q=skill');
    expect(box().value).toBe('skill');
  });
});