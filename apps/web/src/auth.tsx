// SPDX-FileCopyrightText: 2026 sinrimin
//
// SPDX-License-Identifier: MIT

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, TOKEN_KEY, isUnauthorized } from './api.js';
import type { PublicUser } from '@harness-nexus/sdk';

interface AuthState {
  user: PublicUser | null;
  loading: boolean; // initial /me lookup in flight
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string, email?: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(() => !!localStorage.getItem(TOKEN_KEY));

  // On mount, if a token is stored, validate it via /me.
  useEffect(() => {
    if (!localStorage.getItem(TOKEN_KEY)) {
      setLoading(false);
      return;
    }
    api
      .getMe()
      .then((u) => setUser(u))
      .catch(() => {
        // token invalid/expired → drop it
        localStorage.removeItem(TOKEN_KEY);
        api.setToken(undefined);
      })
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const { user } = await api.login(username, password);
    localStorage.setItem(TOKEN_KEY, api.getToken()!);
    setUser(user);
  }, []);

  const register = useCallback(async (username: string, password: string, email?: string) => {
    const { user } = await api.register(username, password, email);
    localStorage.setItem(TOKEN_KEY, api.getToken()!);
    setUser(user);
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_KEY);
    api.setToken(undefined);
    setUser(null);
  }, []);

  // Global 401 interceptor: poll token validity on each render is overkill,
  // so we expose a helper components/hooks use after API calls. The RequireAuth
  // guard also reacts to user becoming null.
  const value = useMemo<AuthState>(
    () => ({ user, loading, login, register, logout }),
    [user, loading, login, register, logout],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>');
  return ctx;
}

/**
 * Call after any SDK call: if it threw with 401, log out. Returns the thrown
 * error unchanged for the caller to also handle.
 */
export async function withAuthGuard<T>(fn: () => Promise<T>, logout: () => void): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    const err = e as { statusCode?: number };
    if (isUnauthorized(err.statusCode ?? 0)) logout();
    throw e;
  }
}
