'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { logoutUser } from '@/lib/auth';
import { useCurrentUser, type Role } from '@/lib/user-context';
import NotificationBell from './NotificationBell';
import MobileTopBar from './MobileTopBar';
import MobileBottomNav from './MobileBottomNav';

// Each nav item declares which roles are allowed to see it.
interface NavItem {
  label: string;
  href: string;
  roles: Role[];
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard',    href: '/dashboard',    roles: ['USER', 'REPORTING', 'ADMIN'] },
  { label: 'Transactions', href: '/transactions', roles: ['USER', 'REPORTING', 'ADMIN'] },
  { label: 'Invoices',     href: '/invoices',     roles: ['USER', 'UPLOADER', 'REPORTING', 'ADMIN'] },
  { label: 'Upload',       href: '/upload',       roles: ['USER', 'UPLOADER', 'REPORTING', 'ADMIN'] },
  { label: 'Cards',        href: '/cards',        roles: ['REPORTING', 'ADMIN'] },
  { label: 'Reports',      href: '/reports',      roles: ['REPORTING', 'ADMIN'] },
  { label: 'Admin',        href: '/admin',        roles: ['ADMIN'] },
  { label: 'Settings',     href: '/admin/settings', roles: ['ADMIN'] },
];

/**
 * Responsive sidebar.
 *
 * Desktop (≥ md):  sticky on the left, always visible, 16rem wide.
 * Mobile  (< md):  hidden by default. A floating hamburger button in
 *                  the top-left corner opens the sidebar as a slide-in
 *                  drawer with a backdrop. The notification bell
 *                  appears in the same fixed top bar as the hamburger
 *                  so users don't have to open the drawer to see it.
 */
export default function Sidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const { user, loading } = useCurrentUser();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Auto-close the drawer when the user navigates somewhere.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Body scroll lock while the mobile drawer is open — otherwise the
  // page can scroll behind the overlay, which feels broken.
  useEffect(() => {
    if (mobileOpen) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = prev;
      };
    }
  }, [mobileOpen]);

  async function handleLogout() {
    await logoutUser();
    router.push('/login');
    router.refresh();
  }

  // Filter nav items by role. While the user is still loading we show
  // only the universal items so the sidebar doesn't briefly flash
  // admin links and then collapse.
  const visibleItems = NAV_ITEMS.filter((item) =>
    user ? item.roles.includes(user.role) : !loading ? false : item.roles.length === 3,
  );

  return (
    <>
      {/* Mobile gets a solid top bar (logo + profile chip) and a
          three-tab bottom navigation with a raised central Upload
          button. The previous hamburger drawer is gone — everything
          not on the bottom bar lives in the profile chip dropdown. */}
      <MobileTopBar />
      <MobileBottomNav />

      {/* Desktop sidebar — unchanged from the previous version.
          md:flex makes it visible at and above the md breakpoint;
          on mobile it's hidden entirely now. */}
      <aside
        className="hidden md:flex w-64 bg-black text-white p-6 flex-col md:sticky md:top-0 md:z-auto md:h-screen"
      >
        <div className="mb-10 flex-shrink-0">
          <div className="flex justify-between items-start">
            <Link href="/dashboard" className="block flex-1">
              <Image
                src="/fusion-logo.png"
                alt="FUSION"
                width={200}
                height={50}
                priority
                className="w-full h-auto"
              />
              <p className="text-xs text-gray-400 mt-2 tracking-widest uppercase">
                FFG Recon System
              </p>
            </Link>
            <div>
              <NotificationBell />
            </div>
          </div>
        </div>

        <nav className="space-y-1 flex-1 overflow-y-auto -mr-2 pr-2">
          {visibleItems.map((item) => {
            const isActive = pathname.startsWith(item.href);
            return (
              <Link key={item.href} href={item.href}>
                <div
                  className={`p-3 rounded-lg cursor-pointer transition border-l-2 ${
                    isActive
                      ? 'bg-white/10 font-semibold border-orange-500 text-white'
                      : 'border-transparent hover:bg-white/5 text-gray-200'
                  }`}
                >
                  {item.label}
                </div>
              </Link>
            );
          })}
        </nav>

        {user && (
          <div className="mb-3 pt-3 border-t border-white/10 flex-shrink-0">
            <p className="text-xs text-gray-400 truncate">{user.name}</p>
            <p className="text-[10px] text-gray-500 uppercase tracking-wider">
              {user.role}
            </p>
          </div>
        )}

        <div
          onClick={handleLogout}
          className="hover:bg-red-600/30 p-3 rounded-lg cursor-pointer text-red-300 flex-shrink-0"
        >
          Logout
        </div>
      </aside>
    </>
  );
}

// ---------- Inline icons ----------

function HamburgerIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
