import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { api, setUnauthorizedHandler, tokenStore } from '../api/client';
import type { TokenResponse, User } from '../api/types';

interface AuthState {
  user: User | null;
  loading: boolean;
  /** Человек вышел сам: после нового входа — на главную, а не на страницу, с которой он вышел. */
  signedOut: boolean;
  signIn: (token: TokenResponse) => void;
  signOut: () => void;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(() => tokenStore.get() !== null);
  const [signedOut, setSignedOut] = useState(false);

  // Сессия закончилась (401, токен не принят) — после входа человек вернётся туда, где был.
  const drop = useCallback(() => {
    tokenStore.clear();
    setUser(null);
    queryClient.clear();
  }, [queryClient]);

  const signOut = useCallback(() => {
    setSignedOut(true);
    drop();
  }, [drop]);

  const refresh = useCallback(async () => {
    try {
      setUser(await api<User>('/auth/me'));
    } catch {
      drop();
    } finally {
      setLoading(false);
    }
  }, [drop]);

  useEffect(() => {
    setUnauthorizedHandler(drop);
    if (tokenStore.get()) void refresh();
  }, [refresh, drop]);

  const signIn = useCallback(
    (token: TokenResponse) => {
      queryClient.clear();
      tokenStore.set(token.access_token);
      setSignedOut(false);
      setUser(token.user);
    },
    [queryClient],
  );

  const value = useMemo(
    () => ({ user, loading, signedOut, signIn, signOut, refresh }),
    [user, loading, signedOut, signIn, signOut, refresh],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
