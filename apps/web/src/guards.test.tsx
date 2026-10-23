// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '@/i18n';
import { RequireAdmin } from './guards';

/**
 * The 403 guard's structure — a regression pin for the account-switch bug:
 * RequireAdmin is mounted INSIDE the routes' ShellLayout, so its denial view
 * must be bare CONTENT. It once rendered a second <AppShell>, which stacked a
 * whole console inside the console (sidebar in sidebar, two topbars).
 *
 * The auth module is mocked: this asserts the guard's own tree, not the
 * provider's session handling.
 */
vi.mock('./auth.js', () => ({
  useAuth: () => ({ user: { role: 'user' }, loading: false }),
}));

afterEach(cleanup);

describe('RequireAdmin', () => {
  it('renders the 403 panel as content — never a nested console shell', () => {
    const { container } = render(
      <I18nProvider>
        <MemoryRouter>
          <RequireAdmin>
            <div data-testid="admin-page">secret</div>
          </RequireAdmin>
        </MemoryRouter>
      </I18nProvider>,
    );
    // The denied view is there…
    expect(screen.queryByTestId('admin-page')).toBeNull();
    expect(container.textContent).toMatch(/Admins only|仅限管理员/);
    // …and it brings NO chrome of its own: the shell's nav, spine and
    // readout strip are landmarks/elements the guard must not re-render.
    for (const region of ['chrome', 'spine', 'header', 'nav', 'watchbar', 'navstrip']) {
      expect(container.querySelector(`[data-region="${region}"]`)).toBeNull();
    }
  });
});
