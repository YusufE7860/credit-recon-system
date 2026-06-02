'use client';

import { useEffect, useState } from 'react';
import Sidebar from '@/components/Sidebar';
import { api, ApiError } from '@/lib/api';

type Store = {
  id: string;
  name: string;
  code: string | null;
  address: string | null;
  active: boolean;
  createdAt: string;
};

interface Draft {
  id?: string;
  name: string;
  code: string;
  address: string;
  active: boolean;
}

const EMPTY_DRAFT: Draft = {
  name: '', code: '', address: '', active: true,
};

export default function AdminStoresPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [showInactive, setShowInactive] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);

  async function reload() {
    setLoading(true);
    setError('');
    try {
      const data = await api<Store[]>(
        `/stores?includeInactive=${showInactive}`,
      );
      setStores(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [showInactive]);

  function openCreate() { setDraft(EMPTY_DRAFT); setEditorOpen(true); }
  function openEdit(s: Store) {
    setDraft({
      id: s.id, name: s.name, code: s.code ?? '',
      address: s.address ?? '', active: s.active,
    });
    setEditorOpen(true);
  }

  async function saveDraft() {
    setSaving(true); setError(''); setMessage('');
    try {
      const payload = {
        name: draft.name,
        code: draft.code || null,
        address: draft.address || null,
        active: draft.active,
      };
      if (draft.id) {
        await api(`/stores/${draft.id}`, { method: 'PATCH', json: payload });
        setMessage('Store updated.');
      } else {
        await api('/stores', { method: 'POST', json: payload });
        setMessage('Store created.');
      }
      setEditorOpen(false);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeactivate(s: Store) {
    if (!confirm(`Deactivate ${s.name}?`)) return;
    try {
      await api(`/stores/${s.id}`, { method: 'DELETE' });
      setMessage(`${s.name} deactivated.`);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Deactivate failed');
    }
  }

  async function handleReactivate(s: Store) {
    try {
      await api(`/stores/${s.id}`, { method: 'PATCH', json: { active: true } });
      setMessage(`${s.name} reactivated.`);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Reactivate failed');
    }
  }

  return (
    <main className="flex min-h-screen bg-gray-100">
      <Sidebar />
      <section className="flex-1 p-4 pt-16 md:p-8">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-3xl font-bold">Stores</h1>
            <p className="text-gray-600 mt-1">
              {loading ? 'Loading...' : `${stores.length} stores`}
            </p>
          </div>
          <div className="flex gap-2 items-center">
            <label className="text-sm text-gray-600 flex items-center gap-2">
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
              />
              Show inactive
            </label>
            <button
              onClick={openCreate}
              className="bg-black text-white px-4 py-2 rounded-lg font-medium hover:opacity-90"
            >+ New store</button>
          </div>
        </div>

        {error && <p className="text-sm text-red-600 bg-red-50 p-3 rounded mb-4">{error}</p>}
        {message && <p className="text-sm text-green-700 bg-green-50 p-3 rounded mb-4">{message}</p>}

        <div className="bg-white rounded-xl shadow overflow-x-auto">
          <table className="w-full">
            <thead className="bg-black text-white">
              <tr>
                <th className="text-left p-4">Name</th>
                <th className="text-left p-4">Code</th>
                <th className="text-left p-4">Address</th>
                <th className="text-left p-4">Status</th>
                <th className="text-right p-4">Actions</th>
              </tr>
            </thead>
            <tbody>
              {stores.length === 0 && !loading ? (
                <tr><td colSpan={5} className="p-8 text-center text-gray-400">No stores.</td></tr>
              ) : (
                stores.map((s) => (
                  <tr key={s.id} className={`border-b ${!s.active ? 'opacity-50' : ''}`}>
                    <td className="p-4 font-medium">{s.name}</td>
                    <td className="p-4 text-gray-700">{s.code ?? '—'}</td>
                    <td className="p-4 text-gray-700 text-sm">{s.address ?? '—'}</td>
                    <td className="p-4">
                      {s.active
                        ? <span className="text-green-700 text-sm">Active</span>
                        : <span className="text-gray-500 text-sm">Inactive</span>}
                    </td>
                    <td className="p-4 text-right">
                      <button
                        onClick={() => openEdit(s)}
                        className="text-sm text-gray-700 hover:text-black mr-3"
                      >Edit</button>
                      {s.active
                        ? <button
                            onClick={() => handleDeactivate(s)}
                            className="text-sm text-red-600 hover:text-red-800"
                          >Deactivate</button>
                        : <button
                            onClick={() => handleReactivate(s)}
                            className="text-sm text-green-700 hover:text-green-900"
                          >Reactivate</button>}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {editorOpen && (
          <div
            className="fixed inset-0 bg-black/40 flex items-center justify-center z-50"
            onClick={() => !saving && setEditorOpen(false)}
          >
            <div className="bg-white rounded-xl p-6 w-full max-w-md shadow-2xl"
                 onClick={(e) => e.stopPropagation()}>
              <h3 className="text-lg font-semibold mb-4">
                {draft.id ? 'Edit store' : 'Create store'}
              </h3>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
                  <input
                    type="text" value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Code (optional)
                  </label>
                  <input
                    type="text" value={draft.code}
                    onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                    placeholder="e.g. CPT"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Address (optional)
                  </label>
                  <textarea
                    value={draft.address}
                    onChange={(e) => setDraft({ ...draft, address: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 h-20 focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 mt-5">
                <button
                  onClick={() => setEditorOpen(false)} disabled={saving}
                  className="px-4 py-2 rounded-lg text-gray-700 hover:bg-gray-100"
                >Cancel</button>
                <button
                  onClick={saveDraft} disabled={saving || !draft.name}
                  className="bg-black text-white px-4 py-2 rounded-lg hover:opacity-90 disabled:opacity-40"
                >{saving ? 'Saving...' : draft.id ? 'Save changes' : 'Create'}</button>
              </div>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
