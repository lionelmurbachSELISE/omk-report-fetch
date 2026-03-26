import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { login as seliseLogin, logout as seliseLogout, refreshTokens, AuthSession, SeliseUser } from "./selise";

const STORAGE_KEY = "selise_auth";
const REFRESH_BUFFER_MS = 60_000; // refresh 1 min before expiry

interface AuthState {
  user: SeliseUser | null;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
}

interface AuthContextValue {
  user: SeliseUser | null;
  isAuthenticated: boolean;
  accessToken: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

function loadPersistedAuth(): AuthState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { user: null, accessToken: null, refreshToken: null, expiresAt: null };
    return JSON.parse(raw) as AuthState;
  } catch {
    return { user: null, accessToken: null, refreshToken: null, expiresAt: null };
  }
}

function persistAuth(state: AuthState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function clearAuth() {
  localStorage.removeItem(STORAGE_KEY);
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>(loadPersistedAuth);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleRefresh = useCallback((expiresAt: number, currentRefreshToken: string) => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    const delay = expiresAt - Date.now() - REFRESH_BUFFER_MS;
    if (delay <= 0) return;
    refreshTimerRef.current = setTimeout(async () => {
      try {
        const tokens = await refreshTokens(currentRefreshToken);
        const newExpiresAt = Date.now() + tokens.expiresIn * 1000;
        setState((prev) => {
          const next = { ...prev, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: newExpiresAt };
          persistAuth(next);
          scheduleRefresh(newExpiresAt, tokens.refreshToken);
          return next;
        });
      } catch {
        clearAuth();
        setState({ user: null, accessToken: null, refreshToken: null, expiresAt: null });
      }
    }, delay);
  }, []);

  // On mount, schedule refresh if we have a valid session
  useEffect(() => {
    if (state.expiresAt && state.refreshToken && state.expiresAt > Date.now()) {
      scheduleRefresh(state.expiresAt, state.refreshToken);
    } else if (state.expiresAt && state.expiresAt <= Date.now()) {
      // Token expired — clear
      clearAuth();
      setState({ user: null, accessToken: null, refreshToken: null, expiresAt: null });
    }
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const session: AuthSession = await seliseLogin(email, password);
    const expiresAt = Date.now() + session.tokens.expiresIn * 1000;
    const next: AuthState = {
      user: session.user,
      accessToken: session.tokens.accessToken,
      refreshToken: session.tokens.refreshToken,
      expiresAt,
    };
    persistAuth(next);
    setState(next);
    scheduleRefresh(expiresAt, session.tokens.refreshToken);
  }, [scheduleRefresh]);

  const logout = useCallback(async () => {
    if (state.refreshToken) {
      await seliseLogout(state.refreshToken);
    }
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    clearAuth();
    setState({ user: null, accessToken: null, refreshToken: null, expiresAt: null });
  }, [state.refreshToken]);

  return (
    <AuthContext.Provider
      value={{
        user: state.user,
        isAuthenticated: !!state.accessToken && !!state.expiresAt && state.expiresAt > Date.now(),
        accessToken: state.accessToken,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
