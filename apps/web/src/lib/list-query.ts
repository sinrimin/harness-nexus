/**
 * The list-view URL contract (07-p3-list-pages.md).
 *
 * Seven list pages share one filter/search/sort vocabulary, and the URL is its
 * only storage: `?q= &<filter>= &sort=`. A page declares what it understands
 * (`ListQuerySpec`, module scope — it is a vocabulary, not state), derives its
 * visible rows in memory, and writes user intent back with `replace` so a
 * filter never becomes a history entry.
 *
 * Everything here is a pure function over `URLSearchParams` except the hook, so
 * the semantics — defaults omitted, unknown values ignored rather than
 * rewritten, `clear` touching only this page's params — are unit-testable
 * without a router.
 */
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

const SEARCH_PARAM = 'q';
const SORT_PARAM = 'sort';

/**
 * What a page declares. `filters` maps a param name to its closed vocabulary of
 * non-default values (the default is "absent" — §3.3); `sort` lists the sortable
 * keys with the default encoding first, e.g. `['-lastSeen', 'name', 'status']`.
 */
export interface ListQuerySpec {
  filters?: Record<string, readonly string[]>;
  sort?: readonly string[];
}

interface ParsedListQuery {
  /** Trimmed search text; `''` when absent. */
  q: string;
  /** Every declared filter, `null` when absent or not in the vocabulary. */
  filters: Record<string, string | null>;
  /** Canonical `key` / `-key`, or `null` for the page's default. */
  sort: string | null;
  /** Any non-default value present — the one source of the `filtered` state. */
  active: boolean;
}

interface ListQueryPatch {
  q?: string;
  filters?: Record<string, string | null>;
  sort?: string | null;
}

/** `<key>` = ascending, `-<key>` = descending (§3.8). */
function parseSort(raw: string | null): { key: string; desc: boolean } | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const desc = trimmed.startsWith('-');
  const key = desc ? trimmed.slice(1).trim() : trimmed;
  if (key === '') return null;
  return { key, desc };
}

function encodeSort(key: string, desc: boolean): string {
  return desc ? `-${key}` : key;
}

/**
 * The sortable keys, without the direction prefix. `sort` is declared as
 * encodings (`'-created'`, `'name'`) so the first entry can state the default
 * direction — but a URL may carry either direction of any declared key, so the
 * vocabulary is the *keys*.
 */
function declaredSortKeys(spec: ListQuerySpec): string[] {
  return (spec.sort ?? []).map((entry) => parseSort(entry)?.key ?? entry);
}

export function readListQuery(spec: ListQuerySpec, params: URLSearchParams): ParsedListQuery {
  const q = (params.get(SEARCH_PARAM) ?? '').trim();
  let active = q !== '';

  const filters: Record<string, string | null> = {};
  for (const [name, vocabulary] of Object.entries(spec.filters ?? {})) {
    const raw = params.get(name);
    const known = raw !== null && vocabulary.includes(raw);
    filters[name] = known ? raw : null;
    if (known) active = true;
  }

  const parsed = parseSort(params.get(SORT_PARAM));
  const sort =
    parsed !== null && declaredSortKeys(spec).includes(parsed.key)
      ? encodeSort(parsed.key, parsed.desc)
      : null;
  if (sort !== null) active = true;

  return { q, filters, sort, active };
}

/**
 * Read-modify-write. Never throws on junk: an unknown filter value deletes the
 * key, which is how `clear` and a hand-edited URL both converge on the default.
 */
export function writeListQuery(
  spec: ListQuerySpec,
  params: URLSearchParams,
  patch: ListQueryPatch,
): URLSearchParams {
  const next = new URLSearchParams(params);

  if (patch.q !== undefined) {
    const q = patch.q.trim();
    if (q === '') next.delete(SEARCH_PARAM);
    else next.set(SEARCH_PARAM, q);
  }

  if (patch.filters !== undefined) {
    for (const [name, value] of Object.entries(patch.filters)) {
      const vocabulary = spec.filters?.[name];
      if (vocabulary === undefined) continue; // not this page's param: leave it alone
      if (value === null || !vocabulary.includes(value)) next.delete(name);
      else next.set(name, value);
    }
  }

  if (patch.sort !== undefined) {
    const parsed = patch.sort === null ? null : parseSort(patch.sort);
    if (parsed === null || !declaredSortKeys(spec).includes(parsed.key)) next.delete(SORT_PARAM);
    else next.set(SORT_PARAM, encodeSort(parsed.key, parsed.desc));
  }

  return next;
}

/**
 * Drop this page's list params and nothing else — `?tab=hub` (Skills), `?ch=`
 * (chat channels) and any other page's state survive (§3.10).
 */
export function clearListQuery(spec: ListQuerySpec, params: URLSearchParams): URLSearchParams {
  const filters: Record<string, string | null> = {};
  for (const name of Object.keys(spec.filters ?? {})) filters[name] = null;
  return writeListQuery(spec, params, { q: '', filters, sort: null });
}

/** The sort to sort by: the URL's, else the page's declared default (§3.8). */
export function effectiveSort(spec: ListQuerySpec, query: ParsedListQuery): string | null {
  if (query.sort !== null) return query.sort;
  return spec.sort?.[0] ?? null;
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

/**
 * Blank values last in both directions: a machine that never connected is not
 * "the oldest machine", and an empty credential name is not "the smallest".
 */
function compareValues(a: unknown, b: unknown): number {
  const aBlank = isBlank(a);
  const bBlank = isBlank(b);
  if (aBlank || bBlank) {
    if (aBlank && bBlank) return 0;
    return aBlank ? 1 : -1;
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a === b ? 0 : a ? 1 : -1;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Sort by a declared key. `value(row, key)` is the page's column accessor —
 * the shell cannot know what a row holds.
 */
export function sortRows<T>(
  rows: readonly T[],
  sort: string | null,
  value: (row: T, key: string) => unknown,
): T[] {
  const parsed = parseSort(sort);
  if (parsed === null) return [...rows];
  return rows
    .map((row) => ({ row, v: value(row, parsed.key) }))
    .sort((a, b) => {
      const cmp = compareValues(a.v, b.v);
      if (isBlank(a.v) || isBlank(b.v)) return cmp;
      return parsed.desc ? -cmp : cmp;
    })
    .map((entry) => entry.row);
}

/**
 * Case-insensitive substring search across the page's declared fields (§3.6).
 * Protocol values are the point — `streamable-http`, `personal`, `zcode`.
 */
export function matchesQuery(q: string, fields: readonly unknown[]): boolean {
  const needle = q.trim().toLowerCase();
  if (needle === '') return true;
  const parts: string[] = [];
  for (const field of fields) {
    if (Array.isArray(field)) {
      for (const item of field) parts.push(String(item ?? ''));
    } else if (!isBlank(field)) {
      parts.push(String(field));
    }
  }
  return parts.join(' ').toLowerCase().includes(needle);
}

export interface ListQueryController extends ParsedListQuery {
  setQ: (value: string) => void;
  setFilter: (name: string, value: string | null) => void;
  setSort: (value: string | null) => void;
  clear: () => void;
}

/** The router-bound half: `?…` in, `?…` out, always `replace` (§3.2). */
export function useListQuery(spec: ListQuerySpec): ListQueryController {
  const [params, setParams] = useSearchParams();
  const query = useMemo(() => readListQuery(spec, params), [spec, params]);

  const apply = useCallback(
    (patch: ListQueryPatch) => {
      setParams((prev) => writeListQuery(spec, prev, patch), { replace: true });
    },
    [setParams, spec],
  );

  const setQ = useCallback((value: string) => apply({ q: value }), [apply]);
  const setFilter = useCallback(
    (name: string, value: string | null) => apply({ filters: { [name]: value } }),
    [apply],
  );
  const setSort = useCallback((value: string | null) => apply({ sort: value }), [apply]);
  const clear = useCallback(
    () => setParams((prev) => clearListQuery(spec, prev), { replace: true }),
    [setParams, spec],
  );

  return { ...query, setQ, setFilter, setSort, clear };
}

/** `seen / total`, or null when there is nothing to qualify. */
export function countLabel(shown: number, total: number, active: boolean): string | null {
  if (!active) return null;
  return `${shown} / ${total}`;
}
