import type { ReactNode } from 'react';

// Modernized surface primitive. Replaces the ad-hoc
// `bg-white rounded-xl shadow p-4` chain that was sprinkled across
// every page. Uses the semantic --surface / --border tokens so it
// adapts automatically to dark mode.

type CardProps = {
  children: ReactNode;
  className?: string;
  padding?: 'none' | 'sm' | 'md' | 'lg';
};

const PADDING = {
  none: '',
  sm: 'p-3',
  md: 'p-4 md:p-5',
  lg: 'p-6 md:p-8',
};

export function Card({ children, className = '', padding = 'md' }: CardProps) {
  return (
    <section
      className={[
        'bg-surface border border-border rounded-2xl shadow-sm',
        PADDING[padding],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </section>
  );
}

/** Section header used inside a Card. Small label + optional action slot. */
export function CardHeader({
  title,
  subtitle,
  action,
  className = '',
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={`flex items-start justify-between gap-3 mb-3 ${className}`}
    >
      <div className="min-w-0">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-fg-muted">
          {title}
        </h2>
        {subtitle && (
          <p className="text-xs text-fg-subtle mt-0.5">{subtitle}</p>
        )}
      </div>
      {action && <div className="flex-shrink-0">{action}</div>}
    </header>
  );
}

/** A single stat cell — the compact "label + big number + delta" block
 *  used on dashboards. Accepts an optional href to become clickable. */
export function StatBlock({
  label,
  value,
  hint,
  delta,
  tone = 'default',
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  delta?: { pct: number; up: boolean; goodWhenUp?: boolean } | null;
  tone?: 'default' | 'success' | 'warn' | 'danger';
}) {
  const toneClass =
    tone === 'success'
      ? 'text-[var(--success)]'
      : tone === 'warn'
        ? 'text-[var(--warn)]'
        : tone === 'danger'
          ? 'text-[var(--danger)]'
          : 'text-fg';

  const chipTone =
    delta &&
    // If the caller says "up is good" (e.g. matched rate), flip the colour.
    (delta.up === (delta.goodWhenUp ?? false)
      ? 'bg-[var(--success-soft)] text-[var(--success)]'
      : 'bg-[var(--danger-soft)] text-[var(--danger)]');

  return (
    <div>
      <p className="text-[11px] uppercase tracking-wider text-fg-muted">
        {label}
      </p>
      <p className={`text-2xl font-semibold mt-1 ${toneClass}`}>{value}</p>
      <div className="mt-1.5 flex items-center gap-2 text-xs">
        {hint && <span className="text-fg-subtle">{hint}</span>}
        {delta && (
          <span
            className={`px-1.5 py-0.5 rounded font-semibold ${chipTone}`}
          >
            {delta.up ? '▲' : '▼'} {delta.pct.toFixed(0)}%
          </span>
        )}
      </div>
    </div>
  );
}
