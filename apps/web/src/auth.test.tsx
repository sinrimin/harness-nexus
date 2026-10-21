// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

// @vitest-environment jsdom
/**
 * #77 — the auth identity change must drop the /app socket singleton: the
 * connection authenticates only at connect time, so a socket that survives
 * logout keeps speaking for the PREVIOUS user (freshly mounted pages would
 * sync the old identity's rooms). logout, login and register all drop it.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';

const dropAppSocket = vi.fn();

vi.mock('./realtime.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./realtime.js')>();
  return { ...original, dropAppSocket };
});

const login = vi.fn();
const register = vi.fn();

vi.mock('./api.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./api.js')>();
  // Keep the prototype methods (getToken/setToken/… live on the class
  // prototype — a spread would drop them), stub only the auth endpoints.
  const api = Object.assign(Object.create(Object.getPrototypeOf(original.api)), original.api, {
    login,
    register,
  });
  return { ...original, api };
});

const { AuthProvider, useAuth } = await import('./auth.js');

interface AuthProbe {
  doLogin: (username: string, password: string) => Promise<void>;
  doRegister: (username: string, password: string, email?: string) => Promise<void>;
  logout: () => void;
}
let probe: AuthProbe | null = null;

function Probe(): null {
  const { login: doLogin, register: doRegister, logout } = useAuth();
  probe = { doLogin, doRegister, logout };
  return null;
}

beforeEach(() => {
  dropAppSocket.mockClear();
  login.mockReset();
  register.mockReset();
  localStorage.clear();
  probe = null;
});

describe('#77 — auth changes drop the app socket', () => {
  it('logout drops the singleton connection', async () => {
    login.mockResolvedValue({ token: 't1', user: { id: 'u1', username: 'a', role: 'user' } });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    const auth = probe!;
    await act(async () => {
      await auth.doLogin('a', 'pw');
    });
    expect(dropAppSocket).toHaveBeenCalledTimes(1); // the login itself drops

    dropAppSocket.mockClear();
    act(() => {
      auth.logout();
    });
    expect(dropAppSocket).toHaveBeenCalledTimes(1);
  });

  it('register drops it too', async () => {
    register.mockResolvedValue({ token: 't2', user: { id: 'u2', username: 'b', role: 'user' } });
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
    const auth = probe!;
    await act(async () => {
      await auth.doRegister('b', 'pw');
    });
    expect(dropAppSocket).toHaveBeenCalledTimes(1);
  });
});
