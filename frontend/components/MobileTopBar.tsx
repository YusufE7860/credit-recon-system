'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { logoutUser } from '@/lib/auth';
import { useCurrentUser, type Role } from '@/lib/user-context';
import NotificationBell from './NotificationBell';

// Solid top bar for mobile, replacing the floating hamburger pattern.
// Holds the brand on the left and a profile chip + notification bell on
// the right. The profile chip opens a dropdown sheet with the rest of
// the navigation (anything not covered by the 3-tab bottom bar):
// Transactions, Cards, Reports, Admin, Settings, plus Logout.
//
// Hidden on md+ — the desktop sidebar covers those screens.

interface MenuEntry {
  label: string;
  href: string;
  roles: Role[];
}

// Everything NOT in the bottom tab bar (Home/Upload/Invoices) goes here.
const MENU_ENTRIES: MenuEntry[] = [
  { label: 'Transactions', href: '/transactions', roles: ['USER', 'REPORTING', 'ADMIN'] },
  { label: 'Cards', href: '/cards', roles: ['REPORTING', 'ADMIN'] },
  { label: 'Reports', href: '/reports', roles: ['REPORTING', 'ADMIN'] },
  { label: 'Admin', href: '/admin', roles: ['ADMIN'] },
  { label: 'Settings', href: '/admin/settings', roles: ['ADMIN'] },
];

function initialsFor(name: string | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function MobileTopBar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, loading } = useCurrentUser();
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Close the profile dropdown when the user navigates somewhere.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  // Close on outside-click. Touch-friendly: listens on mousedown so the
  // close fires before any click on the underlying element.
  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  // Hide on auth screens — they're full-bleed and shouldn't show the
  // app chrome at all.
  if (
    pathname.startsWith('/login') ||
    pathname.startsWith('/forgot-password') ||
    pathname.startsWith('/reset-password')
  ) {
    return null;
  }

  async function handleLogout() {
    await logoutUser();
    router.push('/login');
    router.refresh();
  }

  const visibleEntries = MENU_ENTRIES.filter((e) =>
    user ? e.roles.includes(user.role) : !loading ? false : false,
  );

  return (
    <header
      className="md:hidden sticky top-0 z-30 bg-white border-b border-gray-200"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      <div className="flex items-center justify-between px-4 py-2.5">
        <Link href={user?.role === 'UPLOADER' ? '/upload' : '/dashboard'} className="flex items-center">
          <Image
            src="/fusion-logo.png"
            alt="FUSION"
            width={120}
            height={28}
            priority
            className="h-7 w-auto"
          />
        </Link>

        <div ref={wrapperRef} className="flex items-center gap-2">
          {/* Notifications stay outside the profile menu — they're the
              most common quick-glance and a separate icon makes the
              unread count instantly visible. */}
          <NotificationBell />

          {/* Profile chip — tap to open the dropdown. Shows the user's
              initials inside a coloured circle plus a chevron. */}
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="flex items-center gap-1.5 pl-0.5 pr-2 py-0.5 rounded-full border border-gray-200 active:bg-gray-50"
            aria-label="Open profile menu"
            aria-expanded={menuOpen}
          >
            <span className="w-8 h-8 rounded-full bg-orange-500 text-white flex items-center justify-center text-xs font-semibold">
              {initialsFor(user?.name)}
            </span>
            <ChevronDown />
          </button>

          {menuOpen && (
            <div className="absolute right-3 top-full mt-1 w-60 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden">
              {user && (
                <div className="px-3 py-2.5 border-b border-gray-100">
                  <p className="text-xs text-gray-500">Signed in as</p>
                  <p className="text-sm font-semibold truncate">{user.name}</p>
                  <p className="text-[11px] text-gray-500 uppercase tracking-wider mt-0.5">
                    {user.role}
                  </p>
                </div>
              )}
              <ul className="py-1">
                {visibleEntries.map((e) => (
                  <li key={e.href}>
                    <Link
                      href={e.href}
                      className="block px-3 py-2 text-sm text-gray-800 hover:bg-gray-50"
                    >
                      {e.label}
                    </Link>
                  </li>
                ))}
              </ul>
              <button
                onClick={handleLogout}
                className="w-full text-left px-3 py-2 text-sm text-red-600 hover:bg-red-50 border-t border-gray-100"
              >
                Logout
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

function ChevronDown() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-gray-500"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}
