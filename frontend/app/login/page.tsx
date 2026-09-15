'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import InstallAppButton from '@/components/InstallAppButton';
import { Button } from '@/components/ui/Button';

export default function LoginPage() {
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const apiUrl =
        process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';
      const response = await fetch(`${apiUrl}/auth/login`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, password }),
      });

      if (!response.ok) {
        setError('Invalid email or password');
        setLoading(false);
        return;
      }

      const data = await response.json();

      if (!data.success) {
        setError('Login failed. Please try again.');
        setLoading(false);
        return;
      }

      const landing =
        data?.user?.role === 'UPLOADER' ? '/upload' : '/dashboard';
      router.push(landing);
    } catch (err) {
      setError('Server connection failed');
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen relative flex items-center justify-center p-4 overflow-hidden bg-page">
      {/* Ambient brand glow — subtle radial gradients behind the card
          give the login screen depth without a heavy hero image. */}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            'radial-gradient(60% 40% at 20% 20%, rgba(249,115,22,0.15) 0%, transparent 60%), radial-gradient(50% 40% at 80% 80%, rgba(59,130,246,0.10) 0%, transparent 60%)',
        }}
      />
      <div className="relative bg-surface border border-border shadow-lg rounded-3xl p-8 md:p-10 w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="bg-[color:var(--sidebar)] rounded-2xl p-6 mb-6">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/fusion-logo.png"
              alt="FUSION"
              className="w-full max-w-[220px] mx-auto h-auto"
            />
          </div>

          <h1 className="text-2xl font-semibold text-fg">
            Welcome back
          </h1>
          <p className="text-fg-muted mt-1 text-sm">
            Sign in to the FFG Recon system
          </p>
        </div>

        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-fg-muted mb-1.5">
              Email
            </label>
            <input
              type="email"
              autoComplete="email"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full bg-surface border border-border rounded-lg px-3.5 py-2.5 text-fg placeholder:text-fg-subtle focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/30 transition"
            />
          </div>

          <div>
            <div className="flex items-baseline justify-between mb-1.5">
              <label className="block text-sm font-medium text-fg-muted">
                Password
              </label>
              <Link
                href="/forgot-password"
                className="text-xs text-brand hover:underline"
              >
                Forgot?
              </Link>
            </div>
            <input
              type="password"
              autoComplete="current-password"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-surface border border-border rounded-lg px-3.5 py-2.5 text-fg placeholder:text-fg-subtle focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/30 transition"
            />
          </div>

          {error && (
            <div className="bg-[var(--danger-soft)] border border-[var(--danger)]/30 text-[var(--danger)] text-sm rounded-lg px-3 py-2">
              {error}
            </div>
          )}

          <Button
            type="submit"
            variant="primary"
            size="lg"
            fullWidth
            loading={loading}
          >
            Sign in
          </Button>

          <InstallAppButton />
        </form>
      </div>
    </main>
  );
}
