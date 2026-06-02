'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';

type Notification = {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  read: boolean;
  createdAt: string;
};

// Poll the unread count every 30s. Cheap query, no socket setup needed.
const POLL_MS = 30_000;

export default function NotificationBell() {
  const router = useRouter();
  const [unreadCount, setUnreadCount] = useState(0);
  const [items, setItems] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement | null>(null);

  // Background poll for unread count.
  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const res = await api<{ count: number }>('/notifications/unread-count');
        if (!cancelled) setUnreadCount(res.count);
      } catch {
        // silently ignore — bell just stays at last known count
      }
    }
    tick();
    const interval = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  // When the dropdown opens, load the full list.
  async function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next) {
      try {
        const list = await api<Notification[]>('/notifications?limit=15');
        setItems(list);
      } catch {
        setItems([]);
      }
    }
  }

  // Click outside to close.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  async function handleClick(n: Notification) {
    try {
      await api(`/notifications/${n.id}/read`, { method: 'POST' });
      setUnreadCount((c) => Math.max(0, c - (n.read ? 0 : 1)));
      setItems((arr) => arr.map((x) => x.id === n.id ? { ...x, read: true } : x));
    } catch { /* ignore */ }
    if (n.link) {
      setOpen(false);
      router.push(n.link);
    }
  }

  async function markAllRead() {
    try {
      await api('/notifications/read-all', { method: 'POST' });
      setUnreadCount(0);
      setItems((arr) => arr.map((x) => ({ ...x, read: true })));
    } catch { /* ignore */ }
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={toggleOpen}
        className="relative p-2 hover:bg-white/10 rounded-lg transition"
        aria-label="Notifications"
      >
        <BellIcon />
        {unreadCount > 0 && (
          <span className="absolute top-0 right-0 bg-orange-500 text-white text-[10px] font-bold rounded-full px-1.5 py-0.5 min-w-[18px] text-center">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        // Responsive positioning:
        //   - Mobile: bell lives in the top-right corner (Sidebar.tsx),
        //     so we drop the panel DOWN-AND-LEFT (right-0 top-full) and
        //     constrain its width to fit a phone viewport.
        //   - Desktop: bell sits inside the sidebar (left of the page),
        //     so we open to the RIGHT of it (left-full top-0) into the
        //     main content area, with the original 320px width.
        <div className="absolute right-0 top-full mt-2 w-[calc(100vw-2rem)] max-w-sm md:right-auto md:left-full md:top-0 md:mt-0 md:ml-2 md:w-80 bg-white text-gray-900 rounded-xl shadow-2xl overflow-hidden z-50 border border-gray-200">
          <div className="flex justify-between items-center px-4 py-3 border-b border-gray-200">
            <p className="font-semibold text-sm">Notifications</p>
            {unreadCount > 0 && (
              <button onClick={markAllRead} className="text-xs text-gray-600 hover:text-black">
                Mark all read
              </button>
            )}
          </div>
          <ul className="max-h-80 overflow-y-auto">
            {items.length === 0 ? (
              <li className="p-6 text-center text-gray-400 text-sm">No notifications</li>
            ) : items.map((n) => (
              <li key={n.id}>
                <button
                  onClick={() => handleClick(n)}
                  className={`w-full text-left p-3 hover:bg-gray-50 border-b border-gray-100 ${n.read ? '' : 'bg-orange-50/50'}`}
                >
                  <div className="flex justify-between items-start gap-2">
                    <p className="text-sm font-medium">{n.title}</p>
                    {!n.read && <span className="w-2 h-2 rounded-full bg-orange-500 flex-shrink-0 mt-1.5" />}
                  </div>
                  <p className="text-xs text-gray-600 mt-1">{n.body}</p>
                  <p className="text-[10px] text-gray-400 mt-1">
                    {new Date(n.createdAt).toLocaleString()}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function BellIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}
