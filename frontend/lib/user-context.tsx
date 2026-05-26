'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from 'react';
import { usePathname } from 'next/navigation';
import { api, ApiError } from './api';

export type Role = 'USER' | 'UPLOADER' | 'REPORTING' | 'ADMIN';

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  // Only populated for UPLOADER role: the USER ids this assistant is
  // allowed to upload invoices on behalf of. Empty for every other role.
  managedUserIds: string[];
}

interface UserContextValue {
  user: CurrentUser | null;
  loading: boolean;
  // Force a re-fetch (e.g. after the user updates their own profile).
  refresh: () => Promise<void>;
}

const UserContext = createContext<UserContextValue>({
  user: null,
  loading: true,
  refresh: async () => {},
});

// Routes where we shouldn't try to fetch /auth/me — there's no cookie yet.
const PUBLIC_ROUTES = ['/login', '/forgot-password', '/reset-password'];

// Heartbeat cadence. The backend cookie has a 10-minute sliding window
// (see auth/session-config.ts). We ping every 5 minutes when the tab
// is visible so an open-but-idle browser never falls off the wagon.
// Half the cookie TTL gives us one safe retry before expiry.
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

export function UserProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const pathname = usePathname();

  async function fetchMe() {
    setLoading(true);
    try {
      const data = await api<CurrentUser>('/auth/me');
      setUser(data);
    } catch (err) {
      // 401 means we're not logged in — middleware will handle the redirect.
      // Anything else is a real error but we still null out the user.
      if (!(err instanceof ApiError && err.status === 401)) {
        console.error('Failed to load current user:', err);
      }
      setUser(null);
    } finally {
      setLoading(false);
    }
  }

  // Quiet variant used by the heartbeat — doesn't flip `loading` so
  // it can't trigger spinners or layout flashes while the user is
  // working. Errors are swallowed; api() will redirect on 401.
  async function pingMe() {
    try {
      const data = await api<CurrentUser>('/auth/me');
      setUser(data);
    } catch {
      // Ignore — the global 401 handler in lib/api will bounce to /login.
    }
  }

  useEffect(() => {
    // Skip on public routes — no cookie expected, would just 401.
    if (PUBLIC_ROUTES.some((p) => pathname?.startsWith(p))) {
      setLoading(false);
      setUser(null);
      return;
    }
    fetchMe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Heartbeat: keep the cookie's sliding window alive while the tab is
  // visible. Stops when the tab is hidden (no point burning battery for
  // a background tab) and fires once immediately on return-to-foreground
  // so a brief minimise doesn't drop the session.
  useEffect(() => {
    // Skip entirely on public routes / when not logged in.
    if (PUBLIC_ROUTES.some((p) => pathname?.startsWith(p))) return;

    let timer: number | undefined;
    function start() {
      stop();
      // Tick once now in case we just returned from a hidden tab.
      pingMe();
      timer = window.setInterval(pingMe, HEARTBEAT_INTERVAL_MS);
    }
    function stop() {
      if (timer !== undefined) {
        window.clearInterval(timer);
        timer = undefined;
      }
    }
    function handleVisibility() {
      if (document.visibilityState === 'visible') start();
      else stop();
    }

    // Only run the heartbeat while the document is actually visible.
    // Hidden tabs throttle setInterval anyway and there's no benefit
    // to pinging — closing the tab/window IS the trigger we want.
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  return (
    <UserContext.Provider value={{ user, loading, refresh: fetchMe }}>
      {children}
    </UserContext.Provider>
  );
}

// Hook for accessing the current user anywhere in the app.
//
//   const { user, loading } = useCurrentUser();
//   if (user?.role === 'ADMIN') { ... }
export function useCurrentUser() {
  return useContext(UserContext);
}

// Convenience helpers for role checks.
export function isPrivileged(role: Role | undefined | null): boolean {
  return role === 'ADMIN' || role === 'REPORTING';
}

// UPLOADER is an assistant who uploads invoices on behalf of a card
// holder. They should never see monetary totals, balances, recon
// figures, or anyone else's invoices — only the ones THEY uploaded.
export function hidesAmounts(role: Role | undefined | null): boolean {
  return role === 'UPLOADER';
}

// Convenience for "is this role allowed to upload statements / see
// the full company picture". Mirrors the backend's isPrivileged().
export function canSeeAllInvoices(
  role: Role | undefined | null,
): boolean {
  return role === 'ADMIN' || role === 'REPORTING';
}
