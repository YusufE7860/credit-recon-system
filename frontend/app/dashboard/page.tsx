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
  const [error, setError] = useState('');

  // Dashboard date range picker. Same shape + presets as the Reports
  // page so the muscle memory carries over. Default = This Month
  // (1st → today). All dashboard widgets refetch on change.
  const [from, setFrom] = useState<string>(() => isoMonthStart(new Date()));
  const [to, setTo] = useState<string>(() => isoDate(new Date()));

  async function loadSummary() {
    try {
      const params = new URLSearchParams({ from, to });
      const data = await api<Summary>(
        `/dashboard/summary?${params.toString()}`,
      );
      setSummary(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // Refetch whenever the date range changes so the cards/charts stay
  // in sync. Initial mount is covered by this same effect.
  useEffect(() => {
    setLoading(true);
    loadSummary();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);

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
        </div>

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

        {/* Statement vs invoices — the actionable trio. Statement
            column will be empty until end-of-month uploads land; that's
            shown explicitly so the user knows nothing is broken. */}
        <div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <SummaryCard
              label="Statement spend"
              value={
                summary.statementCoverage === 'none'
                  ? '—'
                  : fmtZAR(summary.statementSpend)
              }
              sub={
                summary.statementCoverage === 'none'
                  ? 'No statement uploaded for this period yet'
                  : summary.statementCoverage === 'partial'
                  ? 'Partial statement coverage'
                  : 'What the bank says was spent'
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
                summary.statementCoverage === 'none'
                  ? '—'
                  : fmtZAR(Math.max(summary.outstandingReceipts, 0))
              }
              sub={
                summary.statementCoverage === 'none'
                  ? 'Needs a statement to compute'
                  : summary.outstandingReceipts > 0
                  ? 'Upload these receipts to close the gap'
                  : summary.outstandingReceipts < 0
                  ? `More invoices than statement — ${fmtZAR(Math.abs(summary.outstandingReceipts))} extra (cash receipts?)`
                  : 'All caught up — every transaction has a receipt'
              }
              highlight={
                summary.statementCoverage !== 'none' &&
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
}: {
  label: string;
  value: string;
  sub: string;
  highlight?: 'orange';
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
    </div>
  );
}
