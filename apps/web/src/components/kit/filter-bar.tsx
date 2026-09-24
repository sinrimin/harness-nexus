/**
 * The list toolbar — search, filters, sort (07-p3-list-pages.md §4).
 *
 * One bar per list page, dropped into `DataTable`'s `toolbar` slot. Every
 * control here is a *view* of the URL (via `ListQueryController`): a page that
 * added its own `useState` would break the contract's first rule, and a page
 * that built its own select would be the fourth copy of the same geometry.
 *
 * The vocabulary lives in the page's `ListQuerySpec` and only labels live
 * here — so a filter option and the value the URL is allowed to carry cannot
 * drift apart.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SearchIcon, XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/i18n';
import { countLabel, type ListQueryController, type ListQuerySpec } from '@/lib/list-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/** §3.5 — one keystroke must not be one URL write (and one list re-render). */
export const SEARCH_DEBOUNCE_MS = 250;

/** The "no constraint" sentinel inside a select; never appears in the URL. */
const ALL = 'all';

type FilterBarProps = {
  query: ListQueryController;
  /** Rows after filtering (omit while loading). */
  shown?: number;
  /** Rows before filtering. */
  total?: number;
  children: ReactNode;
  className?: string;
};

/** The strip itself: controls on the left, count + clear on the right. */
export function FilterBar({ query, shown, total, children, className }: FilterBarProps) {
  const { t } = useI18n();
  const count =
    typeof shown === 'number' && typeof total === 'number'
      ? countLabel(shown, total, query.active)
      : null;

  return (
    <div
      data-slot="filter-bar"
      className={cn('flex min-w-0 flex-wrap items-center gap-2', className)}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
      {count !== null || query.active ? (
        <div className="flex items-center gap-2">
          {count !== null ? (
            <span data-slot="filter-count" className="role-readout-sm text-muted-foreground">
              {count}
            </span>
          ) : null}
          {query.active ? (
            <Button variant="ghost" size="sm" className="gap-1.5" onClick={query.clear}>
              <XIcon className="size-3.5" />
              {t('kit.clearFilters')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

type TableSearchProps = {
  query: ListQueryController;
  /** What this box searches — the placeholder *and* the accessible name. */
  placeholder: string;
  className?: string;
};

/**
 * Debounced search box writing `?q=`.
 *
 * Two rules meet here (§3.5): the input keeps the user's text while they type,
 * and an external URL change (clear, deep link, back) still lands in the box —
 * but our own echo must not, or the debounce would fight the URL.
 */
export function TableSearch({ query, placeholder, className }: TableSearchProps) {
  const { t } = useI18n();
  const setQ = query.setQ;
  const [draft, setDraft] = useState(query.q);
  /** The last value we wrote to (or accepted from) the URL. */
  const written = useRef(query.q);

  useEffect(() => {
    if (query.q === written.current) return; // our own echo
    written.current = query.q;
    setDraft(query.q);
  }, [query.q]);

  useEffect(() => {
    if (draft === written.current) return;
    const id = window.setTimeout(() => {
      written.current = draft;
      setQ(draft);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [draft, setQ]);

  const clear = (): void => {
    written.current = '';
    setDraft('');
    setQ('');
  };

  return (
    <div className={cn('relative', className)}>
      <SearchIcon className="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2" />
      <Input
        type="text"
        role="searchbox"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        autoComplete="off"
        spellCheck={false}
        className="w-full ps-8 pe-9 text-xs sm:w-56"
      />
      {draft !== '' ? (
        <button
          type="button"
          onClick={clear}
          aria-label={t('kit.clearSearch')}
          className="text-muted-foreground hover:text-foreground absolute end-1 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center"
        >
          <XIcon className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

type FilterSelectProps = {
  query: ListQueryController;
  /** The page's vocabulary: `name` must be a key of `spec.filters`. */
  spec: ListQuerySpec;
  name: string;
  /** The default option's text (*All kinds*), also the control's accessible name. */
  allLabel: string;
  /** Value → text. Keys are the spec's vocabulary entries. */
  labels: Record<string, string>;
  className?: string;
};

/** One URL-backed filter: choosing the default deletes the key (§3.3). */
export function FilterSelect({
  query,
  spec,
  name,
  allLabel,
  labels,
  className,
}: FilterSelectProps) {
  const value = query.filters[name] ?? ALL;
  const vocabulary = spec.filters?.[name] ?? [];

  return (
    <Select
      value={value}
      onValueChange={(next) => query.setFilter(name, next === ALL ? null : next)}
    >
      <SelectTrigger aria-label={allLabel} className={cn('w-auto text-xs', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {vocabulary.map((entry) => (
          <SelectItem key={entry} value={entry}>
            {labels[entry] ?? entry}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

type SortSelectProps = {
  query: ListQueryController;
  spec: ListQuerySpec;
  /** Sort encoding (`name`, `-updated`) → text. */
  labels: Record<string, string>;
  /** Accessible name, e.g. *Sort by*. */
  label: string;
  className?: string;
};

/** Sort over the spec's declared keys; the first entry is the default (§3.8). */
export function SortSelect({ query, spec, labels, label, className }: SortSelectProps) {
  const declared = spec.sort ?? [];
  const fallback = declared[0] ?? '';
  const value = query.sort ?? fallback;

  return (
    <Select
      value={value}
      onValueChange={(next) => query.setSort(next === fallback ? null : next)}
    >
      <SelectTrigger aria-label={label} className={cn('w-auto text-xs', className)}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {declared.map((entry) => (
          <SelectItem key={entry} value={entry}>
            {labels[entry] ?? entry}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}