'use client';

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

// Lightweight toast system. `useToast()` gives a `notify()` function
// that can be called from anywhere in the tree. Auto-dismisses after
// a per-toast duration (default 4s) and stacks in the top-right.
//
// Semantics:
//   success — green
//   error   — red
//   info    — neutral
//   warn    — amber
//
// Usage:
//   const { notify } = useToast();
//   notify({ kind: 'success', title: 'Matched to Woolworths R213.60' });

type ToastKind = 'success' | 'error' | 'info' | 'warn';

interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
  durationMs?: number;
}

interface ToastContextValue {
  notify(t: Omit<Toast, 'id'>): void;
}

const ToastCtx = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastCtx);
  if (!ctx) {
    // Fall back to console so a component using useToast() outside the
    // provider doesn't crash the whole page during dev.
    return {
      notify: (t) =>
        // eslint-disable-next-line no-console
        console.log(`[toast:${t.kind}] ${t.title}${t.description ? ' — ' + t.description : ''}`),
    };
  }
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const remove = useCallback((id: number) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  const notify = useCallback<ToastContextValue['notify']>(
    (t) => {
      const id = nextId.current++;
      const duration = t.durationMs ?? 4000;
      setToasts((cur) => [...cur, { ...t, id }]);
      if (duration > 0) {
        setTimeout(() => remove(id), duration);
      }
    },
    [remove],
  );

  const value = useMemo(() => ({ notify }), [notify]);

  return (
    <ToastCtx.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={remove} />
    </ToastCtx.Provider>
  );
}

function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div
      className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm pointer-events-none"
      role="region"
      aria-label="Notifications"
    >
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={() => onDismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: () => void;
}) {
  const tone =
    toast.kind === 'success'
      ? 'border-[var(--success)] bg-[var(--success-soft)]'
      : toast.kind === 'error'
        ? 'border-[var(--danger)] bg-[var(--danger-soft)]'
        : toast.kind === 'warn'
          ? 'border-[var(--warn)] bg-[var(--warn-soft)]'
          : 'border-border bg-surface';
  return (
    <div
      className={`toast-in pointer-events-auto rounded-xl border shadow-lg px-3.5 py-3 backdrop-blur-sm ${tone}`}
      role="status"
    >
      <div className="flex items-start gap-2">
        <span className="pt-0.5" aria-hidden>
          {toast.kind === 'success'
            ? '✓'
            : toast.kind === 'error'
              ? '⨯'
              : toast.kind === 'warn'
                ? '!'
                : 'i'}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-fg">{toast.title}</p>
          {toast.description && (
            <p className="text-xs text-fg-muted mt-0.5">
              {toast.description}
            </p>
          )}
        </div>
        <button
          onClick={onDismiss}
          className="text-fg-muted hover:text-fg text-lg leading-none"
          aria-label="Dismiss"
        >
          ×
        </button>
      </div>
    </div>
  );
}

// Handy short-hands so callers don't have to remember the kind names.
export function useToastShortcuts() {
  const { notify } = useToast();
  return useMemo(
    () => ({
      success: (title: string, description?: string) =>
        notify({ kind: 'success', title, description }),
      error: (title: string, description?: string) =>
        notify({ kind: 'error', title, description }),
      info: (title: string, description?: string) =>
        notify({ kind: 'info', title, description }),
      warn: (title: string, description?: string) =>
        notify({ kind: 'warn', title, description }),
    }),
    [notify],
  );
}

