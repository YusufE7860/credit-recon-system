'use client';

import { useEffect, useState } from 'react';
import Sidebar from '@/components/Sidebar';
import { api, ApiError } from '@/lib/api';

type Role = 'USER' | 'UPLOADER' | 'REPORTING' | 'ADMIN';

type User = {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  createdAt: string;
  // For UPLOADER role: the IDs of the users they are allowed to upload
  // invoices on behalf of. Empty for every other role.
  managedUserIds: string[];
};

const ROLE_STYLES: Record<Role, string> = {
  USER:      'bg-gray-100 text-gray-700',
  UPLOADER:  'bg-amber-100 text-amber-800',
  REPORTING: 'bg-blue-100 text-blue-800',
  ADMIN:     'bg-purple-100 text-purple-800',
};

// Used by the create/edit form.
interface UserDraft {
  id?: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  password?: string;
  // Only used when role === UPLOADER. List of user IDs they can
  // upload invoices on behalf of.
  managedUserIds: string[];
}

const EMPTY_DRAFT: UserDraft = {
  name: '',
  email: '',
  role: 'USER',
  active: true,
  password: '',
  managedUserIds: [],
};

export default function AdminUsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [showInactive, setShowInactive] = useState(false);

  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState<UserDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);

  async function reload() {
    setLoading(true);
    setError('');
    try {
      const data = await api<User[]>('/users');
      setUsers(data);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Failed to load users',
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
  }, []);

  function openCreate() {
    setDraft(EMPTY_DRAFT);
    setEditorOpen(true);
  }

  function openEdit(u: User) {
    setDraft({
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role,
      active: u.active,
      password: '',
      managedUserIds: u.managedUserIds ?? [],
    });
    setEditorOpen(true);
  }

  async function saveDraft() {
    setSaving(true);
    setError('');
    setMessage('');
    try {
      if (draft.id) {
        // Update existing user — name/email/role/active + managedUserIds
        // (only meaningful when role === UPLOADER; ignored otherwise).
        await api(`/users/${draft.id}`, {
          method: 'PATCH',
          json: {
            name: draft.name,
            email: draft.email,
            role: draft.role,
            active: draft.active,
            managedUserIds:
              draft.role === 'UPLOADER' ? draft.managedUserIds : [],
          },
        });
        // If password was supplied during edit, set it via the dedicated route.
        if (draft.password && draft.password.length > 0) {
          await api(`/users/${draft.id}/set-password`, {
            method: 'POST',
            json: { password: draft.password },
          });
        }
        setMessage('User updated.');
      } else {
        // Create new user — password required.
        if (!draft.password || draft.password.length < 8) {
          throw new Error('Password (8+ chars) required for new users.');
        }
        await api('/users', {
          method: 'POST',
          json: {
            name: draft.name,
            email: draft.email,
            password: draft.password,
            role: draft.role,
            managedUserIds:
              draft.role === 'UPLOADER' ? draft.managedUserIds : [],
          },
        });
        setMessage('User created.');
      }
      setEditorOpen(false);
      await reload();
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : (err as Error).message,
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleDeactivate(u: User) {
    if (!confirm(`Deactivate ${u.name}? They won't be able to log in.`)) return;
    try {
      await api(`/users/${u.id}`, { method: 'DELETE' });
      setMessage(`${u.name} deactivated.`);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Deactivate failed');
    }
  }

  async function handleReactivate(u: User) {
    try {
      await api(`/users/${u.id}/reactivate`, { method: 'PATCH' });
      setMessage(`${u.name} reactivated.`);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Reactivate failed');
    }
  }

  const visibleUsers = showInactive ? users : users.filter((u) => u.active);

  return (
    <main className="flex min-h-screen bg-gray-100">
      <Sidebar />

      <section className="flex-1 min-w-0 p-4 pt-16 md:p-8">
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-3xl font-bold">Users</h1>
            <p className="text-gray-600 mt-1">
              {loading ? 'Loading...' : `${visibleUsers.length} users`}
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
              + New user
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

        <div className="bg-white rounded-xl shadow overflow-x-auto">
          <table className="w-full">
            <thead className="bg-black text-white">
              <tr>
                <th className="text-left p-4">Name</th>
                <th className="text-left p-4">Email</th>
                <th className="text-left p-4">Role</th>
                <th className="text-left p-4">Status</th>
                <th className="text-right p-4">Actions</th>
              </tr>
            </thead>
            <tbody>
              {visibleUsers.length === 0 && !loading ? (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-gray-400">
                    No users to show.
                  </td>
                </tr>
              ) : (
                visibleUsers.map((u) => (
                  <tr
                    key={u.id}
                    className={`border-b ${!u.active ? 'opacity-50' : ''}`}
                  >
                    <td className="p-4 font-medium">{u.name}</td>
                    <td className="p-4 text-gray-600">{u.email}</td>
                    <td className="p-4">
                      <span
                        className={`px-2 py-0.5 rounded text-xs font-medium ${ROLE_STYLES[u.role]}`}
                      >
                        {u.role}
                      </span>
                    </td>
                    <td className="p-4">
                      {u.active ? (
                        <span className="text-green-700 text-sm">Active</span>
                      ) : (
                        <span className="text-gray-600 text-sm">Inactive</span>
                      )}
                    </td>
                    <td className="p-4 text-right">
                      <button
                        onClick={() => openEdit(u)}
                        className="text-sm text-gray-600 hover:text-black mr-3"
                      >
                        Edit
                      </button>
                      {u.active ? (
                        <button
                          onClick={() => handleDeactivate(u)}
                          className="text-sm text-red-600 hover:text-red-800"
                        >
                          Deactivate
                        </button>
                      ) : (
                        <button
                          onClick={() => handleReactivate(u)}
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

        {/* Create/Edit modal */}
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
                {draft.id ? 'Edit user' : 'Create user'}
              </h3>

              <div className="space-y-3">
                <Field
                  label="Name"
                  value={draft.name}
                  onChange={(v) => setDraft({ ...draft, name: v })}
                />
                <Field
                  type="email"
                  label="Email"
                  value={draft.email}
                  onChange={(v) => setDraft({ ...draft, email: v })}
                />

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Role
                  </label>
                  <select
                    value={draft.role}
                    onChange={(e) =>
                      setDraft({ ...draft, role: e.target.value as Role })
                    }
                    className="w-full border border-gray-300 rounded-lg px-3 py-2"
                  >
                    <option value="USER">USER — own data only</option>
                    <option value="UPLOADER">UPLOADER — assistant who uploads on behalf of others</option>
                    <option value="REPORTING">REPORTING — view all, can run recon</option>
                    <option value="ADMIN">ADMIN — full control</option>
                  </select>

                  {/* Managed-users multi-select — only shown for UPLOADER.
                      Lists every other active user; admin ticks which ones
                      this assistant is allowed to upload invoices for. */}
                  {draft.role === 'UPLOADER' && (
                    <div className="mt-3 border border-amber-200 bg-amber-50 rounded-lg p-3">
                      <label className="block text-sm font-medium text-gray-700 mb-2">
                        Uploads invoices for
                      </label>
                      <p className="text-xs text-gray-600 mb-2">
                        Select the users whose receipts this assistant
                        will upload. They&apos;ll only ever see invoices
                        they personally uploaded, never the owning
                        user&apos;s totals or other data.
                      </p>
                      <div className="max-h-44 overflow-y-auto bg-white border border-gray-200 rounded">
                        {users
                          .filter((u) => u.id !== draft.id && u.role !== 'UPLOADER')
                          .map((u) => {
                            const checked = draft.managedUserIds.includes(u.id);
                            return (
                              <label
                                key={u.id}
                                className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50 cursor-pointer border-b border-gray-100 last:border-b-0"
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={(e) => {
                                    setDraft({
                                      ...draft,
                                      managedUserIds: e.target.checked
                                        ? [...draft.managedUserIds, u.id]
                                        : draft.managedUserIds.filter((id) => id !== u.id),
                                    });
                                  }}
                                />
                                <span>
                                  {u.name}{' '}
                                  <span className="text-gray-500">
                                    ({u.email})
                                  </span>
                                </span>
                              </label>
                            );
                          })}
                      </div>
                      {draft.managedUserIds.length === 0 && (
                        <p className="text-xs text-orange-700 mt-2">
                          No users selected — this assistant won&apos;t be able to upload anything.
                        </p>
                      )}
                    </div>
                  )}
                </div>

                <Field
                  type="password"
                  label={
                    draft.id
                      ? 'New password (leave blank to keep current)'
                      : 'Password (8+ chars)'
                  }
                  value={draft.password ?? ''}
                  onChange={(v) => setDraft({ ...draft, password: v })}
                  placeholder={draft.id ? '••••••••' : 'Required'}
                />

                {draft.id && (
                  <label className="text-sm text-gray-600 flex items-center gap-2 pt-1">
                    <input
                      type="checkbox"
                      checked={draft.active}
                      onChange={(e) =>
                        setDraft({ ...draft, active: e.target.checked })
                      }
                    />
                    Active (can log in)
                  </label>
                )}
              </div>

              <div className="flex justify-end gap-2 mt-6">
                <button
                  onClick={() => setEditorOpen(false)}
                  disabled={saving}
                  className="px-4 py-2 rounded-lg text-gray-700 hover:bg-gray-100"
                >
                  Cancel
                </button>
                <button
                  onClick={saveDraft}
                  disabled={saving || !draft.name || !draft.email}
                  className="bg-black text-white px-4 py-2 rounded-lg hover:opacity-90 disabled:opacity-40"
                >
                  {saving ? 'Saving...' : draft.id ? 'Save changes' : 'Create user'}
                </button>
              </div>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-black"
      />
    </div>
  );
}
