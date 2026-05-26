'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import Sidebar from '@/components/Sidebar';
import { api, ApiError } from '@/lib/api';

type EditRequestType = 'FINANCIAL' | 'METADATA';

type EditRequest = {
  id: string;
  reason: string;
  fieldsToEdit: string | null;
  // Server returns FINANCIAL by default for legacy rows.
  type: EditRequestType;
  status: string;
  approvedUntil: string | null;
  reviewedAt: string | null;
  reviewNote: string | null;
  createdAt: string;
  invoice: {
    id: string;
    supplier: string;
    total: number;
    invoiceDate: string;
  };
  requestedBy: { id: string; name: string; email: string };
  reviewedBy: { id: string; name: string; email: string } | null;
};

const STATUS_STYLES: Record<string, string> = {
  PENDING:  'bg-yellow-100 text-yellow-800',
  APPROVED: 'bg-green-100 text-green-800',
  REJECTED: 'bg-red-100 text-red-800',
  USED:     'bg-blue-100 text-blue-800',
  EXPIRED:  'bg-gray-200 text-gray-700',
};

// Two-tone chip for the type column so a glance at the queue tells you
// whether you're approving access to financial vs metadata fields.
const TYPE_STYLES: Record<EditRequestType, string> = {
  FINANCIAL: 'bg-orange-100 text-orange-800',
  METADATA:  'bg-purple-100 text-purple-800',
};

export default function EditRequestsAdminPage() {
  const [requests, setRequests] = useState<EditRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('PENDING');
  // Client-side type filter so admins can drill into a single workflow
  // (e.g. "show me only metadata requests waiting on me").
  const [typeFilter, setTypeFilter] = useState<'' | EditRequestType>('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  async function reload() {
    setLoading(true);
    setError('');
    try {
      const params = filter ? `?status=${filter}` : '';
      const data = await api<EditRequest[]>(`/edit-requests${params}`);
      setRequests(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  // Apply the type filter in-memory — server already paginated by status.
  const visibleRequests = typeFilter
    ? requests.filter((r) => r.type === typeFilter)
    : requests;

  async function handleApprove(req: EditRequest) {
    const note = prompt(
      `Approve ${req.type.toLowerCase()} edit for "${req.invoice.supplier}"?\n\nOptional note for the user (leave blank to skip):`,
      '',
    );
    // prompt returns null when the user hits Cancel. Empty string is OK
    // (they hit OK without a note) — treat that as "approve, no note".
    if (note === null) return;
    setBusyId(req.id);
    try {
      await api(`/edit-requests/${req.id}/approve`, {
        method: 'POST',
        json: { note: note || undefined },
      });
      setMessage(
        `Approved. ${req.requestedBy.name} now has 24h to edit ${req.type.toLowerCase()} fields on ${req.invoice.supplier}.`,
      );
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Approve failed');
    } finally {
      setBusyId(null);
    }
  }

  async function handleReject(req: EditRequest) {
    const note = prompt('Reason for rejection (required):', '');
    if (!note?.trim()) return;
    setBusyId(req.id);
    try {
      await api(`/edit-requests/${req.id}/reject`, {
        method: 'POST',
        json: { note },
      });
      setMessage(`Rejected request from ${req.requestedBy.name}.`);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Reject failed');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <main className="flex min-h-screen bg-gray-100">
      <Sidebar />

      <section className="flex-1 p-8">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-3xl font-bold">Edit Requests</h1>
            <p className="text-gray-600 mt-1">
              Approve or reject user requests to edit sealed invoices
            </p>
          </div>
          <div className="flex gap-2">
            <select
              value={typeFilter}
              onChange={(e) =>
                setTypeFilter(e.target.value as '' | EditRequestType)
              }
              className="border rounded-lg px-3 py-2"
            >
              <option value="">All types</option>
              <option value="FINANCIAL">Financial</option>
              <option value="METADATA">Metadata</option>
            </select>
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="border rounded-lg px-3 py-2"
            >
              <option value="">All statuses</option>
              <option value="PENDING">Pending</option>
              <option value="APPROVED">Approved</option>
              <option value="REJECTED">Rejected</option>
              <option value="USED">Used</option>
              <option value="EXPIRED">Expired</option>
            </select>
          </div>
        </div>

        {error && (
          <p className="text-sm text-red-600 bg-red-50 p-3 rounded mb-4">
            {error}
          </p>
        )}
        {message && (
          <p className="text-sm text-green-700 bg-green-50 p-3 rounded mb-4">
            {message}
          </p>
        )}

        {loading ? (
          <p className="text-gray-600">Loading...</p>
        ) : visibleRequests.length === 0 ? (
          <p className="text-gray-400 text-sm bg-white rounded-xl shadow p-8 text-center">
            No requests
            {filter ? ` with status ${filter}` : ''}
            {typeFilter ? ` of type ${typeFilter}` : ''}.
          </p>
        ) : (
          <div className="space-y-4">
            {visibleRequests.map((req) => (
              <div
                key={req.id}
                className={`bg-white rounded-xl shadow p-5 ${
                  busyId === req.id ? 'opacity-40' : ''
                }`}
              >
                <div className="flex justify-between items-start mb-3">
                  <div>
                    <Link
                      href={`/invoices/${req.invoice.id}`}
                      className="font-medium hover:underline"
                    >
                      {req.invoice.supplier}
                    </Link>
                    <p className="text-sm text-gray-600">
                      R {req.invoice.total.toFixed(2)} · invoice dated{' '}
                      {new Date(req.invoice.invoiceDate).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    <span
                      className={`px-2 py-0.5 rounded text-xs font-medium ${
                        STATUS_STYLES[req.status] ?? 'bg-gray-100'
                      }`}
                    >
                      {req.status}
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider ${
                        TYPE_STYLES[req.type] ?? 'bg-gray-100'
                      }`}
                    >
                      {req.type}
                    </span>
                  </div>
                </div>

                <p className="text-sm">
                  <span className="text-gray-600">Requested by:</span>{' '}
                  <strong>{req.requestedBy.name}</strong> ({req.requestedBy.email})
                </p>
                <p className="text-sm text-gray-600 mt-1">
                  {new Date(req.createdAt).toLocaleString()}
                </p>

                <div className="mt-3">
                  <p className="text-xs text-gray-600 uppercase tracking-wider">
                    Reason
                  </p>
                  <p className="text-sm mt-1">{req.reason}</p>
                </div>

                {req.fieldsToEdit && (
                  <div className="mt-2">
                    <p className="text-xs text-gray-600 uppercase tracking-wider">
                      Fields requested
                    </p>
                    <p className="text-sm mt-1">{req.fieldsToEdit}</p>
                  </div>
                )}

                {req.reviewedBy && (
                  <div className="mt-3 border-t pt-3">
                    <p className="text-xs text-gray-600">
                      Reviewed by {req.reviewedBy.name}{' '}
                      {req.reviewedAt &&
                        `on ${new Date(req.reviewedAt).toLocaleString()}`}
                    </p>
                    {req.reviewNote && (
                      <p className="text-sm mt-1 italic">"{req.reviewNote}"</p>
                    )}
                    {req.approvedUntil && req.status === 'APPROVED' && (
                      <p className="text-xs text-green-700 mt-1">
                        Unlock active until{' '}
                        {new Date(req.approvedUntil).toLocaleString()}
                      </p>
                    )}
                  </div>
                )}

                {req.status === 'PENDING' && (
                  <div className="mt-4 flex gap-2">
                    <button
                      onClick={() => handleApprove(req)}
                      disabled={busyId === req.id}
                      className="bg-green-600 text-white px-4 py-2 rounded-lg text-sm hover:opacity-90"
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => handleReject(req)}
                      disabled={busyId === req.id}
                      className="bg-white border border-red-300 text-red-700 px-4 py-2 rounded-lg text-sm hover:bg-red-50"
                    >
                      Reject
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
