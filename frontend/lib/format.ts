// Shared formatters. Import from here instead of hand-rolling
// toLocaleString in every component so the app has one consistent
// look for money, dates and percentages.

/** Format a number as ZAR with the FFG house style: `R 1 234,56`. */
export function fmtZAR(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return 'R —';
  return `R ${n.toLocaleString('en-ZA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Format a number as a currency amount with an explicit currency code. */
export function fmtMoney(n: number | null | undefined, currency = 'ZAR'): string {
  if (n === null || n === undefined || Number.isNaN(n)) return `${currency} —`;
  const body = n.toLocaleString('en-ZA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return currency === 'ZAR' ? `R ${body}` : `${currency} ${body}`;
}

/** DD MMM YYYY, e.g. "14 Sep 2026". Locale-stable so it doesn't shift
 *  under different browser locales. */
export function fmtDate(input: string | Date | null | undefined): string {
  if (!input) return '—';
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-ZA', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

/** Short "14 Sep, 09:42" for activity feeds. */
export function fmtDateTime(input: string | Date | null | undefined): string {
  if (!input) return '—';
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return '—';
  return (
    d.toLocaleDateString('en-ZA', { day: '2-digit', month: 'short' }) +
    ', ' +
    d.toLocaleTimeString('en-ZA', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
  );
}

/** "3 days ago" style. Small helper for activity feeds. */
export function fmtRelative(input: string | Date | null | undefined): string {
  if (!input) return '—';
  const d = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(d.getTime())) return '—';
  const diffMs = Date.now() - d.getTime();
  const sec = Math.round(diffMs / 1000);
  if (sec < 45) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.round(hr / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks}w ago`;
  return fmtDate(d);
}

/** 0.72 → "72%". */
export function fmtPct(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}

/** Initials from a name, capped at 2 letters. */
export function initialsFor(name: string | undefined | null): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
