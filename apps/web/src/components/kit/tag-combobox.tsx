// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import { useEffect, useId, useRef, useState } from 'react';
import { XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * TagCombobox — a creatable multi-select (#56): chosen values render as
 * removable × tags inside the control, the input filters the preset list,
 * and a typed value is offered as a custom row (the gateway-compat escape
 * hatch). Serves the provider registry's `serverTools` and `extraBody` keys
 * — two surfaces, so it earns its kit place. Labels arrive as props: the
 * caller translates; the device renders.
 */
export interface TagComboboxProps {
  /** Explicit control id (form label pairing); falls back to a generated one. */
  id?: string;
  value: string[];
  /** Curated presets — filtered against the query and the already-selected. */
  options: readonly string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  /** Rendered for the typed-custom row, e.g. `Use “{value}”`. */
  addLabel: (value: string) => string;
  /** Screen-reader label for a tag's × button. */
  removeLabel: (value: string) => string;
  /**
   * Accessible name for the input — once tags exist the placeholder is
   * blanked, so the control needs an explicit label to stay named.
   */
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
}

export function TagCombobox({
  id,
  value,
  options,
  onChange,
  placeholder,
  addLabel,
  removeLabel,
  ariaLabel,
  disabled = false,
  className,
}: TagComboboxProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputId = useId();

  useEffect(() => {
    if (!open) return;
    function onDocPointerDown(e: PointerEvent): void {
      if (rootRef.current !== null && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [open]);

  const selected = new Set(value);
  const q = query.trim().toLowerCase();
  const matches = options.filter(
    (o) => !selected.has(o) && (q === '' || o.toLowerCase().includes(q)),
  );
  const typed = query.trim();
  const custom =
    typed !== '' && !selected.has(typed) && !options.some((o) => o.toLowerCase() === q)
      ? typed
      : null;

  function add(v: string): void {
    const t = v.trim();
    if (t === '' || selected.has(t)) return;
    onChange([...value, t]);
    setQuery('');
  }

  function remove(v: string): void {
    onChange(value.filter((x) => x !== v));
  }

  return (
    <div ref={rootRef} className={cn('relative', className)} data-slot="tag-combobox">
      <div
        className={cn(
          'border-input bg-transparent flex min-h-(--control-h) w-full flex-wrap items-center gap-1 rounded-(--radius-well) border px-2 py-1 text-sm shadow-xs',
          'focus-within:border-signal focus-within:ring-(--ring-width)/(--ring-strength) ring-signal',
          disabled && 'opacity-50',
        )}
        data-open={open}
        data-slot="tag-combobox-field"
      >
        {value.map((v) => (
          <span
            key={v}
            data-tag={v}
            className="border-border bg-tray text-foreground inline-flex max-w-full items-center gap-0.5 rounded-(--radius-well) border px-1.5 py-0.5"
          >
            <span className="role-data-sm truncate font-mono">{v}</span>
            <button
              type="button"
              className="text-muted-foreground hover:text-danger -m-1.5 flex size-6 shrink-0 items-center justify-center"
              onClick={() => remove(v)}
              aria-label={removeLabel(v)}
              disabled={disabled}
            >
              <XIcon className="size-3" />
            </button>
          </span>
        ))}
        <input
          id={id ?? inputId}
          value={query}
          disabled={disabled}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              // Enter commits the typed value verbatim (a preset when it spells
              // one, a custom entry otherwise) — WYSIWYG, no first-match guess.
              e.preventDefault();
              add(query);
            } else if (e.key === 'Backspace' && query === '' && value.length > 0) {
              remove(value[value.length - 1]!);
            } else if (e.key === 'Escape') {
              // Only dismiss the listbox — a bare Escape must not bubble into
              // the enclosing Radix dialog (preventDefault shields DismissableLayer).
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            }
          }}
          placeholder={value.length === 0 ? placeholder : ''}
          aria-label={ariaLabel}
          className="font-mono placeholder:text-muted-foreground min-w-16 flex-1 bg-transparent text-xs outline-none"
          autoComplete="off"
          spellCheck={false}
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls={open ? `${inputId}-list` : undefined}
        />
      </div>
      {open && (matches.length > 0 || custom !== null) ? (
        <ul
          id={`${inputId}-list`}
          role="listbox"
          data-swallow-escape="true"
          className="bg-card text-card-foreground absolute z-50 mt-1 max-h-48 w-full overflow-auto rounded-md border shadow-(--shadow-panel)"
        >
          {matches.map((o) => (
            <li key={o} role="option" aria-selected={false}>
              <button
                type="button"
                data-option={o}
                className="hover:bg-tray flex w-full items-center px-2 py-1.5 text-left"
                onClick={() => add(o)}
              >
                <span className="role-data-sm font-mono">{o}</span>
              </button>
            </li>
          ))}
          {custom !== null ? (
            <li role="option" aria-selected={false}>
              <button
                type="button"
                data-option={`custom:${custom}`}
                className="hover:bg-tray flex w-full items-center px-2 py-1.5 text-left"
                onClick={() => add(custom)}
              >
                <span className="role-data-sm text-muted-foreground font-mono">
                  {addLabel(custom)}
                </span>
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
