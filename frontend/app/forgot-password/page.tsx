'use client';

import { useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/api';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/auth/forgot-password', {
        method: 'POST',
        json: { email },
      });
      // Always show the same success message — the API doesn't tell us
      // whether the email was registered (on purpose).
      setSubmitted(true);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Request failed',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-black flex items-center justify-center p-4">
      <div className="bg-white shadow-2xl rounded-2xl p-10 w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="bg-black rounded-xl p-6 mb-6">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/fusion-logo.png"
              alt="FUSION"
              className="w-full max-w-[200px] mx-auto h-auto"
            />
          </div>
          <h1 className="text-2xl font-bold text-gray-900">
            Forgot password
          </h1>
          <p className="text-gray-600 mt-1 text-sm">
            We&apos;ll email you a link to reset it
          </p>
        </div>

        {submitted ? (
          <div className="space-y-4">
            <div className="bg-green-50 border border-green-200 rounded-lg p-4 text-sm text-green-800">
              If an account exists for <strong>{email}</strong>, we&apos;ve
              sent a password reset link. Check your inbox (and spam folder).
              The link is valid for 1 hour.
            </div>
            <Link
              href="/login"
              className="block text-center text-sm text-gray-600 hover:text-black"
            >
              ← Back to login
            </Link>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Email
              </label>
              <input
                type="email"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full border border-gray-300 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-black"
              />
            </div>

            {error && (
              <p className="text-red-500 text-sm">{error}</p>
            )}

            <button
              type="submit"
              disabled={busy}
              className="w-full bg-black text-white py-3 rounded-lg hover:opacity-90 disabled:opacity-40 transition"
            >
              {busy ? 'Sending...' : 'Send reset link'}
            </button>

            <p className="text-sm text-center text-gray-500">
              <Link href="/login" className="hover:text-black hover:underline">
                ← Back to login
              </Link>
            </p>
          </form>
        )}
      </div>
    </main>
  );
}
