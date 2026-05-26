'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import InstallAppButton from '@/components/InstallAppButton';

export default function LoginPage() {
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    try {
      // Call the NestJS backend directly. `credentials: 'include'` is the
      // magic flag that tells the browser to accept and store the
      // Set-Cookie header the backend sends back. Without it, the JWT
      // cookie would be dropped on the floor.
      const apiUrl =
        process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';
      const response = await fetch(`${apiUrl}/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          password,
        }),
      });

      if (!response.ok) {
        // Backend returns 401 for bad credentials — caught here.
        setError('Invalid email or password');
        return;
      }

      const data = await response.json();

      if (!data.success) {
        setError('Login failed. Please try again.');
        return;
      }

      // Cookie is now set by the browser. UPLOADERs go straight to the
      // upload page (they have no dashboard); everyone else lands on
      // the dashboard as before.
      const landing =
        data?.user?.role === 'UPLOADER' ? '/upload' : '/dashboard';
      router.push(landing);
    } catch (err) {
      setError('Server connection failed');
    }
  }

  return (
    <main className="min-h-screen bg-black flex items-center justify-center p-4">
      <div className="bg-white shadow-2xl rounded-2xl p-10 w-full max-w-md">

        <div className="mb-8 text-center">
          {/* Brand */}
          <div className="bg-black rounded-xl p-6 mb-6">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/fusion-logo.png"
              alt="FUSION"
              className="w-full max-w-[260px] mx-auto h-auto"
            />
          </div>

          <h1 className="text-2xl font-bold text-gray-900">
            FFG Recon System
          </h1>
          <p className="text-gray-600 mt-1 text-sm">
            Sign in to continue
          </p>
        </div>

        <form onSubmit={handleLogin} className="space-y-5">

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Email
            </label>

            <input
              type="email"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Password
            </label>

            <input
              type="password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
          </div>

          {error && (
            <p className="text-red-500 text-sm">
              {error}
            </p>
          )}

          <button
            type="submit"
            className="w-full bg-black text-white py-3 rounded-lg hover:opacity-90 transition"
          >
            Sign In
          </button>

          <p className="text-sm text-center text-gray-500 pt-2">
            <a
              href="/forgot-password"
              className="hover:text-black hover:underline"
            >
              Forgot password?
            </a>
          </p>

          {/* PWA install button. Self-hides on desktop, on browsers
              that don't support the install flow, and when the app
              is already installed — so on mobile it shows, otherwise
              this slot is empty. */}
          <InstallAppButton />

        </form>
      </div>
    </main>
  );
}