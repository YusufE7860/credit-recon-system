'use client';

import { useEffect, useState } from 'react';
import Sidebar from '@/components/Sidebar';
import { api, ApiError } from '@/lib/api';
import { useCurrentUser, isPrivileged } from '@/lib/user-context';

type Cardholder = {
  name: string | null;
  email: string | null;
  last4: string | null;
  assigned: boolean;
};

type Transaction = {
  id: string;
  amount: number;
  merchant: string;
  category: string | null;
  description: string | null;
  transactionDate: string;
  status: string;
  matched: boolean;
  flagged: boolean;
  cardLast4: string | null;
  // Resolved owner of the card this charge appeared on — comes from
  // Card.assignedUser if assigned, else Card.cardholderName (the
  // PDF-parsed placeholder for unassigned cards).
  cardholder: Cardholder;
};

type UserOption = {
  id: string;
  name: string;
  email: string;
};

export default function TransactionsPage() {
  const { user: currentUser } = useCurrentUser();
  const privileged = isPrivileged(currentUser?.role);
  const isAdmin = currentUser?.role === 'ADMIN';

  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [filterUserId, setFilterUserId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Edit modal state — only used by admin.
  const [editing, setEditing] = useState<Transaction | null>(null);
  const [editDraft, setEditDraft] = useState<{
    merchant: string;
    amount: string;
    category: string;
    description: string;
    transactionDate: string;
    cardLast4: string;
  } | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  function openEdit(t: Transaction) {
    setEditing(t);
    setEditDraft({
      merchant: t.merchant ?? '',
      amount: String(t.amount),
      category: t.category ?? '',
      description: t.description ?? '',
      transactionDate: t.transactionDate.slice(0, 10), // YYYY-MM-DD
      cardLast4: t.cardLast4 ?? '',
    });
  }

  function closeEdit() {
    setEditing(null);
    setEditDraft(null);
  }

  async function saveEdit() {
    if (!editing || !editDraft) return;
    setSavingEdit(true);
    setError('');
    try {
      await api(`/transactions/${editing.id}`, {
        method: 'PATCH',
        json: {
          merchant: editDraft.merchant,
          amount: parseFloat(editDraft.amount),
          category: editDraft.category || null,
          description: editDraft.description || null,
          transactionDate: editDraft.transactionDate,
          cardLast4: editDraft.cardLast4 || null,
        },
      });
      closeEdit();
      await fetchTransactions();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingEdit(false);
    }
  }

  // Build the URL with optional ?userId=... when the admin filters.
  async function fetchTransactions() {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (filterUserId) params.set('userId', filterUserId);
      const qs = params.toString();
      const data = await api<Transaction[]>(
        `/transactions${qs ? '?' + qs : ''}`,
      );
      setTransactions(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  // Load the users list once if we're privileged — used by the dropdown.
  async function fetchUsersForFilter() {
    try {
      const data = await api<UserOption[]>('/users');
      setUsers(data);
    } catch {
      // If /users fails (e.g. backend hiccup) the dropdown just stays empty.
      // No need to surface an error here — main data loading shows its own.
    }
  }

  useEffect(() => {
    fetchTransactions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterUserId]);

  useEffect(() => {
    if (privileged) fetchUsersForFilter();
  }, [privileged]);

  return (
    <main className="flex min-h-screen bg-gray-100">
      <Sidebar />

      <section className="flex-1 p-8">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-3xl font-bold">Transactions</h1>
            <p className="text-gray-600 mt-1">
              {loading
                ? 'Loading...'
                : `${transactions.length} transaction${transactions.length === 1 ? '' : 's'}`}
              {filterUserId &&
                users.length > 0 &&
                ` · filtered to ${users.find((u) => u.id === filterUserId)?.name ?? 'user'}`}
            </p>
          </div>
        </div>

        {/* Admin-only filter bar */}
        {privileged && (
          <div className="bg-white rounded-xl shadow p-4 mb-6 flex items-center gap-3">
            <label className="text-sm font-medium text-gray-700 whitespace-nowrap">
              Filter by user:
            </label>
            <select
              value={filterUserId}
              onChange={(e) => setFilterUserId(e.target.value)}
              className="flex-1 border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-500"
            >
              <option value="">All users</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.email})
                </option>
              ))}
            </select>
            {filterUserId && (
              <button
                onClick={() => setFilterUserId('')}
                className="text-sm text-gray-600 hover:text-black"
              >
                Clear
              </button>
            )}
          </div>
        )}

        {error && (
          <p className="text-sm text-red-600 bg-red-50 p-3 rounded mb-4">
            {error}
          </p>
        )}

        <div className="bg-white rounded-xl shadow overflow-hidden">
          <table className="w-full">
            <thead className="bg-black text-white">
              <tr>
                <th className="text-left p-4">Merchant</th>
                <th className="text-left p-4">Amount</th>
                <th className="text-left p-4">Category</th>
                <th className="text-left p-4">Status</th>
                {privileged && <th className="text-left p-4">Cardholder</th>}
                <th className="text-left p-4">Date</th>
                {isAdmin && <th className="text-right p-4">Actions</th>}
              </tr>
            </thead>

            <tbody>
              {transactions.length === 0 && !loading ? (
                <tr>
                  <td
                    colSpan={
                      5 + (privileged ? 1 : 0) + (isAdmin ? 1 : 0)
                    }
                    className="p-8 text-center text-gray-400"
                  >
                    No transactions to show.
                  </td>
                </tr>
              ) : (
                transactions.map((t) => (
                  <tr key={t.id} className="border-b">
                    <td className="p-4">{t.merchant}</td>
                    <td className="p-4">
                      R {t.amount.toFixed(2)}
                      {t.amount < 0 && (
                        <span className="ml-2 text-xs text-green-700">refund</span>
                      )}
                    </td>
                    <td className="p-4 text-gray-700">
                      {t.category ?? '—'}
                    </td>
                    <td className="p-4">
                      <span
                        className={`text-xs ${
                          t.flagged
                            ? 'text-orange-700 font-medium'
                            : 'text-gray-700'
                        }`}
                      >
                        {t.status}
                        {t.flagged ? ' · flagged' : ''}
                      </span>
                    </td>
                    {privileged && (
                      <td className="p-4 text-gray-700">
                        {t.cardholder.name ? (
                          <>
                            <p className="text-sm">
                              {t.cardholder.name}
                              {!t.cardholder.assigned && (
                                <span className="ml-2 text-xs text-orange-600">
                                  unassigned
                                </span>
                              )}
                            </p>
                            <p className="text-xs text-gray-500">
                              {t.cardholder.email ??
                                (t.cardholder.last4
                                  ? `Card …${t.cardholder.last4}`
                                  : '')}
                            </p>
                          </>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                    )}
                    <td className="p-4 text-gray-700 whitespace-nowrap">
                      {new Date(t.transactionDate).toLocaleDateString()}
                    </td>
                    {isAdmin && (
                      <td className="p-4 text-right">
                        <button
                          onClick={() => openEdit(t)}
                          className="text-sm text-gray-700 hover:text-black"
                        >
                          Edit
                        </button>
                      </td>
                    )}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Admin edit-transaction modal */}
        {editing && editDraft && (
          <div
            className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
            onClick={() => !savingEdit && closeEdit()}
          >
            <div
              className="bg-white rounded-xl p-6 w-full max-w-md shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-lg font-semibold mb-4">Edit transaction</h3>

              <div className="space-y-3">
                <ModalField
                  label="Merchant"
                  value={editDraft.merchant}
                  onChange={(v) => setEditDraft({ ...editDraft, merchant: v })}
                />
                <ModalField
                  label="Amount (ZAR)"
                  type="number"
                  value={editDraft.amount}
                  onChange={(v) => setEditDraft({ ...editDraft, amount: v })}
                />
                <ModalField
                  label="Category"
                  value={editDraft.category}
                  onChange={(v) => setEditDraft({ ...editDraft, category: v })}
                />
                <ModalField
                  label="Description / location"
                  value={editDraft.description}
                  onChange={(v) =>
                    setEditDraft({ ...editDraft, description: v })
                  }
                />
                <div className="grid grid-cols-2 gap-3">
                  <ModalField
                    label="Date"
                    type="date"
                    value={editDraft.transactionDate}
                    onChange={(v) =>
                      setEditDraft({ ...editDraft, transactionDate: v })
                    }
                  />
                  <ModalField
                    label="Card last 4"
                    value={editDraft.cardLast4}
                    onChange={(v) =>
                      setEditDraft({ ...editDraft, cardLast4: v })
                    }
                  />
                </div>
              </div>

              <p className="text-xs text-gray-500 mt-3">
                Changing card last 4 routes this transaction to a different
                cardholder's records.
              </p>

              <div className="flex justify-end gap-2 mt-5">
                <button
                  onClick={closeEdit}
                  disabled={savingEdit}
                  className="px-4 py-2 rounded-lg text-gray-700 hover:bg-gray-100"
                >
                  Cancel
                </button>
                <button
                  onClick={saveEdit}
                  disabled={savingEdit}
                  className="bg-black text-white px-4 py-2 rounded-lg hover:opacity-90 disabled:opacity-40"
                >
                  {savingEdit ? 'Saving...' : 'Save changes'}
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

// Small reusable input row for the edit modal.
function ModalField({
  label, value, onChange, type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <div>
      <label className="block text-xs text-gray-600 mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-500"
      />
    </div>
  );
}
