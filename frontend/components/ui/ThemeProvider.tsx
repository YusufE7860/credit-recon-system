'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

// Very small theme provider. Three states:
//   'light'  — force light regardless of OS
//   'dark'   — force dark regardless of OS
//   'system' — follow prefers-color-scheme
//
// Persists the chosen mode in localStorage under `ffg-theme`. The
// actual switch is done by toggling a `dark` class on <html> which
// our Tailwind v4 custom variant (@custom-variant dark) picks up.

export type ThemeMode = 'light' | 'dark' | 'system';

interface ThemeContextValue {
  mode: ThemeMode;
  resolved: 'light' | 'dark';
  setMode(m: ThemeMode): void;
  toggle(): void;
}

const STORAGE_KEY = 'ffg-theme';
const ThemeCtx = createContext<ThemeContextValue | null>(null);

function readInitial(): ThemeMode {
  if (typeof window === 'undefined') return 'system';
  const v = window.localStorage.getItem(STORAGE_KEY);
  if (v === 'light' || v === 'dark' || v === 'system') return v;
  return 'system';
}

function resolve(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') {
    if (typeof window === 'undefined') return 'light';
    return window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }
  return mode;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Start with 'system' during SSR so the server-rendered markup is
  // deterministic. The effect below reads the real preference on mount.
  const [mode, setModeState] = useState<ThemeMode>('system');

  useEffect(() => {
    setModeState(readInitial());
  }, []);

  // Apply the resolved theme to <html>.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const resolved = resolve(mode);
    document.documentElement.classList.toggle('dark', resolved === 'dark');
  }, [mode]);

  // Follow the OS if we're in system mode.
  useEffect(() => {
    if (mode !== 'system' || typeof window === 'undefined') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      document.documentElement.classList.toggle('dark', mq.matches);
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [mode]);

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(STORAGE_KEY, m);
    }
  }, []);

  const toggle = useCallback(() => {
    // Simple three-way toggle: light → dark → system → light.
    setModeState((cur) => {
      const next: ThemeMode =
        cur === 'light' ? 'dark' : cur === 'dark' ? 'system' : 'light';
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(STORAGE_KEY, next);
      }
      return next;
    });
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      resolved: resolve(mode),
      setMode,
      toggle,
    }),
    [mode, setMode, toggle],
  );

  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeCtx);
  if (!ctx) {
    // Safe fallback so components can call useTheme() even outside
    // the provider (e.g. during a Storybook-style render).
    return {
      mode: 'system',
      resolved: 'light',
      setMode: () => {},
      toggle: () => {},
    };
  }
  return ctx;
}

// Small inline script placed into <head> to set the class BEFORE
// React hydrates — prevents the "flash of light theme" when the
// stored preference is dark. Export as a string so RootLayout can
// inject it via <script dangerouslySetInnerHTML>.
export const themeBootstrapScript = `
(function(){
  try {
    var m = localStorage.getItem('ffg-theme');
    var dark = m === 'dark' || (m !== 'light' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) document.documentElement.classList.add('dark');
  } catch (e) {}
})();
`;
