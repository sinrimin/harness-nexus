// @vitest-environment jsdom
/**
 * The URL contract, asserted (07-p3-list-pages.md §3).
 *
 * These are the ten rules a future page is most likely to break silently:
 * defaults omitted, unknown values ignored rather than rewritten, `clear`
 * touching only this page's params — plus the two the eye cannot check, the
 * sort comparator's blank handling and the search's case/protocol matching.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigationType } from 'react-router-dom';
import {
  clearListQuery,
  countLabel,
  effectiveSort,
  matchesQuery,
  readListQuery,
  sortRows,
  useListQuery,
  writeListQuery,
  type ListQuerySpec,
} from './list-query';

const spec: ListQuerySpec = {
  filters: { kind: ['skill', 'hook'], scope: ['personal', 'global'] },
  sort: ['-updated', 'name'],
};

const url = (search: string): URLSearchParams => new URLSearchParams(search);

afterEach(cleanup);

describe('readListQuery', () => {
  it('reads absent params as the defaults and reports nothing active', () => {
    const query = readListQuery(spec, url(''));
    expect(query.q).toBe('');
    expect(query.filters).toEqual({ kind: null, scope: null });
    expect(query.sort).toBeNull();
    expect(query.active).toBe(false);
  });

  it('trims q and treats an unknown filter value as absent', () => {
    const query = readListQuery(spec, url('q=%20abc%20&kind=skill&scope=bogus'));
    expect(query.q).toBe('abc');
    expect(query.filters['kind']).toBe('skill');
    expect(query.filters['scope']).toBeNull();
    expect(query.active).toBe(true);
  });

  it('accepts both sort directions and ignores an undeclared key', () => {
    expect(readListQuery(spec, url('sort=name')).sort).toBe('name');
    expect(readListQuery(spec, url('sort=-name')).sort).toBe('-name');
    expect(readListQuery(spec, url('sort=bogus')).sort).toBeNull();
    expect(readListQuery(spec, url('sort=-bogus')).sort).toBeNull();
    expect(readListQuery(spec, url('sort=bogus')).active).toBe(false);
  });

  it('reads params a page never declared as absent', () => {
    const query = readListQuery(spec, url('kind=skill&transport=stdio'));
    expect(query.filters).toEqual({ kind: 'skill', scope: null });
  });

  // The default is declared as an *encoding* ('-updated'), so the vocabulary is
  // the keys: a page whose default is descending must still read `-updated`
  // back. (Found in the deployed walk — `?sort=-created` was silently dropped
  // because 'created' is not a literal member of ['username', '-created'].)
  it('reads a key whose declared default is descending', () => {
    const descending: ListQuerySpec = { sort: ['-created', 'name'] };
    expect(readListQuery(descending, url('sort=-created')).sort).toBe('-created');
    expect(readListQuery(descending, url('sort=created')).sort).toBe('created');
    expect(readListQuery(descending, url('sort=-created')).active).toBe(true);
    expect(writeListQuery(descending, url(''), { sort: '-created' }).get('sort')).toBe('-created');
  });
});

describe('writeListQuery', () => {
  it('omits defaults instead of writing empty values', () => {
    expect(writeListQuery(spec, url(''), { q: '   ' }).toString()).toBe('');
    expect(writeListQuery(spec, url(''), { q: 'x' }).get('q')).toBe('x');
    expect(writeListQuery(spec, url('q=x'), { q: '' }).has('q')).toBe(false);
  });

  it('sets a declared value and deletes an undeclared one', () => {
    expect(writeListQuery(spec, url(''), { filters: { kind: 'skill' } }).get('kind')).toBe('skill');
    expect(writeListQuery(spec, url('kind=skill'), { filters: { kind: null } }).has('kind')).toBe(
      false,
    );
    expect(
      writeListQuery(spec, url('kind=skill'), { filters: { kind: 'nonsense' } }).has('kind'),
    ).toBe(false);
  });

  it('does not write a param the page never declared', () => {
    const next = writeListQuery(spec, url('transport=stdio'), { filters: { transport: 'sse' } });
    expect(next.get('transport')).toBe('stdio');
  });

  it('canonicalises the sort and drops an undeclared key', () => {
    expect(writeListQuery(spec, url(''), { sort: '-name' }).get('sort')).toBe('-name');
    expect(writeListQuery(spec, url('sort=name'), { sort: null }).has('sort')).toBe(false);
    expect(writeListQuery(spec, url('sort=name'), { sort: 'nope' }).has('sort')).toBe(false);
  });

  it('leaves other pages\u2019 params alone', () => {
    const next = writeListQuery(spec, url('tab=hub&ch=abc'), { q: 'x', filters: { kind: 'hook' } });
    expect(next.get('tab')).toBe('hub');
    expect(next.get('ch')).toBe('abc');
    expect(next.get('kind')).toBe('hook');
  });
});

describe('clearListQuery', () => {
  it('drops only this page\u2019s list params (\u00a73.10)', () => {
    const next = clearListQuery(spec, url('tab=hub&ch=abc&q=abc&kind=skill&scope=global'));
    expect(next.toString()).toBe('tab=hub&ch=abc');
  });

  it('keeps the page\u2019s own pointer (\u00a73.10): ?highlight is not a list param', () => {
    // The skills page sets `?highlight=<key>` when the hub hands a saved skill
    // over. Clearing the list's filters must not throw that pointer away — the
    // two vocabularies share a URL and nothing else (09-p4-resource-kinds.md §5).
    const next = clearListQuery(spec, url('q=abc&scope=global&highlight=skill%3Anew'));
    expect(next.toString()).toBe('highlight=skill%3Anew');
  });

  it('never writes or drops a param it does not declare', () => {
    const written = writeListQuery(spec, url('highlight=skill%3Anew'), { q: 'pdf' });
    expect(written.get('highlight')).toBe('skill:new');
    expect(written.get('q')).toBe('pdf');
  });
});

describe('effectiveSort', () => {
  it('falls back to the first declared key, which may be descending', () => {
    expect(effectiveSort(spec, readListQuery(spec, url('')))).toBe('-updated');
    expect(effectiveSort(spec, readListQuery(spec, url('sort=name')))).toBe('name');
    expect(effectiveSort({}, readListQuery({}, url('')))).toBeNull();
  });
});

describe('sortRows', () => {
  const rows = [
    { name: 'b', updated: '2026-01-02T00:00:00Z' },
    { name: 'a', updated: '' },
    { name: 'c', updated: '2026-01-10T00:00:00Z' },
  ];
  const value = (row: (typeof rows)[number], key: string): unknown =>
    key === 'name' ? row.name : row.updated;

  it('sorts by the declared key, both directions', () => {
    expect(sortRows(rows, 'name', value).map((r) => r.name)).toEqual(['a', 'b', 'c']);
    expect(sortRows(rows, '-name', value).map((r) => r.name)).toEqual(['c', 'b', 'a']);
  });

  it('keeps blanks last in both directions', () => {
    expect(sortRows(rows, 'updated', value).map((r) => r.name)).toEqual(['b', 'c', 'a']);
    expect(sortRows(rows, '-updated', value).map((r) => r.name)).toEqual(['c', 'b', 'a']);
  });

  it('compares numbers as numbers and copies when there is no sort', () => {
    const sized = [{ n: 10 }, { n: 2 }, { n: 1 }];
    expect(sortRows(sized, 'n', (row) => row.n).map((r) => r.n)).toEqual([1, 2, 10]);
    const input = [...rows];
    const output = sortRows(input, null, value);
    expect(output).toEqual(input);
    expect(output).not.toBe(input);
  });
});

describe('matchesQuery', () => {
  it('is a trimmed, case-insensitive substring over the declared fields', () => {
    expect(matchesQuery('', ['anything'])).toBe(true);
    expect(matchesQuery('  SKILL ', ['my-skill', 'rule'])).toBe(true);
    expect(matchesQuery('streamable', ['stdio', 'streamable-http'])).toBe(true);
    expect(matchesQuery('nope', ['stdio', 'streamable-http'])).toBe(false);
  });

  it('searches arrays and skips blanks', () => {
    expect(matchesQuery('zcode', [['claude-code', 'zcode'], null, undefined, ''])).toBe(true);
    expect(matchesQuery('null', [null, undefined])).toBe(false);
  });
});

describe('countLabel', () => {
  it('only qualifies a count when something is filtered', () => {
    expect(countLabel(3, 10, true)).toBe('3 / 10');
    expect(countLabel(3, 10, false)).toBeNull();
  });
});

function Host({ spec: pageSpec }: { spec: ListQuerySpec }) {
  const list = useListQuery(pageSpec);
  const location = useLocation();
  const navigationType = useNavigationType();
  return (
    <>
      <output data-testid="search">{location.search}</output>
      <output data-testid="navtype">{navigationType}</output>
      <output data-testid="q">{list.q}</output>
      <output data-testid="active">{String(list.active)}</output>
      <button onClick={() => list.setFilter('kind', 'skill')}>set-kind</button>
      <button onClick={() => list.setFilter('kind', null)}>unset-kind</button>
      <button onClick={() => list.setQ('typed')}>set-q</button>
      <button onClick={list.clear}>clear</button>
    </>
  );
}

function mount(search: string): void {
  render(
    <MemoryRouter initialEntries={[`/resources${search}`]}>
      <Host spec={spec} />
    </MemoryRouter>,
  );
}

describe('useListQuery', () => {
  it('reads a deep link', () => {
    mount('?tab=hub&kind=skill&q=ab');
    expect(screen.getByTestId('q').textContent).toBe('ab');
    expect(screen.getByTestId('active').textContent).toBe('true');
  });

  it('writes with replace, so filtering never becomes a history entry (\u00a73.2)', async () => {
    const user = userEvent.setup();
    mount('');
    await user.click(screen.getByText('set-kind'));
    expect(screen.getByTestId('search').textContent).toBe('?kind=skill');
    expect(screen.getByTestId('navtype').textContent).toBe('REPLACE');
  });

  it('removes the key when a filter goes back to the default', async () => {
    const user = userEvent.setup();
    mount('?kind=skill');
    await user.click(screen.getByText('unset-kind'));
    expect(screen.getByTestId('search').textContent).toBe('');
  });

  it('clears its own params and keeps the neighbours (\u00a73.10)', async () => {
    const user = userEvent.setup();
    mount('?tab=hub&kind=skill&q=ab');
    await user.click(screen.getByText('clear'));
    expect(screen.getByTestId('search').textContent).toBe('?tab=hub');
    expect(screen.getByTestId('active').textContent).toBe('false');
  });
});
