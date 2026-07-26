'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { api, ApiError } from '@/lib/api';
import { useCurrentUser } from '@/lib/user-context';

// Full-bleed page — no sidebar or bottom nav (the UserProvider guards
// most routes and forces users here; showing the app chrome around
// them would tempt them to try navigating away). Similar look-and-feel
// to the login screen so it feels like part of the same flow.
export default function ChangePasswordPage() {
  const router = useRouter();
  const { user, loading, refresh } = useCurrentUser();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  // When the user is here because an admin set a temp password, we
  // skip the "current password" input — they just typed it into the
  // login form, requiring them to type it again would feel pedantic.
  const isForced = !!user?.mustResetPassword;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('New password and confirmation do not match.');
      return;
    }
    if (!isForced && !currentPassword) {
      setError('Enter your current password to confirm the change.');
      return;
    }
    setBusy(true);
    try {
      await api('/auth/change-password', {
        method: 'POST',
        json: {
          currentPassword: isForced ? undefined : currentPassword,
          newPassword,
        },
      });
      // Refresh /auth/me so the mustResetPassword flag is cleared in
      // memory and the redirect guard stops firing.
      await refresh();
      setDone(true);
      // Give the success message a beat, then send them home.
      setTimeout(() => {
        router.replace(user?.role === 'UPLOADER' ? '/upload' : '/dashboard');
      }, 1200);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Failed to change password',
      );
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center">
        <p className="text-sm text-gray-500">Loading...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center px-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-xl p-6 sm:p-8">
        <div className="flex justify-center mb-6">
          <Image
            src="/fusion-logo.png"
            alt="FUSION"
            width={140}
            height={35}
            priority
          />
        </div>

        <h1 className="text-xl sm:text-2xl font-bold text-center">
          {isForced ? 'Set your password' : 'Change password'}
        </h1>
        <p className="text-sm text-gray-600 text-center mt-2 mb-6">
          {isForced
            ? `Welcome${user?.name ? `, ${user.name.split(' ')[0]}` : ''} — pick a password only you know. The temporary one you were given won't work again.`
            : 'Choose a new password. You will stay logged in.'}
        </p>

        {done ? (
          <div className="bg-green-50 border border-green-200 text-green-800 p-4 rounded-lg text-sm text-center">
            Password changed. Redirecting...
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {!isForced && (
              <Field
                label="Current password"
                type="password"
                value={currentPassword}
                onChange={setCurrentPassword}
                autoComplete="current-password"
              />
            )}
            <Field
              label="New password"
              type="password"
              value={newPassword}
              onChange={setNewPassword}
              autoComplete="new-password"
              hint="At least 8 characters."
            />
            <Field
              label="Confirm new password"
              type="password"
              value={confirmPassword}
              onChange={setConfirmPassword}
              autoComplete="new-password"
            />

            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 p-3 rounded-lg text-sm">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full bg-black text-white py-3 rounded-lg font-medium hover:opacity-90 disabled:opacity-40"
            >
              {busy ? 'Saving...' : isForced ? 'Set password' : 'Change password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  type,
  value,
  onChange,
  autoComplete,
  hint,
}: {
  label: string;
  type: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete?: string;
  hint?: string;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 uppercase tracking-wider mb-1.5">
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-orange-500"
      />
      {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
    </div>
  );
}
