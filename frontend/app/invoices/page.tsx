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

      <section className="flex-1 p-4 pt-16 md:p-8">
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
        <div className="bg-white rounded-xl shadow overflow-hidden">
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
              </tr>
            </thead>
            <tbody>
              {invoices.length === 0 && !loading ? (
                <tr>
                  <td
                    colSpan={
                      6 +
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
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
