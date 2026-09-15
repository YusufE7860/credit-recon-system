'use client';

import { useTheme } from './ThemeProvider';

// Compact segmented control for the sidebar / top bar. Three states,
// icons only, keyboard-accessible via the underlying buttons.

export default function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { mode, setMode } = useTheme();
  const items: Array<{ value: 'light' | 'dark' | 'system'; icon: React.ReactNode; label: string }> = [
    { value: 'light', icon: <SunIcon />, label: 'Light' },
    { value: 'dark', icon: <MoonIcon />, label: 'Dark' },
    { value: 'system', icon: <SystemIcon />, label: 'System' },
  ];
  return (
    <div
      className={`inline-flex items-center gap-0.5 rounded-full border border-border bg-surface p-0.5 ${
        compact ? 'text-xs' : 'text-sm'
      }`}
      role="radiogroup"
      aria-label="Theme"
    >
      {items.map((it) => {
        const active = mode === it.value;
        return (
          <button
            key={it.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={it.label}
            onClick={() => setMode(it.value)}
            className={`w-7 h-7 flex items-center justify-center rounded-full transition ${
              active
                ? 'bg-brand text-brand-fg'
                : 'text-fg-muted hover:text-fg hover:bg-surface-2'
            }`}
          >
            {it.icon}
          </button>
        );
      })}
    </div>
  );
}

function SunIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function SystemIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}
