'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Sidebar from '@/components/Sidebar';
import { StatusBadge } from '@/components/StatusBadge';
import { api } from '@/lib/api';
import {
  useCurrentUser,
  hidesAmounts,
  canSeeAllInvoices,
} from '@/lib/user-context';

type Invoice = {
  id: string;
  supplier: string;
  invoiceNumber: string | null;
  invoiceDate: string;
  total: number;
  vat: number;
  currency: string;
  totalZAR: number | null;
  category: string | null;
  status: string;
  requiresReview: boolean;
  ocrConfidence: number;
  matchedAt: string | null;
  createdAt: string;
  // Admin list view surfaces these so we can show who uploaded vs who
  // owns the invoice. Backend already includes them in the list payload.
  uploader: { id: string; name: string; email: string } | null;
  user: { id: string; name: string; email: string } | null;
};

type UserOption = { id: string; name: string; email: string };

type Filters = {
  status: string;
  supplier: string;
  requiresReview: '' | 'true' | 'false';
  // Empty = "all uploaders". Privileged role only.
  uploaderId: string;
};

type UnmatchedCandidate = {
  id: string;
  transactionDate: string;
  merchant: string;
  amount: number;
  cardLast4: string | null;
  category: string | null;
  description: string | null;
};

export default function InvoicesPage() {
  const { user } = useCurrentUser();
  // UPLOADERs see invoices they uploaded but no monetary figures —
  // their job ends at "did the upload succeed?". Drop the Total
  // column entirely rather than masking the numbers.
  const hideMoney = hidesAmounts(user?.role);
  // Admin/REPORTING get the extra Uploaded by column + filter; plain
  // USERs only ever see their own data so the column adds no signal.
  const showUploaderColumn = canSeeAllInvoices(user?.role);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Manual-match modal state. Opened from the "Match" button on
  // PENDING/UNMATCHED rows. Mirrors the detail-page modal so the user
  // can match without leaving the invoices list.
  const [matchInvoice, setMatchInvoice] = useState<Invoice | null>(null);
  const [matchCandidates, setMatchCandidates] = useState<UnmatchedCandidate[]>([]);
  const [matchLoading, setMatchLoading] = useState(false);
  const [matchSearch, setMatchSearch] = useState('');
  const [matchBusyId, setMatchBusyId] = useState<string | null>(null);

  async function openMatchModal(inv: Invoice) {
    setMatchInvoice(inv);
    setMatchSearch('');
    setMatchCandidates([]);
    setMatchLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ invoiceId: inv.id });
      const data = await api<UnmatchedCandidate[]>(
        `/reconciliation/unmatched-transactions?${params}`,
      );
      setMatchCandidates(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setMatchLoading(false);
    }
  }

  async function confirmManualMatch(transactionId: string) {
    if (!matchInvoice) return;
    setMatchBusyId(transactionId);
    try {
      await api('/reconciliation/match', {
        method: 'POST',
        json: { invoiceId: matchInvoice.id, transactionId },
      });
      setMatchInvoice(null);
      await fetchInvoices();
    } catch (err) {
      setError((err as Error).message);
      // Reload candidates — txn might have been taken between open + click
      const params = new URLSearchParams({ invoiceId: matchInvoice.id });
      const data = await api<UnmatchedCandidate[]>(
        `/reconciliation/unmatched-transactions?${params}`,
      );
      setMatchCandidates(data);
    } finally {
      setMatchBusyId(null);
    }
  }
  const [filters, setFilters] = useState<Filters>({
    status: '',
    supplier: '',
    requiresReview: '',
    uploaderId: '',
  });

  // List of every user the admin might want to filter by. Only loaded
  // for privileged roles since others can't use the filter anyway.
  const [users, setUsers] = useState<UserOption[]>([]);
  useEffect(() => {
    if (!showUploaderColumn) return;
    api<UserOption[]>('/users')
      .then(setUsers)
      .catch(() => setUsers([]));
  }, [showUploaderColumn]);

  async function fetchInvoices() {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (filters.status) params.set('status', filters.status);
      if (filters.supplier) params.set('supplier', filters.supplier);
      if (filters.requiresReview)
        params.set('requiresReview', filters.requiresReview);
      if (filters.uploaderId)
        params.set('uploaderId', filters.uploaderId);

      const data = await api<Invoice[]>(`/invoices?${params.toString()}`);
      setInvoices(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  // Re-fetch whenever filters change.
  useEffect(() => {
    fetchInvoices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    filters.status,
    filters.supplier,
    filters.requiresReview,
    filters.uploaderId,
  ]);

  return (
    <main className="flex min-h-screen bg-gray-100">
      <Sidebar />

      <section className="flex-1 min-w-0 p-4 pt-16 md:p-8">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-3xl font-bold">Invoices</h1>
            <p className="text-gray-600 mt-1">
              {loading ? 'Loading...' : `${invoices.length} invoices`}
            </p>
          </div>
          <Link
            href="/upload"
            className="bg-black text-white px-4 py-2 rounded-lg font-medium hover:opacity-90"
          >
            + Upload Invoice
          </Link>
        </div>

        {/* Filters — grid widens to 4 columns when the uploader filter
            is visible (admin/REPORTING) so everything stays one row. */}
        <div
          className={`bg-white rounded-xl shadow p-4 mb-6 grid grid-cols-1 ${
            showUploaderColumn ? 'md:grid-cols-4' : 'md:grid-cols-3'
          } gap-3`}
        >
          <select
            value={filters.status}
            onChange={(e) =>
              setFilters({ ...filters, status: e.target.value })
            }
            className="border rounded-lg px-3 py-2"
          >
            <option value="">All statuses</option>
            <option value="PENDING">Pending</option>
            <option value="MATCHED">Matched</option>
            <option value="UNMATCHED">Unmatched</option>
            <option value="DISPUTED">Disputed</option>
            <option value="REJECTED">Rejected</option>
          </select>

          <input
            type="text"
            placeholder="Search supplier..."
            value={filters.supplier}
            onChange={(e) =>
              setFilters({ ...filters, supplier: e.target.value })
            }
            className="border rounded-lg px-3 py-2"
          />

          <select
            value={filters.requiresReview}
            onChange={(e) =>
              setFilters({
                ...filters,
                requiresReview: e.target.value as Filters['requiresReview'],
              })
            }
            className="border rounded-lg px-3 py-2"
          >
            <option value="">Review state: any</option>
            <option value="true">Needs review</option>
            <option value="false">Reviewed</option>
          </select>

          {showUploaderColumn && (
            <select
              value={filters.uploaderId}
              onChange={(e) =>
                setFilters({ ...filters, uploaderId: e.target.value })
              }
              className="border rounded-lg px-3 py-2"
              title="Show invoices where this user is the cardholder OR the uploader"
            >
              <option value="">All users</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          )}
        </div>

        {error && (
          <p className="text-sm text-red-600 bg-red-50 p-3 rounded mb-4">
            {error}
          </p>
        )}

        {/* Table */}
        <div className="bg-white rounded-xl shadow overflow-x-auto">
          <table className="w-full">
            <thead className="bg-black text-white">
              <tr>
                <th className="text-left p-4">Supplier</th>
                <th className="text-left p-4">Invoice #</th>
                <th className="text-left p-4">Date</th>
                {!hideMoney && (
                  <th className="text-right p-4">Total</th>
                )}
                <th className="text-left p-4">Category</th>
                {showUploaderColumn && (
                  <th className="text-left p-4">Uploaded by</th>
                )}
                <th className="text-left p-4">Status</th>
                <th className="text-left p-4">Review?</th>
                <th className="text-left p-4">Match</th>
              </tr>
            </thead>
            <tbody>
              {invoices.length === 0 && !loading ? (
                <tr>
                  <td
                    colSpan={
                      7 +
                      (hideMoney ? 0 : 1) +
                      (showUploaderColumn ? 1 : 0)
                    }
                    className="p-8 text-center text-gray-400"
                  >
                    No invoices match the filter.
                  </td>
                </tr>
              ) : (
                invoices.map((inv) => (
                  <tr
                    key={inv.id}
                    className="border-b hover:bg-gray-50 cursor-pointer"
                    onClick={() =>
                      (window.location.href = `/invoices/${inv.id}`)
                    }
                  >
                    <td className="p-4 font-medium">{inv.supplier}</td>
                    <td className="p-4 text-gray-600">
                      {inv.invoiceNumber ?? '—'}
                    </td>
                    <td className="p-4 text-gray-600">
                      {new Date(inv.invoiceDate).toLocaleDateString()}
                    </td>
                    {!hideMoney && (
                      <td className="p-4 text-right font-medium">
                        {/* Show ZAR-converted value as the primary number
                            since that's what reconciliation matches against.
                            For non-ZAR invoices, also surface the original
                            amount underneath so the user knows the source. */}
                        R {(inv.totalZAR ?? inv.total).toFixed(2)}
                        {inv.currency !== 'ZAR' && (
                          <p className="text-xs text-gray-500 font-normal mt-0.5">
                            {inv.currency} {inv.total.toFixed(2)}
                          </p>
                        )}
                      </td>
                    )}
                    <td className="p-4 text-gray-600">
                      {inv.category ?? '—'}
                    </td>
                    {showUploaderColumn && (
                      <td className="p-4 text-gray-600 text-sm">
                        {/* Show uploader name. When uploader differs from
                            the owner (assistant uploaded for cardholder),
                            show "Jane for John" so the admin can see the
                            chain at a glance. */}
                        {inv.uploader ? (
                          inv.user && inv.uploader.id !== inv.user.id ? (
                            <span>
                              {inv.uploader.name}{' '}
                              <span className="text-gray-400">for</span>{' '}
                              {inv.user.name}
                            </span>
                          ) : (
                            inv.uploader.name
                          )
                        ) : inv.user ? (
                          <span className="text-gray-500">
                            {inv.user.name}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                    )}
                    <td className="p-4">
                      <StatusBadge status={inv.status} />
                    </td>
                    <td className="p-4">
                      {inv.requiresReview ? (
                        <span className="text-orange-600 text-sm font-medium">
                          Yes ({(inv.ocrConfidence * 100).toFixed(0)}%)
                        </span>
                      ) : (
                        <span className="text-gray-400 text-sm">No</span>
                      )}
                    </td>
                    {/* Manual-match button: only PENDING/UNMATCHED rows
                        get one. Matched/disputed/rejected get nothing —
                        the user requested no affordance there. */}
                    <td
                      className="p-4"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {inv.status === 'PENDING' || inv.status === 'UNMATCHED' ? (
                        <button
                          onClick={() => openMatchModal(inv)}
                          className="text-xs bg-orange-500 text-white px-2.5 py-1.5 rounded hover:bg-orange-600"
                        >
                          Match
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Manual-match modal — opened by the Match button in the row.
            Mirrors the picker on the invoice detail page so users get
            the same UX from either entry point. */}
        {matchInvoice && (
          <div
            className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-2 sm:p-4"
            onClick={() => matchBusyId === null && setMatchInvoice(null)}
          >
            <div
              className="bg-white rounded-xl w-full max-w-2xl shadow-2xl flex flex-col max-h-[90vh]"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="p-5 border-b border-gray-200 flex-shrink-0">
                <h3 className="text-lg font-semibold">
                  Match to a transaction
                </h3>
                <p className="text-sm text-gray-600 mt-1">
                  Pick the bank transaction that pays for{' '}
                  <strong>{matchInvoice.supplier}</strong>
                  {matchInvoice.totalZAR != null && (
                    <>
                      {' '}— invoice is{' '}
                      <strong>R {matchInvoice.totalZAR.toFixed(2)}</strong> on{' '}
                      {new Date(matchInvoice.invoiceDate).toLocaleDateString()}
                    </>
                  )}
                  .
                </p>
                <input
                  type="text"
                  value={matchSearch}
                  onChange={(e) => setMatchSearch(e.target.value)}
                  placeholder="Filter by merchant or amount..."
                  className="mt-3 w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
              </div>

              <div className="flex-1 overflow-y-auto">
                {matchLoading ? (
                  <p className="p-6 text-sm text-gray-500">Loading...</p>
                ) : matchCandidates.length === 0 ? (
                  <p className="p-6 text-sm text-gray-400 text-center">
                    No unmatched transactions visible. Upload a bank
                    statement covering this period first.
                  </p>
                ) : (
                  <ul className="divide-y divide-gray-100">
                    {matchCandidates
                      .filter((t) => {
                        if (!matchSearch.trim()) return true;
                        const needle = matchSearch.trim().toLowerCase();
                        return (
                          t.merchant.toLowerCase().includes(needle) ||
                          t.amount.toFixed(2).includes(needle) ||
                          (t.description ?? '').toLowerCase().includes(needle)
                        );
                      })
                      .map((t) => {
                        const isBusy = matchBusyId === t.id;
                        const invoiceZAR = matchInvoice.totalZAR ?? null;
                        const amtClose =
                          invoiceZAR != null &&
                          Math.abs(t.amount - invoiceZAR) /
                            Math.max(t.amount, invoiceZAR) <
                            0.05;
                        const dayMs = 24 * 60 * 60 * 1000;
                        const dateClose =
                          Math.abs(
                            new Date(t.transactionDate).getTime() -
                              new Date(matchInvoice.invoiceDate).getTime(),
                          ) <=
                          7 * dayMs;
                        const likely = amtClose && dateClose;
                        return (
                          <li key={t.id}>
                            <button
                              onClick={() => confirmManualMatch(t.id)}
                              disabled={isBusy || matchBusyId !== null}
                              className={`w-full text-left p-4 flex items-start gap-3 hover:bg-gray-50 disabled:opacity-40 ${likely ? 'bg-orange-50/40' : ''}`}
                            >
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2">
                                  <p className="font-medium truncate">
                                    {t.merchant}
                                  </p>
                                  {likely && (
                                    <span className="text-[10px] uppercase tracking-wider bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded">
                                      likely
                                    </span>
                                  )}
                                </div>
                                <p className="text-xs text-gray-500 mt-0.5">
                                  {new Date(t.transactionDate).toLocaleDateString()}
                                  {t.cardLast4 && <> · card …{t.cardLast4}</>}
                                  {t.category && <> · {t.category}</>}
                                </p>
                              </div>
                              <div className="text-right flex-shrink-0">
                                <p className="font-semibold">
                                  R {t.amount.toFixed(2)}
                                </p>
                                {isBusy && (
                                  <p className="text-xs text-orange-600 mt-1">
                                    Matching...
                                  </p>
                                )}
                              </div>
                            </button>
                          </li>
                        );
                      })}
                  </ul>
                )}
              </div>

              <div className="p-4 border-t border-gray-200 flex justify-between items-center flex-shrink-0">
                <p className="text-xs text-gray-500">
                  {matchCandidates.length} unmatched
                  {matchSearch.trim() && ' (filtered)'}
                </p>
                <button
                  onClick={() => setMatchInvoice(null)}
                  disabled={matchBusyId !== null}
                  className="px-4 py-2 text-sm rounded-lg text-gray-700 hover:bg-gray-100"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
