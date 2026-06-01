'use client';

import { useEffect, useState } from 'react';
import Sidebar from '@/components/Sidebar';
import { api, ApiError } from '@/lib/api';

type Category = {
  id: string;
  name: string;
  active: boolean;
  sortOrder: number | null;
  createdAt: string;
};

interface Draft {
  id?: string;
  name: string;
  sortOrder: string; // string so the input field is controlled cleanly
  active: boolean;
}

const EMPTY_DRAFT: Draft = {
  name: '',
  sortOrder: '',
  active: true,
};

export default function AdminCategoriesPage() {
  const [categories, setCategories] = useState<Category[]>([]);
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
      const data = await api<Category[]>(
        `/categories?includeInactive=${showInactive}`,
      );
      setCategories(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showInactive]);

  function openCreate() {
    setDraft(EMPTY_DRAFT);
    setEditorOpen(true);
  }

  function openEdit(c: Category) {
    setDraft({
      id: c.id,
      name: c.name,
      // Show blank for null so the field reads naturally; nothing means
      // "no manual order, sort alphabetically".
      sortOrder: c.sortOrder == null ? '' : String(c.sortOrder),
      active: c.active,
    });
    setEditorOpen(true);
  }

  async function saveDraft() {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      // Parse sortOrder lazily — blank means null (no override).
      const sortOrder = draft.sortOrder.trim()
        ? parseInt(draft.sortOrder, 10)
        : null;
      const payload: {
        name: string;
        sortOrder: number | null;
        active?: boolean;
      } = {
        name: draft.name.trim(),
        sortOrder: Number.isNaN(sortOrder as number) ? null : sortOrder,
      };
      // Only send `active` on edit — on create we let the backend default to true.
      if (draft.id) payload.active = draft.active;

      if (draft.id) {
        await api(`/categories/${draft.id}`, {
          method: 'PATCH',
          json: payload,
        });
        setMessage('Category updated.');
      } else {
        await api('/categories', { method: 'POST', json: payload });
        setMessage('Category created.');
      }
      setEditorOpen(false);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeactivate(c: Category) {
    if (!confirm(`Deactivate "${c.name}"? Historical invoices keep this category.`)) {
      return;
    }
    try {
      await api(`/categories/${c.id}`, { method: 'DELETE' });
      setMessage(`${c.name} deactivated.`);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Deactivate failed');
    }
  }

  async function handleReactivate(c: Category) {
    try {
      await api(`/categories/${c.id}`, {
        method: 'PATCH',
        json: { active: true },
      });
      setMessage(`${c.name} reactivated.`);
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
            <h1 className="text-3xl font-bold">Categories</h1>
            <p className="text-gray-600 mt-1">
              {loading ? 'Loading...' : `${categories.length} categor${categories.length === 1 ? 'y' : 'ies'}`}
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
            >
              + New category
            </button>
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

        <div className="bg-white rounded-xl shadow overflow-hidden">
          <table className="w-full">
            <thead className="bg-black text-white">
              <tr>
                <th className="text-left p-4">Name</th>
                <th className="text-left p-4">Sort order</th>
                <th className="text-left p-4">Status</th>
                <th className="text-right p-4">Actions</th>
              </tr>
            </thead>
            <tbody>
              {categories.length === 0 && !loading ? (
                <tr>
                  <td colSpan={4} className="p-8 text-center text-gray-400">
                    No categories.
                  </td>
                </tr>
              ) : (
                categories.map((c) => (
                  <tr
                    key={c.id}
                    className={`border-b ${!c.active ? 'opacity-50' : ''}`}
                  >
                    <td className="p-4 font-medium">{c.name}</td>
                    <td className="p-4 text-gray-700">
                      {c.sortOrder ?? <span className="text-gray-400">—</span>}
                    </td>
                    <td className="p-4">
                      {c.active ? (
                        <span className="text-green-700 text-sm">Active</span>
                      ) : (
                        <span className="text-gray-500 text-sm">Inactive</span>
                      )}
                    </td>
                    <td className="p-4 text-right">
                      <button
                        onClick={() => openEdit(c)}
                        className="text-sm text-gray-700 hover:text-black mr-3"
                      >
                        Edit
                      </button>
                      {c.active ? (
                        <button
                          onClick={() => handleDeactivate(c)}
                          className="text-sm text-red-600 hover:text-red-800"
                        >
                          Deactivate
                        </button>
                      ) : (
                        <button
                          onClick={() => handleReactivate(c)}
                          className="text-sm text-green-700 hover:text-green-900"
                        >
                          Reactivate
                        </button>
                      )}
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
            <div
              className="bg-white rounded-xl p-6 w-full max-w-md shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="text-lg font-semibold mb-4">
                {draft.id ? 'Edit category' : 'Create category'}
              </h3>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Name
                  </label>
                  <input
                    type="text"
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    placeholder="e.g. Travel & Accomodation - Local"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Sort order (optional)
                  </label>
                  <input
                    type="number"
                    value={draft.sortOrder}
                    onChange={(e) =>
                      setDraft({ ...draft, sortOrder: e.target.value })
                    }
                    placeholder="Lower = higher in the dropdown"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-500"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Leave blank to sort alphabetically after the ordered ones.
                  </p>
                </div>
              </div>
              <div className="flex justify-end gap-2 mt-5">
                <button
                  onClick={() => setEditorOpen(false)}
                  disabled={saving}
                  className="px-4 py-2 rounded-lg text-gray-700 hover:bg-gray-100"
                >
                  Cancel
                </button>
                <button
                  onClick={saveDraft}
                  disabled={saving || !draft.name.trim()}
                  className="bg-black text-white px-4 py-2 rounded-lg hover:opacity-90 disabled:opacity-40"
                >
                  {saving ? 'Saving...' : draft.id ? 'Save changes' : 'Create'}
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}
