import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { api, setUnauthorizedHandler, tokenStore } from '../api/client';
import type { TokenResponse, User } from '../api/types';

interface AuthState {
  user: User | null;
  loading: boolean;
  signIn: (token: TokenResponse) => void;
  signOut: () => void;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(() => tokenStore.get() !== null);

  const signOut = useCallback(() => {
    tokenStore.clear();
    setUser(null);
    queryClient.clear();
  }, [queryClient]);

  const refresh = useCallback(async () => {
    try {
      setUser(await api<User>('/auth/me'));
    } catch {
      signOut();
    } finally {
      setLoading(false);
    }
  }, [signOut]);

  useEffect(() => {
    setUnauthorizedHandler(signOut);
    if (tokenStore.get()) void refresh();
  }, [refresh, signOut]);

  const signIn = useCallback(
    (token: TokenResponse) => {
      queryClient.clear();
      tokenStore.set(token.access_token);
      setUser(token.user);
    },
    [queryClient],
  );

  const value = useMemo(() => ({ user, loading, signIn, signOut, refresh }), [user, loading, signIn, signOut, refresh]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
