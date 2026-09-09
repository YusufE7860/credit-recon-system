'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  PieChart, Pie, Cell,
  BarChart, Bar, XAxis, YAxis, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts';
import Sidebar from '@/components/Sidebar';
import { StatusBadge } from '@/components/StatusBadge';
import { api } from '@/lib/api';
import { useCurrentUser } from '@/lib/user-context';

// ---------- Types matching the backend response ----------

type Summary = {
  // Echoed period — useful to confirm what the user picked.
  range: { from: string; to: string };
  totalTransactions: number;
  totalInvoices: number;
  flaggedTransactions: number;
  unassignedCards: number;
  totalPurchases: number;
  totalRefunds: number;
  netSpend: number;
  totalVat: number;
  // Statement vs invoice trio — the actionable comparison.
  // statementSpend = what the bank says was spent (positive only).
  // invoiceTotal = sum of Invoice.totalZAR (fallback to .total).
  // outstandingReceipts = statementSpend - invoiceTotal.
  statementSpend: number;
  invoiceTotal: number;
  outstandingReceipts: number;
  // Coverage caveat for the gap. 'none' = no statement uploaded for
  // this period yet, so the gap is meaningless. 'partial' = statements
  // overlap but don't fully cover [from, to]. 'full' = at least one
  // statement covers the whole window.
  statementCoverage: 'none' | 'partial' | 'full';
  recon: {
    matched: number;
    unmatched: number;
    pending: number;
    disputed: number;
    rejected: number;
    matchedRate: number;
  };
  spendByCategory: Array<{ category: string; total: number; count: number }>;
  spendByMonth: Array<{ month: string; total: number; count: number }>;
  // Split-cycle breakdown — populated only when the picked period
  // spans more than one calendar month (statement cycles typically do).
  spendByCalendarMonth: Array<{ month: string; total: number }>;
  recentTransactions: Array<{
    id: string;
    merchant: string;
    amount: number;
    transactionDate: string;
    cardLast4: string | null;
  }>;
  recentInvoices: Array<{
    id: string;
    supplier: string;
    total: number;
    invoiceDate: string;
    status: string;
  }>;
};

// Palette for the category pie. Cycles if we have more categories than colors.
const PIE_COLORS = [
  '#0f172a', '#1e293b', '#475569', '#64748b',
  '#94a3b8', '#f59e0b', '#ef4444', '#10b981',
  '#3b82f6', '#a855f7',
];

const fmtZAR = (n: number) =>
  'R ' + n.toLocaleString('en-ZA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

// ---------- Date helpers (mirror the Reports page) ----------
// Local-time formatting so a JHB user picking "2026-05-01" doesn't
// get the previous day after a UTC shift.
function isoDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
function isoMonthStart(d: Date): string {
  return isoDate(new Date(d.getFullYear(), d.getMonth(), 1));
}
function presetThisMonth(): [string, string] {
  const now = new Date();
  return [isoMonthStart(now), isoDate(now)];
}
function presetLastMonth(): [string, string] {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const end = new Date(now.getFullYear(), now.getMonth(), 0);
  return [isoDate(start), isoDate(end)];
}
function presetLast3Months(): [string, string] {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  return [isoDate(start), isoDate(now)];
}
function presetYTD(): [string, string] {
  const now = new Date();
  return [isoDate(new Date(now.getFullYear(), 0, 1)), isoDate(now)];
}

export default function Dashboard() {
  const router = useRouter();
  const { user: currentUser } = useCurrentUser();

  // UPLOADERs must never land on the dashboard — it shows monetary
  // totals (net spend, VAT, recon $ figures). Bounce them straight
  // to the upload page where their actual work lives.
  useEffect(() => {
    if (currentUser?.role === 'UPLOADER') {
      router.replace('/upload');
    }
  }, [currentUser?.role, router]);

  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);

  // Live-spend tracker — per-card creditLimit / liveSpend / available.
  // Refetches on the same triggers as the summary so a fresh statement
  // upload (which advances the cycle boundary) shows up immediately.
  type LiveSpendRow = {
    cardId: string;
    cardName: string;
    cardholderName: string | null;
    last4: string | null;
    assignedUserId: string | null;
    creditLimit: number | null;
    lastCycleEnd: string | null;
    liveSpend: number;
    available: number | null;
  };
  const [liveSpend, setLiveSpend] = useState<LiveSpendRow[]>([]);
  const [error, setError] = useState('');

  // Dashboard date range picker. Default is the LATEST STATEMENT'S
  // PERIOD (e.g. 25 Jun → 24 Jul) rather than the calendar month —
  // most users land here expecting to see the last billing cycle,
  // and calendar months always look empty for the first week of the
  // month (before the new statement lands). Falls back to "This
  // month" if no statements exist yet.
  const [from, setFrom] = useState<string>(() => isoMonthStart(new Date()));
  const [to, setTo] = useState<string>(() => isoDate(new Date()));
  const [defaultsApplied, setDefaultsApplied] = useState(false);

  // Statement dropdown for jumping to a specific billing cycle. Fetched
  // on mount from /statements (last N most-recent first).
  type StatementOption = {
    id: string;
    statementName: string;
    periodStart: string | null;
    periodEnd: string | null;
  };
  const [statements, setStatements] = useState<StatementOption[]>([]);
  const [selectedStatementId, setSelectedStatementId] = useState<string>('');

  // Admin-only: narrow the dashboard to a specific cardholder.
  type UserOption = { id: string; name: string; email: string };
  const [users, setUsers] = useState<UserOption[]>([]);
  const [filterUserId, setFilterUserId] = useState<string>('');
  const isPrivileged = currentUser?.role === 'ADMIN' || currentUser?.role === 'REPORTING';

  async function loadSummary() {
    try {
      const params = new URLSearchParams({ from, to });
      if (filterUserId) params.set('userId', filterUserId);
      // Parallel — summary + live-spend refresh together on any change.
      const [data, ls] = await Promise.all([
        api<Summary>(`/dashboard/summary?${params.toString()}`),
        api<LiveSpendRow[]>('/cards/live-spend').catch(() => []),
      ]);
      setSummary(data);
      setLiveSpend(ls);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // On mount: fetch statements (for the dropdown + default period) and
  // — for admins — the users list (for the cardholder filter). Both
  // fail silently: dashboard falls back to today's calendar month if
  // /statements returns nothing.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await api<StatementOption[]>('/statements');
        if (cancelled) return;
        setStatements(rows);
        // Pick the most recent statement (by periodEnd desc) with a
        // known period, and use it as the initial dashboard range.
        const dated = rows
          .filter((r) => r.periodStart && r.periodEnd)
          .sort((a, b) =>
            (b.periodEnd ?? '').localeCompare(a.periodEnd ?? ''),
          );
        if (dated.length > 0) {
          const latest = dated[0];
          setFrom(latest.periodStart!.slice(0, 10));
          setTo(latest.periodEnd!.slice(0, 10));
          setSelectedStatementId(latest.id);
        }
      } catch {
        // Ignore — dashboard shows the calendar-month default instead.
      } finally {
        if (!cancelled) setDefaultsApplied(true);
      }
    })();
    if (isPrivileged) {
      api<UserOption[]>('/users')
        .then((rows) => {
          if (!cancelled) setUsers(rows);
        })
        .catch(() => {
          /* silent */
        });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPrivileged]);

  // Refetch whenever the date range OR user filter changes. We wait
  // for the initial statement lookup to finish before the first fetch
  // so we don't briefly load "this month" and then flick to the
  // statement period a moment later.
  useEffect(() => {
    if (!defaultsApplied) return;
    setLoading(true);
    loadSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, filterUserId, defaultsApplied]);

  // Recon is now triggered from Reports > Recon tab. The dashboard
  // is read-only.

  if (loading) {
    return (
      <main className="flex min-h-screen bg-gray-100">
        <Sidebar />
        <section className="flex-1 min-w-0 p-4 pt-16 md:p-8">Loading dashboard...</section>
      </main>
    );
  }

  if (error || !summary) {
    return (
      <main className="flex min-h-screen bg-gray-100">
        <Sidebar />
        <section className="flex-1 min-w-0 p-4 pt-16 md:p-8">
          <p className="text-red-600">
            {error || 'Failed to load dashboard data.'}
          </p>
        </section>
      </main>
    );
  }

  const matchedPct = (summary.recon.matchedRate * 100).toFixed(0);

  return (
    <main className="flex min-h-screen bg-gray-100">
      <Sidebar />

      <section className="flex-1 min-w-0 p-4 pt-16 md:p-8 space-y-6">
        {/* Header */}
        {/* Run-Reconciliation button moved out — admins now run recons
            from Reports > Recon tab (single source of truth, with the
            full source / scope / per-cardholder options). */}
        <div>
          <h1 className="text-3xl font-bold">Dashboard</h1>
          <p className="text-gray-600 mt-1">
            Overview of your spending, invoices, and reconciliation status
          </p>
        </div>

        {/* Date range bar — every stat below recomputes against this
            window. Default is the current calendar month. */}
        <div className="bg-white rounded-xl shadow p-4">
          <div className="flex flex-wrap gap-2 items-center">
            <label className="text-sm font-medium text-gray-700">From:</label>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
            <label className="text-sm font-medium text-gray-700 ml-2">To:</label>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
            <div className="flex gap-1 ml-auto">
              <button
                onClick={() => { const [f, t] = presetThisMonth(); setFrom(f); setTo(t); }}
                className="text-xs bg-gray-100 hover:bg-gray-200 px-3 py-1.5 rounded transition"
              >This month</button>
              <button
                onClick={() => { const [f, t] = presetLastMonth(); setFrom(f); setTo(t); }}
                className="text-xs bg-gray-100 hover:bg-gray-200 px-3 py-1.5 rounded transition"
              >Last month</button>
              <button
                onClick={() => { const [f, t] = presetLast3Months(); setFrom(f); setTo(t); }}
                className="text-xs bg-gray-100 hover:bg-gray-200 px-3 py-1.5 rounded transition"
              >Last 3</button>
              <button
                onClick={() => { const [f, t] = presetYTD(); setFrom(f); setTo(t); }}
                className="text-xs bg-gray-100 hover:bg-gray-200 px-3 py-1.5 rounded transition"
              >YTD</button>
            </div>
          </div>

          {/* Statement + cardholder row. Statement dropdown lets users
              jump to any past billing cycle in one click (their bank's
              cycles rarely line up with calendar months, so calendar
              presets often produce empty views). Cardholder filter is
              admin-only. Both live below the date row so the direct
              From/To inputs stay the primary controls. */}
          {(statements.length > 0 || isPrivileged) && (
            <div className="flex flex-wrap gap-2 items-center mt-3 pt-3 border-t border-gray-100">
              {statements.length > 0 && (
                <>
                  <label className="text-sm font-medium text-gray-700">
                    Statement:
                  </label>
                  <select
                    value={selectedStatementId}
                    onChange={(e) => {
                      const id = e.target.value;
                      setSelectedStatementId(id);
                      if (!id) return;
                      const s = statements.find((r) => r.id === id);
                      if (s?.periodStart && s?.periodEnd) {
                        setFrom(s.periodStart.slice(0, 10));
                        setTo(s.periodEnd.slice(0, 10));
                      }
                    }}
                    className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 max-w-xs"
                  >
                    <option value="">— Custom range —</option>
                    {statements.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.statementName}
                        {s.periodStart && s.periodEnd
                          ? ` (${new Date(s.periodStart).toLocaleDateString('en-ZA')} → ${new Date(s.periodEnd).toLocaleDateString('en-ZA')})`
                          : ''}
                      </option>
                    ))}
                  </select>
                </>
              )}
              {isPrivileged && (
                <>
                  <label className="text-sm font-medium text-gray-700 ml-2">
                    Cardholder:
                  </label>
                  <select
                    value={filterUserId}
                    onChange={(e) => setFilterUserId(e.target.value)}
                    className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 max-w-xs"
                  >
                    <option value="">All cardholders</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name}
                      </option>
                    ))}
                  </select>
                  {filterUserId && (
                    <button
                      onClick={() => setFilterUserId('')}
                      className="text-xs text-gray-600 hover:text-black"
                    >
                      Clear
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* Live spend tracker — per-card usage during the current
            billing cycle (invoices dated after each card's last
            statement periodEnd). Cards without a set credit limit are
            hidden so the widget stays useful; admin fills in the limit
            on the Cards page. Section itself hidden when there are no
            visible cards. */}
        {liveSpend.filter((c) => c.creditLimit != null).length > 0 && (
          <div className="bg-white rounded-xl shadow p-4">
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wider">
                Live spend tracker
              </h2>
              <p className="text-xs text-gray-500">
                Resets when a new statement is uploaded
              </p>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {liveSpend
                .filter((c) => c.creditLimit != null)
                .map((c) => {
                  const limit = c.creditLimit!;
                  const used = Math.max(0, c.liveSpend);
                  const pct = Math.min(100, (used / limit) * 100);
                  const over = c.liveSpend > limit;
                  const near = pct >= 80 && !over;
                  return (
                    <div
                      key={c.cardId}
                      className={`rounded-lg border p-3 ${
                        over
                          ? 'border-red-300 bg-red-50'
                          : near
                          ? 'border-orange-300 bg-orange-50'
                          : 'border-gray-200'
                      }`}
                    >
                      <div className="flex justify-between items-start">
                        <p className="text-sm font-medium truncate">
                          {c.cardName}
                          {c.last4 && (
                            <span className="text-gray-500">
                              {' '}
                              …{c.last4}
                            </span>
                          )}
                        </p>
                        <p className="text-xs text-gray-500 whitespace-nowrap ml-2">
                          of {fmtZAR(limit)}
                        </p>
                      </div>
                      <p className="text-lg font-bold mt-1">
                        {fmtZAR(used)}
                      </p>
                      <div className="h-1.5 bg-gray-200 rounded-full mt-2 overflow-hidden">
                        <div
                          className={`h-full ${over ? 'bg-red-600' : near ? 'bg-orange-500' : 'bg-black'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <p
                        className={`text-xs mt-1.5 ${
                          over
                            ? 'text-red-700 font-medium'
                            : near
                            ? 'text-orange-700'
                            : 'text-gray-600'
                        }`}
                      >
                        {over
                          ? `${fmtZAR(c.liveSpend - limit)} over limit`
                          : `${fmtZAR(c.available ?? 0)} available`}
                        {c.lastCycleEnd && (
                          <span className="text-gray-500">
                            {' '}· since{' '}
                            {new Date(c.lastCycleEnd).toLocaleDateString(
                              'en-ZA',
                              { day: '2-digit', month: 'short' },
                            )}
                          </span>
                        )}
                      </p>
                    </div>
                  );
                })}
            </div>
          </div>
        )}

        {/* Cards without a limit set — nudge admin to fill them in.
            Only rendered when there's at least one such card and the
            user is privileged (regular USERs can't edit cards). */}
        {isPrivileged &&
          liveSpend.some((c) => c.creditLimit == null) && (
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 text-sm text-blue-900">
              <strong>
                {liveSpend.filter((c) => c.creditLimit == null).length}
              </strong>{' '}
              card
              {liveSpend.filter((c) => c.creditLimit == null).length === 1
                ? ''
                : 's'}{' '}
              without a credit limit — they won't appear in the live
              spend tracker until a limit is set.{' '}
              <Link
                href="/cards"
                className="underline hover:no-underline font-medium"
              >
                Set limits →
              </Link>
            </div>
          )}

        {/* Alerts */}
        {summary.unassignedCards > 0 && (
          <div className="bg-orange-50 border border-orange-200 rounded-xl p-4 flex justify-between items-center">
            <p className="text-sm text-orange-900">
              <strong>{summary.unassignedCards}</strong> card
              {summary.unassignedCards === 1 ? ' is' : 's are'} unassigned —
              their transactions are flagged for review.
            </p>
            <Link
              href="/cards"
              className="text-sm text-orange-900 underline hover:no-underline"
            >
              Manage cards →
            </Link>
          </div>
        )}

        {/* Statement vs invoices — the actionable trio. We show the
            statement spend whenever there are any transactions in the
            period (since those came FROM a statement) — coverage flag
            is just a small caveat below the number now, not a reason
            to hide useful data. */}
        <div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <SummaryCard
              label="Statement spend"
              value={
                summary.totalTransactions === 0
                  ? '—'
                  : fmtZAR(summary.statementSpend)
              }
              sub={
                summary.totalTransactions === 0
                  ? 'No transactions in this period'
                  : summary.statementCoverage === 'partial'
                  ? `${summary.totalTransactions} transactions · partial coverage`
                  : summary.statementCoverage === 'none'
                  ? `${summary.totalTransactions} transactions`
                  : `${summary.totalTransactions} transactions · what the bank says`
              }
              // Split-cycle breakdown. When the selected period spans
              // more than one calendar month (statement cycles usually
              // do: 25 Jun → 24 Jul), show a small breakdown chip so
              // the accountant can see how the total splits by month
              // for month-end journals. Empty otherwise.
              footer={
                summary.spendByCalendarMonth.length > 1
                  ? (
                      <p className="text-xs text-gray-500 mt-1">
                        {summary.spendByCalendarMonth
                          .map(
                            (m) =>
                              `${fmtZAR(m.total)} in ${new Date(m.month + '-01').toLocaleString('en-ZA', { month: 'short' })}`,
                          )
                          .join(' · ')}
                      </p>
                    )
                  : null
              }
            />
            <SummaryCard
              label="Invoices uploaded"
              value={fmtZAR(summary.invoiceTotal)}
              sub={`${summary.totalInvoices} invoice${summary.totalInvoices === 1 ? '' : 's'} in period`}
            />
            <SummaryCard
              label="Outstanding receipts"
              value={
                summary.totalTransactions === 0
                  ? '—'
                  : fmtZAR(Math.max(summary.outstandingReceipts, 0))
              }
              sub={
                summary.totalTransactions === 0
                  ? 'No transactions yet'
                  : summary.outstandingReceipts > 0
                  ? 'Upload these receipts to close the gap'
                  : summary.outstandingReceipts < 0
                  ? `More invoices than statement — ${fmtZAR(Math.abs(summary.outstandingReceipts))} extra (cash receipts?)`
                  : 'All caught up — every transaction has a receipt'
              }
              highlight={
                summary.totalTransactions > 0 &&
                summary.outstandingReceipts > 0
                  ? 'orange'
                  : undefined
              }
            />
          </div>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
          <SummaryCard
            label="Net spend"
            value={fmtZAR(summary.netSpend)}
            sub={`${summary.totalTransactions} transactions`}
          />
          <SummaryCard
            label="Total VAT"
            value={fmtZAR(summary.totalVat)}
            sub={`across ${summary.totalInvoices} invoices`}
          />
          <SummaryCard
            label="Matched rate"
            value={`${matchedPct}%`}
            sub={`${summary.recon.matched} of ${summary.totalInvoices} invoices`}
            highlight={summary.totalInvoices > 0 && summary.recon.matchedRate < 0.5 ? 'orange' : undefined}
          />
          <SummaryCard
            label="Flagged"
            value={String(summary.flaggedTransactions)}
            sub="transactions need review"
            highlight={summary.flaggedTransactions > 0 ? 'orange' : undefined}
          />
        </div>

        {/* Charts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Spend by category */}
          <div className="bg-white rounded-xl shadow p-6">
            <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wider mb-4">
              Spend by category
            </h2>
            {summary.spendByCategory.length === 0 ? (
              <p className="text-gray-400 text-sm">
                No transactions yet.
              </p>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie
                    data={summary.spendByCategory}
                    dataKey="total"
                    nameKey="category"
                    cx="50%"
                    cy="50%"
                    outerRadius={100}
                  >
                    {summary.spendByCategory.map((_, i) => (
                      <Cell
                        key={i}
                        fill={PIE_COLORS[i % PIE_COLORS.length]}
                      />
                    ))}
                  </Pie>
                  <Tooltip
                    formatter={(value) => fmtZAR(Number(value))}
                  />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Spend by month */}
          <div className="bg-white rounded-xl shadow p-6">
            <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wider mb-4">
              Spend over time
            </h2>
            {summary.spendByMonth.length === 0 ? (
              <p className="text-gray-400 text-sm">
                No transactions yet.
              </p>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={summary.spendByMonth}>
                  <XAxis dataKey="month" />
                  <YAxis
                    tickFormatter={(v: number) =>
                      v >= 1000 ? `${(v / 1000).toFixed(0)}k` : String(v)
                    }
                  />
                  <Tooltip
                    formatter={(value) => fmtZAR(Number(value))}
                  />
                  <Bar dataKey="total" fill="#0f172a" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Recent activity */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="bg-white rounded-xl shadow p-6">
            <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wider mb-4">
              Recent transactions
            </h2>
            {summary.recentTransactions.length === 0 ? (
              <p className="text-gray-400 text-sm">None yet.</p>
            ) : (
              <ul className="divide-y">
                {summary.recentTransactions.map((t) => (
                  <li
                    key={t.id}
                    className="py-2 flex justify-between text-sm"
                  >
                    <div>
                      <p className="font-medium">{t.merchant}</p>
                      <p className="text-gray-600 text-xs">
                        {new Date(t.transactionDate).toLocaleDateString()}
                        {t.cardLast4 ? ` · ${t.cardLast4}` : ''}
                      </p>
                    </div>
                    <p
                      className={`font-medium ${
                        t.amount < 0 ? 'text-green-700' : ''
                      }`}
                    >
                      {fmtZAR(t.amount)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="bg-white rounded-xl shadow p-6">
            <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wider mb-4">
              Recent invoices
            </h2>
            {summary.recentInvoices.length === 0 ? (
              <p className="text-gray-400 text-sm">None yet.</p>
            ) : (
              <ul className="divide-y">
                {summary.recentInvoices.map((i) => (
                  <li
                    key={i.id}
                    className="py-2 flex justify-between items-center text-sm"
                  >
                    <Link
                      href={`/invoices/${i.id}`}
                      className="block hover:underline"
                    >
                      <p className="font-medium">{i.supplier}</p>
                      <p className="text-gray-600 text-xs">
                        {new Date(i.invoiceDate).toLocaleDateString()} ·{' '}
                        {fmtZAR(i.total)}
                      </p>
                    </Link>
                    <StatusBadge status={i.status} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

      </section>
    </main>
  );
}

// Reusable summary card. `highlight` adds a colored accent for warnings.
function SummaryCard({
  label,
  value,
  sub,
  highlight,
  footer,
}: {
  label: string;
  value: string;
  sub: string;
  highlight?: 'orange';
  // Optional element rendered under `sub` — used for split-cycle
  // breakdowns and other per-card annotations.
  footer?: React.ReactNode;
}) {
  const borderClass =
    highlight === 'orange'
      ? 'border-orange-300 bg-orange-50'
      : 'bg-white';
  return (
    <div className={`${borderClass} rounded-xl shadow p-5 border`}>
      <p className="text-xs text-gray-600 uppercase tracking-wider">
        {label}
      </p>
      <p className="text-2xl font-bold mt-1">{value}</p>
      <p className="text-xs text-gray-600 mt-1">{sub}</p>
      {footer}
    </div>
  );
}
