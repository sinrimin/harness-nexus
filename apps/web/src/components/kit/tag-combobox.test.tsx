// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

// @vitest-environment jsdom
/**
 * `TagCombobox` (#56) — the creatable multi-select behind the registry's
 * `serverTools` and `extraBody` keys. The rules that must not rot: presets
 * add as tags, a typed value becomes a CUSTOM tag (the gateway-compat escape
 * hatch), the × removes, already-selected presets leave the list, and Enter
 * commits the typed value verbatim (no first-match guess).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, within } from '@testing-library/react';
import { TagCombobox } from './tag-combobox';

const mount = (
  value: string[],
  options: readonly string[],
): { onChange: ReturnType<typeof vi.fn> } => {
  const onChange = vi.fn();
  render(
    <TagCombobox
      value={value}
      options={options}
      onChange={onChange}
      placeholder="Select or type…"
      addLabel={(v) => `Use “${v}”`}
      removeLabel={(v) => `Remove ${v}`}
    />,
  );
  return { onChange };
};

const input = (): HTMLInputElement => screen.getByRole('combobox') as HTMLInputElement;

describe('TagCombobox', () => {
  afterEach(cleanup);

  it('offers presets on focus; picking one adds a tag and hides it from the list', () => {
    const { onChange } = mount([], ['web_search', 'web_extractor']);
    fireEvent.focus(input());
    expect(screen.getByText('web_search')).toBeTruthy();
    fireEvent.click(screen.getByText('web_search'));
    expect(onChange).toHaveBeenCalledWith(['web_search']);
  });

  it('offers the typed value as a custom row and commits it verbatim on Enter', () => {
    const { onChange } = mount(['web_search'], ['web_search']);
    fireEvent.focus(input());
    fireEvent.change(input(), { target: { value: 'web_fetch_20990101' } });
    const custom = screen.getByText('Use “web_fetch_20990101”');
    expect(custom).toBeTruthy();
    fireEvent.click(custom);
    expect(onChange).toHaveBeenCalledWith(['web_search', 'web_fetch_20990101']);

    // Enter commits the typed value as-is — no first-match guess.
    fireEvent.change(input(), { target: { value: 'vendor/tool' } });
    fireEvent.keyDown(input(), { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith(['web_search', 'vendor/tool']);
  });

  it('filters presets by the query and never lists an already-selected preset', () => {
    mount(['web_search'], ['web_search', 'web_extractor', 'code_interpreter']);
    fireEvent.focus(input());
    // The SELECTED tag renders the same text — list membership is asserted
    // within the listbox only.
    const list = within(screen.getByRole('listbox'));
    expect(list.queryByText('web_search')).toBeNull(); // selected → gone
    expect(list.getByText('web_extractor')).toBeTruthy();
    fireEvent.change(input(), { target: { value: 'code' } });
    expect(list.queryByText('web_extractor')).toBeNull(); // filtered out
    expect(list.getByText('code_interpreter')).toBeTruthy();
  });

  it('the × on a tag removes exactly that tag', () => {
    const { onChange } = mount(['web_search', 'web_extractor'], ['web_search', 'web_extractor']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove web_search' }));
    expect(onChange).toHaveBeenCalledWith(['web_extractor']);
  });

  it('Backspace on an empty input removes the last tag; Escape closes the list', () => {
    const { onChange } = mount(['web_search', 'web_extractor'], ['web_search', 'web_extractor']);
    fireEvent.focus(input());
    fireEvent.keyDown(input(), { key: 'Backspace' });
    expect(onChange).toHaveBeenCalledWith(['web_search']);
    fireEvent.keyDown(input(), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
