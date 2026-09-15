'use client';

import { Suspense, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import { useCurrentUser } from '@/lib/user-context';

// Printable, PDF-friendly report page. Opens in a new tab from the
// user profile page. Layout is deliberately plain: no sidebar, wide
// content area, print-safe colours. On first render (once data has
// loaded) we auto-fire the browser's print dialog so the admin can
// send straight to paper or "Save as PDF".
//
// Report types (via ?type=):
//   summary       — stat block + category + monthly trend
//   transactions  — full transaction table for the period
//   invoices      — full invoice table for the period
//   unmatched     — subset: only transactions without a matched invoice

type ReportType = 'summary' | 'transactions' | 'invoices' | 'unmatched';

type UserProfile = {
  id: string;
  name: string;
  email: string;
  role: string;
};

type Summary = {
  range: { from: string; to: string };
  totalTransactions: number;
  totalInvoices: number;
  totalPurchases: number;
  totalRefunds: number;
  netSpend: number;
  totalVat: number;
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
};

type TxnRow = {
  id: string;
  transactionDate: string;
  merchant: string;
  location: string | null;
  amount: number;
  category: string | null;
  cardLast4: string | null;
  matched: boolean;
  invoices: Array<{ id: string; supplier: string; total: number }>;
};

type InvoiceRow = {
  id: string;
  invoiceDate: string | null;
  supplier: string;
  total: number;
  currency: string;
  totalZAR: number | null;
  status: string;
  kind: string;
  category: string | null;
};

function fmtZAR(n: number): string {
  return `R ${n.toLocaleString('en-ZA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtDate(s: string | null): string {
  if (!s) return '—';
  return new Date(s).toLocaleDateString('en-ZA');
}

// Suspense wrapper — useSearchParams() requires this at prerender time.
export default function UserReportPageWrapper() {
  return (
    <Suspense fallback={null}>
      <UserReportPage />
    </Suspense>
  );
}

function UserReportPage() {
  const params = useParams<{ id: string }>();
  const userId = params?.id;
  const search = useSearchParams();
  const type = (search?.get('type') ?? 'summary') as ReportType;
  const from = search?.get('from') ?? '';
  const to = search?.get('to') ?? '';
  const { user: currentUser } = useCurrentUser();
  const isAdminLike =
    currentUser?.role === 'ADMIN' || currentUser?.role === 'REPORTING';

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [txns, setTxns] = useState<TxnRow[]>([]);
  const [invs, setInvs] = useState<InvoiceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!userId || !isAdminLike || !from || !to) return;
    let cancelled = false;
    (async () => {
      try {
        // Always fetch profile + summary; only fetch txns/invs if the
        // report actually renders them.
        const needsTxns = type === 'transactions' || type === 'unmatched';
        const needsInvs = type === 'invoices';
        const [prof, sum, tx, iv] = await Promise.all([
          api<UserProfile>(`/users/${userId}`),
          api<Summary>(
            `/dashboard/summary?userId=${userId}&from=${from}&to=${to}`,
          ),
          needsTxns
            ? api<TxnRow[]>(
                `/transactions?userId=${userId}&from=${from}&to=${to}`,
              )
            : Promise.resolve([] as TxnRow[]),
          needsInvs
            ? api<InvoiceRow[]>(
                `/invoices?userId=${userId}&from=${from}&to=${to}`,
              )
            : Promise.resolve([] as InvoiceRow[]),
        ]);
        if (cancelled) return;
        setProfile(prof);
        setSummary(sum);
        setTxns(tx);
        setInvs(iv);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof ApiError ? err.message : 'Failed to load report',
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, type, from, to, isAdminLike]);

  // Once data is loaded, set document.title (browsers use it as the
  // suggested save-as filename), then pop the print dialog. Title is
  // restored on unmount so the app-wide title returns.
  useEffect(() => {
    if (loading || error || !profile) return;
    const reportName =
      type === 'summary'
        ? 'Summary'
        : type === 'transactions'
          ? 'Transactions'
          : type === 'invoices'
            ? 'Invoices'
            : 'Unmatched';
    // Filename shape: "Husain Essack - Summary - 2026-05-09 to 2026-08-26"
    // Slug: strip anything the OS may object to (slashes especially).
    const slug = (s: string) =>
      s.replace(/[\\/:*?"<>|]/g, '').trim();
    const filename = `${slug(profile.name)} - ${reportName} - ${from} to ${to}`;
    const prev = document.title;
    document.title = filename;
    const t = setTimeout(() => window.print(), 400);
    return () => {
      clearTimeout(t);
      document.title = prev;
    };
  }, [loading, error, profile, type, from, to]);

  if (!isAdminLike) {
    return (
      <main className="p-8">
        <div className="bg-red-50 text-red-800 p-6 rounded-xl">
          Reports are admin-only.
        </div>
      </main>
    );
  }

  const title =
    type === 'summary'
      ? 'Period summary'
      : type === 'transactions'
        ? 'Transactions'
        : type === 'invoices'
          ? 'Invoices'
          : 'Unmatched transactions';

  const filteredTxns =
    type === 'unmatched' ? txns.filter((t) => !t.matched) : txns;

  return (
    <main className="min-h-screen bg-white text-gray-900 p-6 print:p-0">
      {/* Print styles + on-screen toolbar (hidden when printing). */}
      <style jsx global>{`
        @media print {
          .no-print {
            display: none !important;
          }
          @page {
            size: A4;
            margin: 12mm;
          }
          body {
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          table {
            page-break-inside: auto;
          }
          tr {
            page-break-inside: avoid;
            page-break-after: auto;
          }
          thead {
            display: table-header-group;
          }
        }
      `}</style>

      <div className="no-print flex justify-end gap-2 mb-4">
        <button
          onClick={() => window.print()}
          className="px-3 py-1.5 text-sm rounded-lg bg-orange-600 text-white hover:bg-orange-700"
        >
          Print / Save as PDF
        </button>
        <button
          onClick={() => window.close()}
          className="px-3 py-1.5 text-sm rounded-lg bg-white border border-gray-300 hover:bg-gray-50"
        >
          Close
        </button>
      </div>

      {/* Report header — appears on every printed page (repeated via
          the thead trick would need a real table; here we accept it
          shows only at the top). */}
      <header className="border-b border-gray-800 pb-3 mb-4">
        <div className="flex justify-between items-baseline">
          <div>
            <p className="text-xs uppercase tracking-widest text-gray-500">
              FFG Recon · {title}
            </p>
            <h1 className="text-2xl font-bold mt-0.5">
              {profile?.name ?? 'Loading...'}
            </h1>
            {profile && (
              <p className="text-sm text-gray-700">
                {profile.email} ·{' '}
                <span className="uppercase">{profile.role}</span>
              </p>
            )}
          </div>
          <div className="text-right text-sm">
            <p className="font-semibold">
              {fmtDate(from)} — {fmtDate(to)}
            </p>
            <p className="text-xs text-gray-500 mt-0.5">
              Generated {new Date().toLocaleString('en-ZA')}
            </p>
          </div>
        </div>
      </header>

      {loading && <p className="text-gray-500">Loading report…</p>}
      {error && (
        <div className="bg-red-50 text-red-800 p-3 rounded text-sm">
          {error}
        </div>
      )}

      {!loading && summary && type === 'summary' && (
        <>
          <section className="mb-6">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-600 mb-2">
              Totals
            </h2>
            <div className="grid grid-cols-4 gap-3">
              <Stat label="Net spend" value={fmtZAR(summary.netSpend)} />
              <Stat
                label="Purchases"
                value={fmtZAR(summary.totalPurchases)}
              />
              <Stat label="Refunds" value={fmtZAR(summary.totalRefunds)} />
              <Stat label="VAT" value={fmtZAR(summary.totalVat)} />
              <Stat
                label="Transactions"
                value={String(summary.totalTransactions)}
              />
              <Stat
                label="Invoices"
                value={String(summary.totalInvoices)}
              />
              <Stat
                label="Matched rate"
                value={`${(summary.recon.matchedRate * 100).toFixed(0)}%`}
              />
              <Stat
                label="Unmatched"
                value={String(summary.recon.unmatched)}
              />
            </div>
          </section>

          {summary.spendByCategory.length > 0 && (
            <section className="mb-6">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-600 mb-2">
                Spend by category
              </h2>
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-gray-300 text-left">
                    <th className="py-1.5 pr-3">Category</th>
                    <th className="py-1.5 pr-3 text-right">Count</th>
                    <th className="py-1.5 text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.spendByCategory.map((c) => (
                    <tr key={c.category} className="border-b border-gray-100">
                      <td className="py-1.5 pr-3">{c.category}</td>
                      <td className="py-1.5 pr-3 text-right">{c.count}</td>
                      <td className="py-1.5 text-right font-medium">
                        {fmtZAR(c.total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {summary.spendByMonth.length > 0 && (
            <section className="mb-6">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-600 mb-2">
                Monthly trend
              </h2>
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-gray-300 text-left">
                    <th className="py-1.5 pr-3">Month</th>
                    <th className="py-1.5 pr-3 text-right">Transactions</th>
                    <th className="py-1.5 text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.spendByMonth.map((m) => (
                    <tr key={m.month} className="border-b border-gray-100">
                      <td className="py-1.5 pr-3">{m.month}</td>
                      <td className="py-1.5 pr-3 text-right">{m.count}</td>
                      <td className="py-1.5 text-right font-medium">
                        {fmtZAR(m.total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}

      {!loading && (type === 'transactions' || type === 'unmatched') && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-600 mb-2">
            {type === 'unmatched'
              ? `Unmatched transactions (${filteredTxns.length})`
              : `Transactions (${filteredTxns.length})`}
          </h2>
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-gray-800 text-left bg-gray-50">
                <th className="py-1.5 pr-2">Date</th>
                <th className="py-1.5 pr-2">Merchant</th>
                <th className="py-1.5 pr-2">Category</th>
                <th className="py-1.5 pr-2">Card</th>
                <th className="py-1.5 pr-2">Matched</th>
                <th className="py-1.5 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {filteredTxns.map((t) => (
                <tr key={t.id} className="border-b border-gray-100">
                  <td className="py-1 pr-2 whitespace-nowrap">
                    {fmtDate(t.transactionDate)}
                  </td>
                  <td className="py-1 pr-2">
                    {t.merchant}
                    {t.location && (
                      <span className="text-gray-500"> · {t.location}</span>
                    )}
                  </td>
                  <td className="py-1 pr-2">{t.category ?? '—'}</td>
                  <td className="py-1 pr-2">
                    {t.cardLast4 ? `…${t.cardLast4}` : '—'}
                  </td>
                  <td className="py-1 pr-2">{t.matched ? 'Yes' : 'No'}</td>
                  <td className="py-1 text-right font-medium whitespace-nowrap">
                    {fmtZAR(t.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-gray-800 font-semibold">
                <td colSpan={5} className="py-2 pr-2 text-right">
                  Total
                </td>
                <td className="py-2 text-right">
                  {fmtZAR(
                    filteredTxns.reduce((s, t) => s + (t.amount || 0), 0),
                  )}
                </td>
              </tr>
            </tfoot>
          </table>
        </section>
      )}

      {!loading && type === 'invoices' && (
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-600 mb-2">
            Invoices ({invs.length})
          </h2>
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-gray-800 text-left bg-gray-50">
                <th className="py-1.5 pr-2">Date</th>
                <th className="py-1.5 pr-2">Supplier</th>
                <th className="py-1.5 pr-2">Category</th>
                <th className="py-1.5 pr-2">Kind</th>
                <th className="py-1.5 pr-2">Status</th>
                <th className="py-1.5 text-right">Total</th>
                <th className="py-1.5 text-right">ZAR</th>
              </tr>
            </thead>
            <tbody>
              {invs.map((i) => (
                <tr key={i.id} className="border-b border-gray-100">
                  <td className="py-1 pr-2 whitespace-nowrap">
                    {fmtDate(i.invoiceDate)}
                  </td>
                  <td className="py-1 pr-2">{i.supplier}</td>
                  <td className="py-1 pr-2">{i.category ?? '—'}</td>
                  <td className="py-1 pr-2">{i.kind}</td>
                  <td className="py-1 pr-2">{i.status}</td>
                  <td className="py-1 text-right whitespace-nowrap">
                    {i.currency} {i.total.toFixed(2)}
                  </td>
                  <td className="py-1 text-right font-medium whitespace-nowrap">
                    {i.totalZAR != null ? fmtZAR(i.totalZAR) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-gray-800 font-semibold">
                <td colSpan={6} className="py-2 pr-2 text-right">
                  ZAR total
                </td>
                <td className="py-2 text-right">
                  {fmtZAR(
                    invs.reduce((s, i) => s + (i.totalZAR ?? 0), 0),
                  )}
                </td>
              </tr>
            </tfoot>
          </table>
        </section>
      )}

      <footer className="mt-8 pt-3 border-t border-gray-300 text-xs text-gray-500">
        FFG Fashion Fusion Traders · Confidential · Generated by Recon
      </footer>
    </main>
  );
}

// A compact stat cell for the summary block. Print-safe (no shadow).
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-gray-300 rounded p-2">
      <p className="text-[10px] uppercase tracking-wider text-gray-600">
        {label}
      </p>
      <p className="text-sm font-bold mt-0.5">{value}</p>
    </div>
  );
}
