'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import Sidebar from '@/components/Sidebar';
import { api, ApiError } from '@/lib/api';
import { useCurrentUser } from '@/lib/user-context';

// One-stop cardholder view for admins. Opens when an admin clicks a
// live-spend tracker card on the dashboard. Shows:
//   - the cardholder's basic info + role
//   - their cards with live-spend progress bars
//   - current-period summary (from /dashboard/summary?userId=X)
//   - previous-period summary (same shape, shifted window)
//   - monthly spend trend (last 12 months) — from spendByMonth
//   - recent transactions and invoices scoped to this user
//
// Everything is read-only. Actions (unlink, delete, etc.) still live
// on their dedicated pages.

type UserProfile = {
  id: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
  createdAt: string;
};

type Summary = {
  range: { from: string; to: string };
  totalTransactions: number;
  totalInvoices: number;
  totalPurchases: number;
  totalRefunds: number;
  netSpend: number;
  totalVat: number;
  statementSpend: number;
  invoiceTotal: number;
  outstandingReceipts: number;
  recon: {
    matched: number;
    unmatched: number;
    pending: number;
    matchedRate: number;
  };
  spendByCategory: Array<{ category: string; total: number; count: number }>;
  spendByMonth: Array<{ month: string; total: number; count: number }>;
  recentTransactions: Array<{
    id: string;
    merchant: string;
    amount: number;
    transactionDate: string;
  }>;
  recentInvoices: Array<{
    id: string;
    supplier: string;
    total: number;
    invoiceDate: string;
    status: string;
  }>;
};

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

type StatementOption = {
  id: string;
  statementName: string;
  periodStart: string | null;
  periodEnd: string | null;
};

function fmtZAR(n: number): string {
  return `R ${n.toLocaleString('en-ZA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// Shift a [from, to] window backwards by its own length so we can
// query the "same duration, immediately before" period.
function shiftPeriodBack(from: string, to: string): [string, string] {
  const f = new Date(from);
  const t = new Date(to);
  const days = Math.round((t.getTime() - f.getTime()) / (1000 * 60 * 60 * 24));
  const newTo = new Date(f);
  newTo.setDate(newTo.getDate() - 1);
  const newFrom = new Date(newTo);
  newFrom.setDate(newFrom.getDate() - days);
  return [newFrom.toISOString().slice(0, 10), newTo.toISOString().slice(0, 10)];
}

export default function UserProfilePage() {
  const params = useParams<{ id: string }>();
  const userId = params?.id;
  const { user: currentUser } = useCurrentUser();
  const isAdminLike =
    currentUser?.role === 'ADMIN' || currentUser?.role === 'REPORTING';

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [current, setCurrent] = useState<Summary | null>(null);
  const [previous, setPrevious] = useState<Summary | null>(null);
  const [liveSpend, setLiveSpend] = useState<LiveSpendRow[]>([]);
  const [statements, setStatements] = useState<StatementOption[]>([]);
  const [selectedStatementId, setSelectedStatementId] = useState<string>('');
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Initial load — fetch profile, statements list, live-spend once.
  // Default period = the most recent statement's cycle (matches the
  // dashboard's default so navigation feels consistent).
  useEffect(() => {
    if (!userId || !isAdminLike) return;
    let cancelled = false;
    (async () => {
      try {
        const [prof, stmts, liveAll] = await Promise.all([
          api<UserProfile>(`/users/${userId}`),
          api<StatementOption[]>('/statements'),
          api<LiveSpendRow[]>('/cards/live-spend').catch(
            () => [] as LiveSpendRow[],
          ),
        ]);
        if (cancelled) return;
        setProfile(prof);
        setStatements(stmts);
        setLiveSpend(liveAll.filter((c) => c.assignedUserId === userId));
        // Pick the latest statement with a period as the default range.
        const dated = stmts
          .filter((s) => s.periodStart && s.periodEnd)
          .sort((a, b) =>
            (b.periodEnd ?? '').localeCompare(a.periodEnd ?? ''),
          );
        if (dated.length > 0) {
          setFrom(dated[0].periodStart!.slice(0, 10));
          setTo(dated[0].periodEnd!.slice(0, 10));
          setSelectedStatementId(dated[0].id);
        } else {
          // No statements yet — fall back to current calendar month.
          const now = new Date();
          setFrom(
            new Date(now.getFullYear(), now.getMonth(), 1)
              .toISOString()
              .slice(0, 10),
          );
          setTo(now.toISOString().slice(0, 10));
        }
      } catch (err) {
        setError(err instanceof ApiError ? err.message : 'Failed to load profile');
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, isAdminLike]);

  // Refetch current + previous summaries whenever the range changes.
  useEffect(() => {
    if (!userId || !from || !to) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const [prevFrom, prevTo] = shiftPeriodBack(from, to);
        const [cur, prev] = await Promise.all([
          api<Summary>(`/dashboard/summary?userId=${userId}&from=${from}&to=${to}`),
          api<Summary>(
            `/dashboard/summary?userId=${userId}&from=${prevFrom}&to=${prevTo}`,
          ),
        ]);
        if (cancelled) return;
        setCurrent(cur);
        setPrevious(prev);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof ApiError ? err.message : 'Failed to load summaries',
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, from, to]);

  if (!isAdminLike) {
    return (
      <main className="flex min-h-screen bg-gray-100">
        <Sidebar />
        <section className="flex-1 min-w-0 p-4 md:p-8">
          <div className="bg-red-50 text-red-800 p-6 rounded-xl">
            User profiles are admin-only.
          </div>
        </section>
      </main>
    );
  }

  // Delta between current and previous period spend, as a percent.
  // Positive = spent more than last period. Coloured in the render.
  function deltaPct(now: number, prev: number): { pct: number; up: boolean } | null {
    if (prev === 0) return null;
    const pct = ((now - prev) / Math.abs(prev)) * 100;
    return { pct: Math.abs(pct), up: now > prev };
  }

  return (
    <main className="flex min-h-screen bg-gray-100">
      <Sidebar />
      <section className="flex-1 min-w-0 p-4 pt-16 md:p-8 space-y-6">
        {/* Header — link back to dashboard */}
        <div>
          <Link
            href="/dashboard"
            className="text-sm text-orange-600 hover:underline"
          >
            ← Dashboard
          </Link>
          <h1 className="text-3xl font-bold mt-1">
            {profile?.name ?? 'Loading...'}
          </h1>
          {profile && (
            <p className="text-gray-600 mt-1 text-sm">
              {profile.email} · <span className="uppercase tracking-wider">{profile.role}</span>
              {!profile.active && (
                <span className="ml-2 text-red-700 font-medium">(inactive)</span>
              )}
            </p>
          )}
        </div>

        {error && (
          <div className="bg-red-50 text-red-800 p-3 rounded text-sm">
            {error}
          </div>
        )}

        {/* Period picker — same shape as the main dashboard so the muscle
            memory carries over. Statement dropdown pre-fills the date
            range to a specific billing cycle. */}
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
            {statements.length > 0 && (
              <>
                <label className="text-sm font-medium text-gray-700 ml-2">
                  Statement:
                </label>
                <select
                  value={selectedStatementId}
                  onChange={(e) => {
                    const id = e.target.value;
                    setSelectedStatementId(id);
                    const s = statements.find((r) => r.id === id);
                    if (s?.periodStart && s?.periodEnd) {
                      setFrom(s.periodStart.slice(0, 10));
                      setTo(s.periodEnd.slice(0, 10));
                    }
                  }}
                  className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500 max-w-xs"
                >
                  <option value="">— Custom —</option>
                  {statements.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.statementName}
                    </option>
                  ))}
                </select>
              </>
            )}
          </div>
        </div>

        {/* Reports — printable views for the current period. Each opens
            a print-optimised page in a new tab; the browser's print dialog
            fires automatically so the admin can save to PDF or print. */}
        {from && to && (
          <section className="bg-white rounded-xl shadow p-4">
            <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wider mb-3">
              Printable reports
            </h2>
            <div className="flex flex-wrap gap-2">
              <Link
                href={`/admin/users/${userId}/report?type=summary&from=${from}&to=${to}`}
                target="_blank"
                className="px-3 py-1.5 text-sm rounded-lg bg-orange-600 text-white hover:bg-orange-700"
              >
                Period summary
              </Link>
              <Link
                href={`/admin/users/${userId}/report?type=transactions&from=${from}&to=${to}`}
                target="_blank"
                className="px-3 py-1.5 text-sm rounded-lg bg-white border border-gray-300 hover:bg-gray-50"
              >
                Transactions list
              </Link>
              <Link
                href={`/admin/users/${userId}/report?type=invoices&from=${from}&to=${to}`}
                target="_blank"
                className="px-3 py-1.5 text-sm rounded-lg bg-white border border-gray-300 hover:bg-gray-50"
              >
                Invoices list
              </Link>
              <Link
                href={`/admin/users/${userId}/report?type=unmatched&from=${from}&to=${to}`}
                target="_blank"
                className="px-3 py-1.5 text-sm rounded-lg bg-white border border-gray-300 hover:bg-gray-50"
              >
                Unmatched transactions
              </Link>
            </div>
            <p className="text-xs text-gray-500 mt-2">
              Reports open in a new tab and are optimised for print / save-as-PDF.
            </p>
          </section>
        )}

        {/* Assigned cards + live-spend progress. Empty state when the
            user has no cards assigned. */}
        <section className="bg-white rounded-xl shadow p-4">
          <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wider mb-3">
            Assigned cards ({liveSpend.length})
          </h2>
          {liveSpend.length === 0 ? (
            <p className="text-sm text-gray-500">
              No cards assigned to this user.
            </p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {liveSpend.map((c) => {
                const limit = c.creditLimit ?? 0;
                const used = Math.max(0, c.liveSpend);
                const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
                const over = limit > 0 && c.liveSpend > limit;
                return (
                  <div
                    key={c.cardId}
                    className={`rounded-lg border p-3 ${
                      over ? 'border-red-300 bg-red-50' : 'border-gray-200'
                    }`}
                  >
                    <div className="flex justify-between items-baseline">
                      <p className="text-sm font-medium truncate">
                        {c.cardName}
                        {c.last4 && (
                          <span className="text-gray-500"> …{c.last4}</span>
                        )}
                      </p>
                      <p className="text-xs text-gray-500">
                        {limit > 0 ? `of ${fmtZAR(limit)}` : 'no limit set'}
                      </p>
                    </div>
                    <p className="text-lg font-bold mt-1">{fmtZAR(used)}</p>
                    {limit > 0 && (
                      <div className="h-1.5 bg-gray-200 rounded-full mt-2 overflow-hidden">
                        <div
                          className={`h-full ${over ? 'bg-red-600' : 'bg-black'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    )}
                    <p className="text-xs text-gray-500 mt-1.5">
                      {c.lastCycleEnd
                        ? `Since ${new Date(c.lastCycleEnd).toLocaleDateString('en-ZA')}`
                        : 'No prior cycle'}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Current vs previous period comparison — the meat of the page.
            Each stat shows current value + delta chip vs previous. */}
        {loading || !current || !previous ? (
          <p className="text-sm text-gray-500">Loading summaries...</p>
        ) : (
          <>
            <section>
              <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wider mb-3">
                Current period vs previous
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                {/* Each card drills into the underlying data for THIS
                    user, filtered to the current period. Query params
                    match what the target page reads on mount. */}
                <StatCard
                  label="Net spend"
                  value={fmtZAR(current.netSpend)}
                  prevLabel={`prev: ${fmtZAR(previous.netSpend)}`}
                  delta={deltaPct(current.netSpend, previous.netSpend)}
                  href={`/transactions?userId=${userId}&from=${from}&to=${to}`}
                />
                <StatCard
                  label="Transactions"
                  value={String(current.totalTransactions)}
                  prevLabel={`prev: ${previous.totalTransactions}`}
                  delta={deltaPct(
                    current.totalTransactions,
                    previous.totalTransactions,
                  )}
                  href={`/transactions?userId=${userId}&from=${from}&to=${to}`}
                />
                <StatCard
                  label="Invoices uploaded"
                  value={String(current.totalInvoices)}
                  prevLabel={`prev: ${previous.totalInvoices}`}
                  delta={deltaPct(
                    current.totalInvoices,
                    previous.totalInvoices,
                  )}
                  href={`/invoices?userId=${userId}&from=${from}&to=${to}`}
                />
                <StatCard
                  label="Matched rate"
                  value={`${(current.recon.matchedRate * 100).toFixed(0)}%`}
                  prevLabel={`prev: ${(previous.recon.matchedRate * 100).toFixed(0)}%`}
                  delta={null}
                  href={`/invoices?userId=${userId}&from=${from}&to=${to}&status=MATCHED`}
                />
              </div>
            </section>

            {/* Spend by category — same data model as the main dashboard's
                pie chart, rendered as a compact list here to keep the
                page dense. */}
            {current.spendByCategory.length > 0 && (
              <section className="bg-white rounded-xl shadow p-4">
                <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wider mb-3">
                  Spend by category
                </h2>
                <ul className="space-y-1.5 text-sm">
                  {current.spendByCategory.slice(0, 8).map((c) => (
                    <li key={c.category} className="flex justify-between">
                      <span>{c.category}</span>
                      <span className="font-medium">
                        {fmtZAR(c.total)}
                        <span className="text-gray-500 ml-2 text-xs">
                          ({c.count})
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* Monthly trend — last 12 buckets from spendByMonth. Simple
                bar list so we don't need a chart lib on this page. */}
            {current.spendByMonth.length > 0 && (
              <section className="bg-white rounded-xl shadow p-4">
                <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wider mb-3">
                  Spend trend (last 12 months)
                </h2>
                <MonthlyBars data={current.spendByMonth.slice(-12)} />
              </section>
            )}

            {/* Recent transactions & invoices side-by-side. Links out
                to the full page filtered to this user. */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <section className="bg-white rounded-xl shadow p-4">
                <div className="flex justify-between items-baseline mb-3">
                  <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wider">
                    Recent transactions
                  </h2>
                  <Link
                    href={`/transactions`}
                    className="text-xs text-orange-600 hover:underline"
                  >
                    See all →
                  </Link>
                </div>
                {current.recentTransactions.length === 0 ? (
                  <p className="text-sm text-gray-500">None in this period.</p>
                ) : (
                  <ul className="divide-y divide-gray-100 text-sm">
                    {current.recentTransactions.map((t) => (
                      <li key={t.id} className="flex justify-between py-1.5">
                        <span className="truncate mr-2">{t.merchant}</span>
                        <span className="font-medium whitespace-nowrap">
                          {fmtZAR(t.amount)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="bg-white rounded-xl shadow p-4">
                <div className="flex justify-between items-baseline mb-3">
                  <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wider">
                    Recent invoices
                  </h2>
                  <Link
                    href="/invoices"
                    className="text-xs text-orange-600 hover:underline"
                  >
                    See all →
                  </Link>
                </div>
                {current.recentInvoices.length === 0 ? (
                  <p className="text-sm text-gray-500">None in this period.</p>
                ) : (
                  <ul className="divide-y divide-gray-100 text-sm">
                    {current.recentInvoices.map((i) => (
                      <li key={i.id} className="flex justify-between py-1.5">
                        <Link
                          href={`/invoices/${i.id}`}
                          className="truncate mr-2 hover:underline"
                        >
                          {i.supplier}
                        </Link>
                        <span className="font-medium whitespace-nowrap">
                          {fmtZAR(i.total)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </>
        )}
      </section>
    </main>
  );
}

// A single stat card. `delta` renders a small ▲/▼ chip in red/green.
// When `href` is supplied, the whole card becomes a clickable link that
// drills into the underlying data for this user + period.
function StatCard({
  label,
  value,
  prevLabel,
  delta,
  href,
}: {
  label: string;
  value: string;
  prevLabel: string;
  delta: { pct: number; up: boolean } | null;
  href?: string;
}) {
  const body = (
    <>
      <p className="text-xs text-gray-600 uppercase tracking-wider">{label}</p>
      <p className="text-xl font-bold mt-1">{value}</p>
      <div className="text-xs text-gray-500 mt-1 flex items-center gap-2">
        <span>{prevLabel}</span>
        {delta && (
          <span
            className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${
              delta.up
                ? 'bg-red-100 text-red-700'
                : 'bg-green-100 text-green-700'
            }`}
          >
            {delta.up ? '▲' : '▼'} {delta.pct.toFixed(0)}%
          </span>
        )}
      </div>
      {href && (
        <p className="text-[10px] uppercase tracking-wider text-orange-600 mt-2">
          View →
        </p>
      )}
    </>
  );
  const baseClass = 'bg-white rounded-xl shadow p-4 block';
  return href ? (
    <Link
      href={href}
      className={`${baseClass} hover:shadow-md hover:ring-1 hover:ring-orange-300 transition cursor-pointer`}
    >
      {body}
    </Link>
  ) : (
    <div className={baseClass}>{body}</div>
  );
}

// Simple horizontal bar list for the monthly trend. No chart lib needed.
function MonthlyBars({
  data,
}: {
  data: Array<{ month: string; total: number; count: number }>;
}) {
  const max = Math.max(...data.map((d) => d.total), 1);
  return (
    <ul className="space-y-1 text-sm">
      {data.map((d) => {
        const pct = (d.total / max) * 100;
        return (
          <li key={d.month} className="flex items-center gap-2">
            <span className="text-xs text-gray-500 w-20 flex-shrink-0">
              {new Date(d.month + '-01').toLocaleString('en-ZA', {
                month: 'short',
                year: '2-digit',
              })}
            </span>
            <div className="flex-1 h-4 bg-gray-100 rounded overflow-hidden">
              <div
                className="h-full bg-orange-500"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-xs font-medium w-24 text-right">
              R {d.total.toLocaleString('en-ZA', { maximumFractionDigits: 0 })}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
