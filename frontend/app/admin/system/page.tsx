'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Sidebar from '@/components/Sidebar';
import { api, ApiError } from '@/lib/api';
import { useCurrentUser } from '@/lib/user-context';

type VersionInfo = {
  currentSha: string | null;
  currentShortSha: string | null;
  currentCommitMessage: string | null;
  currentCommitDate: string | null;
  remoteSha: string | null;
  remoteShortSha: string | null;
  remoteCommitMessage: string | null;
  remoteCommitDate: string | null;
  updateAvailable: boolean;
};

type UpdateStatus = {
  running: boolean;
  logTail: string[];
  logTruncated: boolean;
};

export default function SystemUpdatePage() {
  const { user } = useCurrentUser();
  const isAdmin = user?.role === 'ADMIN';

  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [loadingVersion, setLoadingVersion] = useState(true);
  const [checking, setChecking] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  // Auto-poll while an update is running. The interval ref lets us
  // clear it when running flips back to false (or the page unmounts).
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function loadVersion(check = false) {
    if (check) setChecking(true);
    else setLoadingVersion(true);
    try {
      const data = await api<VersionInfo>(
        `/system/version${check ? '?check=true' : ''}`,
      );
      setVersion(data);
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : 'Failed to load version',
      );
    } finally {
      if (check) setChecking(false);
      else setLoadingVersion(false);
    }
  }

  async function loadStatus() {
    try {
      const data = await api<UpdateStatus>('/system/update/status');
      setStatus(data);
      // If the update finished, re-fetch the version (without the
      // remote check) so the UI flips to the new SHA. The poll keeps
      // running for a couple cycles after running=false so the user
      // sees the final log lines and the "Update complete" banner.
      if (!data.running && pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
        // Give the API a few seconds to restart before re-reading
        // version. If we hit it too fast we get a 502 from Nginx
        // and the page shows an error spuriously.
        setTimeout(() => loadVersion(false), 6000);
      }
    } catch {
      // Don't surface poll errors as UI errors — the API may be
      // restarting (which causes /status to fail momentarily).
    }
  }

  function startPolling() {
    if (pollRef.current) return;
    pollRef.current = setInterval(loadStatus, 3000);
  }

  async function triggerUpdate() {
    if (
      !confirm(
        'Pull the latest version from GitHub and reinstall? The app may be unavailable for ~1 minute while it rebuilds.',
      )
    ) {
      return;
    }
    setUpdating(true);
    setError('');
    setMessage('');
    try {
      const data = await api<{ started: boolean; reason?: string }>(
        '/system/update',
        { method: 'POST' },
      );
      if (!data.started) {
        setError(data.reason ?? 'Update could not be started.');
        setUpdating(false);
        return;
      }
      setMessage('Update started. The app will reload when it finishes.');
      // Pull initial status and start polling.
      await loadStatus();
      startPolling();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to start update');
    } finally {
      setUpdating(false);
    }
  }

  useEffect(() => {
    if (!isAdmin) return;
    loadVersion(false);
    loadStatus();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin]);

  // If a status load reveals an in-progress update, auto-start
  // polling — happens when the admin reloads the page mid-update.
  useEffect(() => {
    if (status?.running) startPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.running]);

  if (!isAdmin) {
    return (
      <div className="flex h-screen">
        <Sidebar />
        <main className="flex-1 p-8">
          <div className="bg-red-50 text-red-800 p-6 rounded-xl">
            This page is admin-only.
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-gray-50">
      <Sidebar />
      <main className="flex-1 overflow-y-auto p-4 md:p-8">
        <div className="max-w-3xl mx-auto">
          <div className="flex items-center gap-3 mb-2">
            <Link href="/admin" className="text-sm text-orange-600 hover:underline">
              ← Admin
            </Link>
          </div>
          <h1 className="text-2xl md:text-3xl font-bold mb-1">System update</h1>
          <p className="text-sm text-gray-600 mb-6">
            Pull the latest release from GitHub and rebuild — without SSH-ing
            to the server.
          </p>

          {error && (
            <div className="bg-red-50 text-red-800 p-3 rounded-lg text-sm mb-4">
              {error}
            </div>
          )}
          {message && (
            <div className="bg-blue-50 text-blue-800 p-3 rounded-lg text-sm mb-4">
              {message}
            </div>
          )}

          {/* Version card */}
          <section className="bg-white rounded-xl shadow p-6 mb-6">
            <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wider mb-4">
              Installed version
            </h2>
            {loadingVersion ? (
              <p className="text-sm text-gray-500">Loading...</p>
            ) : version?.currentSha ? (
              <div className="space-y-1 text-sm">
                <p>
                  <span className="text-gray-500">Commit:</span>{' '}
                  <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">
                    {version.currentShortSha}
                  </code>{' '}
                  <span className="text-gray-700">
                    {version.currentCommitMessage}
                  </span>
                </p>
                {version.currentCommitDate && (
                  <p className="text-xs text-gray-500">
                    Deployed{' '}
                    {new Date(version.currentCommitDate).toLocaleString()}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-orange-700">
                Couldn't read git information from the install. Is /opt/recon
                a git checkout?
              </p>
            )}

            <div className="mt-4 flex gap-2 flex-wrap">
              <button
                onClick={() => loadVersion(true)}
                disabled={checking || status?.running}
                className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-40"
              >
                {checking ? 'Checking GitHub...' : 'Check for updates'}
              </button>
            </div>

            {/* Remote info shown after a "check" */}
            {version?.remoteSha && (
              <div className="mt-4 p-4 rounded-lg border border-dashed border-gray-200">
                <p className="text-xs text-gray-500 uppercase tracking-wider mb-2">
                  Latest on GitHub
                </p>
                <p className="text-sm">
                  <code className="bg-gray-100 px-1.5 py-0.5 rounded text-xs">
                    {version.remoteShortSha}
                  </code>{' '}
                  <span className="text-gray-700">
                    {version.remoteCommitMessage}
                  </span>
                </p>
                {version.remoteCommitDate && (
                  <p className="text-xs text-gray-500 mt-1">
                    Pushed{' '}
                    {new Date(version.remoteCommitDate).toLocaleString()}
                  </p>
                )}
                {version.updateAvailable ? (
                  <p className="text-sm text-orange-700 mt-3 font-medium">
                    Update available.
                  </p>
                ) : (
                  <p className="text-sm text-green-700 mt-3">
                    You're on the latest version.
                  </p>
                )}
              </div>
            )}
          </section>

          {/* Update trigger */}
          <section className="bg-white rounded-xl shadow p-6 mb-6">
            <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wider mb-3">
              Install latest
            </h2>
            <p className="text-sm text-gray-600 mb-4">
              Runs <code className="bg-gray-100 px-1 rounded text-xs">git pull</code>,
              installs new dependencies, applies database changes, rebuilds the
              backend + frontend, and restarts. Takes about 2–5 minutes.
            </p>
            <button
              onClick={triggerUpdate}
              disabled={updating || status?.running}
              className="px-4 py-2 text-sm bg-black text-white rounded-lg hover:opacity-90 disabled:opacity-40"
            >
              {status?.running
                ? 'Update in progress...'
                : updating
                ? 'Starting...'
                : 'Update now'}
            </button>
          </section>

          {/* Log tail — shown whenever a log exists (running or finished) */}
          {status && (status.running || status.logTail.length > 0) && (
            <section className="bg-white rounded-xl shadow p-6 mb-6">
              <h2 className="text-sm font-semibold text-gray-600 uppercase tracking-wider mb-3">
                {status.running ? 'Update progress' : 'Last update log'}
              </h2>
              <pre className="bg-gray-900 text-green-200 text-xs font-mono p-3 rounded-lg max-h-96 overflow-auto whitespace-pre-wrap">
                {status.logTruncated && '... (log truncated to last 64KB) ...\n'}
                {status.logTail.join('\n')}
              </pre>
              {status.running && (
                <p className="text-xs text-gray-500 mt-2">
                  Refreshing every 3s. The page will reload version info
                  automatically when the update finishes.
                </p>
              )}
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
