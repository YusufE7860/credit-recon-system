'use client';

import { useEffect, useState } from 'react';
import Sidebar from '@/components/Sidebar';
import { api, ApiError } from '@/lib/api';

type AssignedUser = {
  id: string;
  name: string;
  email: string;
  role: string;
};

type Card = {
  id: string;
  cardName: string;
  cardholderName: string | null;
  maskedNumber: string;
  last4: string | null;
  assignedUserId: string | null;
  assignedUser: AssignedUser | null;
  transactionCount: number;
  createdAt: string;
};

type User = {
  id: string;
  name: string;
  email: string;
  role: string;
};

interface CardDraft {
  cardName: string;
  cardholderName: string;
  maskedNumber: string;
  last4: string;
  assignedUserId: string;
}

const EMPTY_DRAFT: CardDraft = {
  cardName: '',
  cardholderName: '',
  maskedNumber: '',
  last4: '',
  assignedUserId: '',
};

export default function CardsPage() {
  const [cards, setCards] = useState<Card[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busyCardId, setBusyCardId] = useState<string | null>(null);

  // "+ Add card" modal
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [draft, setDraft] = useState<CardDraft>(EMPTY_DRAFT);
  const [creating, setCreating] = useState(false);

  // Merge mode — admin picks a winning card, then clicks "Merge into
  // this" on another card row to fold its transactions in.
  const [mergeWinnerId, setMergeWinnerId] = useState<string | null>(null);

  async function reload() {
    setLoading(true);
    setError('');
    try {
      const [cardsData, usersData] = await Promise.all([
        api<Card[]>('/cards'),
        api<User[]>('/users'),
      ]);
      setCards(cardsData);
      setUsers(usersData);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Failed to load cards',
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
  }, []);

  async function handleAssign(cardId: string, userId: string | null) {
    setBusyCardId(cardId);
    setError('');
    setMessage('');
    try {
      await api(`/cards/${cardId}/assign`, {
        method: 'PATCH',
        json: { userId },
      });
      setMessage(
        userId
          ? 'Assigned. Existing flagged transactions re-routed.'
          : 'Unassigned.',
      );
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Assign failed');
    } finally {
      setBusyCardId(null);
    }
  }

  async function handleRename(card: Card) {
    const next = prompt('New card label:', card.cardName);
    if (next === null || next === card.cardName) return;
    setBusyCardId(card.id);
    try {
      await api(`/cards/${card.id}`, {
        method: 'PATCH',
        json: { cardName: next },
      });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Rename failed');
    } finally {
      setBusyCardId(null);
    }
  }

  async function handleCreate() {
    if (!draft.cardName.trim() || !draft.maskedNumber.trim()) {
      setError('Card label and masked number are required.');
      return;
    }
    setCreating(true);
    setError('');
    setMessage('');
    try {
      await api('/cards', {
        method: 'POST',
        json: {
          cardName: draft.cardName.trim(),
          cardholderName: draft.cardholderName.trim() || undefined,
          maskedNumber: draft.maskedNumber.trim(),
          last4: draft.last4.trim() || undefined,
          assignedUserId: draft.assignedUserId || undefined,
        },
      });
      setMessage(`Card "${draft.cardName}" created.`);
      setCreatorOpen(false);
      setDraft(EMPTY_DRAFT);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Create failed');
    } finally {
      setCreating(false);
    }
  }

  async function handleMergeInto(loser: Card) {
    if (!mergeWinnerId || mergeWinnerId === loser.id) return;
    const winner = cards.find((c) => c.id === mergeWinnerId);
    if (!winner) return;
    if (
      !confirm(
        `Merge "${loser.cardName}" (…${loser.last4 ?? '?'}) INTO "${winner.cardName}" (…${winner.last4 ?? '?'})?\n\n` +
          `Every transaction on the loser will be re-routed to the winner, then the loser is deleted. ` +
          `This cannot be undone.`,
      )
    ) {
      return;
    }
    setBusyCardId(loser.id);
    setError('');
    try {
      await api(`/cards/${mergeWinnerId}/merge`, {
        method: 'POST',
        json: { losingId: loser.id },
      });
      setMessage(
        `Merged "${loser.cardName}" into "${winner.cardName}". Transactions re-routed.`,
      );
      setMergeWinnerId(null);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Merge failed');
    } finally {
      setBusyCardId(null);
    }
  }

  async function handleDelete(card: Card) {
    if (
      !confirm(
        `Delete card "${card.cardName}"? This won't delete its transactions.`,
      )
    )
      return;
    setBusyCardId(card.id);
    try {
      await api(`/cards/${card.id}`, { method: 'DELETE' });
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Delete failed');
    } finally {
      setBusyCardId(null);
    }
  }

  const unassignedCount = cards.filter((c) => !c.assignedUserId).length;

  return (
    <main className="flex min-h-screen bg-gray-100">
      <Sidebar />

      <section className="flex-1 min-w-0 p-4 pt-16 md:p-8">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-3xl font-bold">Cards</h1>
            <p className="text-gray-600 mt-1">
              {loading
                ? 'Loading...'
                : `${cards.length} cards${
                    unassignedCount > 0
                      ? ` · ${unassignedCount} unassigned`
                      : ''
                  }`}
            </p>
          </div>
          <button
            onClick={() => {
              setDraft(EMPTY_DRAFT);
              setCreatorOpen(true);
            }}
            className="bg-black text-white px-4 py-2 rounded-lg font-medium hover:opacity-90"
          >
            + Add card
          </button>
        </div>

        {/* Merge banner — only visible once admin has picked a winner */}
        {mergeWinnerId && (
          <div className="bg-purple-50 border border-purple-200 rounded-xl p-4 mb-6 flex items-center justify-between">
            <p className="text-sm text-purple-900">
              <strong>Merging into:</strong>{' '}
              {cards.find((c) => c.id === mergeWinnerId)?.cardName ?? '—'}{' '}
              <span className="text-purple-700">
                — click "Merge into this" on another row to fold it in.
              </span>
            </p>
            <button
              onClick={() => setMergeWinnerId(null)}
              className="text-sm text-purple-700 hover:text-purple-900 underline"
            >
              Cancel merge
            </button>
          </div>
        )}

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

        {unassignedCount > 0 && (
          <div className="bg-orange-50 border border-orange-200 rounded-xl p-4 mb-6">
            <p className="text-sm text-orange-900 font-medium">
              {unassignedCount} card{unassignedCount === 1 ? '' : 's'} need a user assignment.
            </p>
            <p className="text-xs text-orange-800 mt-1">
              All transactions on unassigned cards are flagged for review and
              currently attributed to whoever uploaded the statement. Assigning
              a user re-routes them automatically.
            </p>
          </div>
        )}

        {/* Create-card modal */}
        {creatorOpen && (
          <div
            className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
            onClick={() => !creating && setCreatorOpen(false)}
          >
            <div
              className="bg-white rounded-xl p-6 w-full max-w-md shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-lg font-semibold mb-1">Add card</h3>
              <p className="text-sm text-gray-600 mb-4">
                Manually create a card. Statement uploads will auto-link
                future transactions by the last 4 digits.
              </p>

              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Card label *
                  </label>
                  <input
                    type="text"
                    value={draft.cardName}
                    onChange={(e) =>
                      setDraft({ ...draft, cardName: e.target.value })
                    }
                    placeholder="e.g. Marketing Visa"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Masked number *
                  </label>
                  <input
                    type="text"
                    value={draft.maskedNumber}
                    onChange={(e) =>
                      setDraft({ ...draft, maskedNumber: e.target.value })
                    }
                    placeholder="4228 24** **** 5678"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 font-mono focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Last 4 digits
                  </label>
                  <input
                    type="text"
                    value={draft.last4}
                    onChange={(e) =>
                      setDraft({ ...draft, last4: e.target.value })
                    }
                    placeholder="5678"
                    maxLength={4}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 font-mono focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Used to match transactions on future statement uploads.
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Cardholder name (on card)
                  </label>
                  <input
                    type="text"
                    value={draft.cardholderName}
                    onChange={(e) =>
                      setDraft({ ...draft, cardholderName: e.target.value })
                    }
                    placeholder="JANE DOE"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Assign to user
                  </label>
                  <select
                    value={draft.assignedUserId}
                    onChange={(e) =>
                      setDraft({ ...draft, assignedUserId: e.target.value })
                    }
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-500"
                  >
                    <option value="">— Leave unassigned —</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.name} ({u.email})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex justify-end gap-2 mt-5">
                <button
                  onClick={() => setCreatorOpen(false)}
                  disabled={creating}
                  className="px-4 py-2 rounded-lg text-gray-700 hover:bg-gray-100"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreate}
                  disabled={
                    creating ||
                    !draft.cardName.trim() ||
                    !draft.maskedNumber.trim()
                  }
                  className="bg-black text-white px-4 py-2 rounded-lg hover:opacity-90 disabled:opacity-40"
                >
                  {creating ? 'Creating...' : 'Create card'}
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="bg-white rounded-xl shadow overflow-x-auto">
          <table className="w-full">
            <thead className="bg-black text-white">
              <tr>
                <th className="text-left p-4">Card label</th>
                <th className="text-left p-4">Cardholder (from statement)</th>
                <th className="text-left p-4">Masked number</th>
                <th className="text-right p-4">Txns</th>
                <th className="text-left p-4">Assigned user</th>
                <th className="text-right p-4">Actions</th>
              </tr>
            </thead>
            <tbody>
              {cards.length === 0 && !loading ? (
                <tr>
                  <td
                    colSpan={6}
                    className="p-8 text-center text-gray-400"
                  >
                    No cards yet. Upload a bank statement to auto-create them.
                  </td>
                </tr>
              ) : (
                cards.map((c) => (
                  <tr
                    key={c.id}
                    className={`border-b ${
                      busyCardId === c.id ? 'opacity-40' : ''
                    }`}
                  >
                    <td className="p-4 font-medium">{c.cardName}</td>
                    <td className="p-4 text-gray-600">
                      {c.cardholderName ?? '—'}
                    </td>
                    <td className="p-4 text-gray-600 font-mono text-sm">
                      {c.maskedNumber}
                    </td>
                    <td className="p-4 text-right">
                      {c.transactionCount}
                    </td>
                    <td className="p-4">
                      <select
                        value={c.assignedUserId ?? ''}
                        disabled={busyCardId === c.id}
                        onChange={(e) =>
                          handleAssign(c.id, e.target.value || null)
                        }
                        className={`border rounded px-2 py-1 text-sm ${
                          c.assignedUserId
                            ? 'bg-white'
                            : 'bg-orange-50 border-orange-300'
                        }`}
                      >
                        <option value="">— Unassigned —</option>
                        {users.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name} ({u.email})
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="p-4 text-right whitespace-nowrap">
                      {/* Merge controls. Two modes:
                          - no winner picked → "Merge…" sets this row as winner
                          - winner picked, this is NOT the winner → "Merge into this"
                            folds THIS row into the winner */}
                      {mergeWinnerId === null ? (
                        <button
                          onClick={() => setMergeWinnerId(c.id)}
                          disabled={busyCardId === c.id}
                          className="text-sm text-purple-700 hover:text-purple-900 mr-3"
                          title="Use this card as the merge target — then pick another card to fold in"
                        >
                          Merge…
                        </button>
                      ) : mergeWinnerId !== c.id ? (
                        <button
                          onClick={() => handleMergeInto(c)}
                          disabled={busyCardId === c.id}
                          className="text-sm text-purple-700 hover:text-purple-900 mr-3 font-medium"
                          title={`Fold this card into "${cards.find((x) => x.id === mergeWinnerId)?.cardName ?? ''}"`}
                        >
                          ← Merge into target
                        </button>
                      ) : (
                        <span className="text-xs text-purple-700 font-medium mr-3">
                          merge target
                        </span>
                      )}
                      <button
                        onClick={() => handleRename(c)}
                        disabled={busyCardId === c.id}
                        className="text-sm text-gray-600 hover:text-black mr-3"
                      >
                        Rename
                      </button>
                      <button
                        onClick={() => handleDelete(c)}
                        disabled={busyCardId === c.id}
                        className="text-sm text-red-600 hover:text-red-800"
                      >
                        Delete
                      </button>
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
