'use client';

import { useEffect, useState } from 'react';
import Sidebar from '@/components/Sidebar';
import { api, ApiError } from '@/lib/api';

type AuditLog = {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  metadata: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
  actor: { id: string; name: string; email: string; role: string } | null;
};

// Action options for the filter dropdown — mirrors the backend enum.
const ACTIONS = [
  'USER_LOGIN_SUCCESS', 'USER_LOGIN_FAILED', 'USER_LOGOUT',
  'USER_PASSWORD_RESET_REQUESTED', 'USER_PASSWORD_RESET_COMPLETED',
  'USER_CREATED', 'USER_UPDATED', 'USER_DEACTIVATED', 'USER_REACTIVATED',
  'USER_PASSWORD_SET_BY_ADMIN',
  'INVOICE_UPLOADED', 'INVOICE_EDITED', 'INVOICE_DELETED', 'INVOICE_RESCANNED',
  'STATEMENT_UPLOADED', 'STATEMENT_DELETED',
  'CARD_CREATED', 'CARD_UPDATED', 'CARD_ASSIGNED', 'CARD_DELETED',
  'RECON_RUN', 'RECON_MATCH_MANUAL', 'RECON_UNLINK',
  'EDIT_REQUEST_CREATED', 'EDIT_REQUEST_APPROVED', 'EDIT_REQUEST_REJECTED',
];

export default function AuditLogsPage() {
  const [rows, setRows] = useState<AuditLog[]>([]);
  const [action, setAction] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function reload() {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams();
      if (action) params.set('action', action);
      if (from) params.set('from', from);
      if (to) params.set('to', to);
      const data = await api<AuditLog[]>(`/audit-logs?${params.toString()}`);
      setRows(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [action, from, to]);

  return (
    <main className="flex min-h-screen bg-gray-100">
      <Sidebar />
      <section className="flex-1 p-4 pt-16 md:p-8">
        <h1 className="text-3xl font-bold">Audit Logs</h1>
        <p className="text-gray-600 mt-1 mb-6">
          Immutable record of every important action. {loading ? '' : `${rows.length} entries shown.`}
        </p>

        <div className="bg-white rounded-xl shadow p-4 mb-4 grid grid-cols-1 md:grid-cols-4 gap-3">
          <div>
            <label className="block text-xs text-gray-600 mb-1">Action</label>
            <select
              value={action}
              onChange={(e) => setAction(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            >
              <option value="">All actions</option>
              {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">From</label>
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="block text-xs text-gray-600 mb-1">To</label>
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm" />
          </div>
          <div className="flex items-end">
            <button onClick={() => { setAction(''); setFrom(''); setTo(''); }} className="text-sm text-gray-600 hover:text-black">Clear filters</button>
          </div>
        </div>

        {error && <p className="text-sm text-red-600 bg-red-50 p-3 rounded mb-4">{error}</p>}

        <div className="bg-white rounded-xl shadow overflow-x-auto">
          <table className="w-full">
            <thead className="bg-black text-white">
              <tr>
                <th className="text-left p-3">When</th>
                <th className="text-left p-3">Action</th>
                <th className="text-left p-3">Actor</th>
                <th className="text-left p-3">Entity</th>
                <th className="text-left p-3">Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading ? (
                <tr><td colSpan={5} className="p-8 text-center text-gray-400">No entries.</td></tr>
              ) : rows.map((r) => (
                <tr key={r.id} className="border-b">
                  <td className="p-3 text-gray-700 whitespace-nowrap text-xs">{new Date(r.createdAt).toLocaleString()}</td>
                  <td className="p-3 font-medium text-sm">{r.action}</td>
                  <td className="p-3 text-sm text-gray-700">
                    {r.actor ? <>{r.actor.name}<p className="text-xs text-gray-500">{r.actor.email}</p></> : <span className="text-gray-400">—</span>}
                  </td>
                  <td className="p-3 text-xs text-gray-600">
                    {r.entityType ? <>{r.entityType}<p>{r.entityId?.slice(0, 8)}</p></> : '—'}
                  </td>
                  <td className="p-3 text-xs text-gray-600">
                    {r.metadata ? <pre className="whitespace-pre-wrap text-[10px] font-mono max-w-xs overflow-hidden">{JSON.stringify(r.metadata, null, 1)}</pre> : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
