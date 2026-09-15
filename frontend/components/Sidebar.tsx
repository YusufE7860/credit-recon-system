'use client';

import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { logoutUser } from '@/lib/auth';
import { useCurrentUser, type Role } from '@/lib/user-context';
import NotificationBell from './NotificationBell';
import ThemeToggle from './ui/ThemeToggle';
import { initialsFor } from '@/lib/format';
// MobileTopBar and MobileBottomNav are rendered from the root layout
// (app/layout.tsx) so they sit outside the page's flex row.

interface NavItem {
  label: string;
  href: string;
  roles: Role[];
  icon: React.ReactNode;
}

// Inline icon glyphs — lucide-style, single-colour, currentColor.
const IconDashboard = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></svg>
);
const IconTx = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3l4 4-4 4" /><path d="M21 7H8" /><path d="M7 21l-4-4 4-4" /><path d="M3 17h13" /></svg>
);
const IconInvoice = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" /><path d="M8 13h8M8 17h5" /></svg>
);
const IconUpload = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
);
const IconCards = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="2" /><line x1="2" y1="10" x2="22" y2="10" /></svg>
);
const IconReports = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><path d="M7 15l4-4 3 3 5-6" /></svg>
);
const IconAdmin = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
);
const IconSettings = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c0 .66.4 1.24 1 1.51H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
);

const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard',    href: '/dashboard',       roles: ['USER', 'REPORTING', 'ADMIN'], icon: IconDashboard },
  { label: 'Transactions', href: '/transactions',    roles: ['USER', 'REPORTING', 'ADMIN'], icon: IconTx },
  { label: 'Invoices',     href: '/invoices',        roles: ['USER', 'UPLOADER', 'REPORTING', 'ADMIN'], icon: IconInvoice },
  { label: 'Upload',       href: '/upload',          roles: ['USER', 'UPLOADER', 'REPORTING', 'ADMIN'], icon: IconUpload },
  { label: 'Cards',        href: '/cards',           roles: ['REPORTING', 'ADMIN'], icon: IconCards },
  { label: 'Reports',      href: '/reports',         roles: ['REPORTING', 'ADMIN'], icon: IconReports },
  { label: 'Admin',        href: '/admin',           roles: ['ADMIN'], icon: IconAdmin },
  { label: 'Settings',     href: '/admin/settings',  roles: ['ADMIN'], icon: IconSettings },
];

/**
 * Desktop sidebar. Sticky on the left, always visible.
 * Mobile chrome (top bar + bottom tab) lives in app/layout.tsx.
 */
export default function Sidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const { user, loading } = useCurrentUser();

  async function handleLogout() {
    await logoutUser();
    router.push('/login');
    router.refresh();
  }

  const visibleItems = NAV_ITEMS.filter((item) =>
    user ? item.roles.includes(user.role) : !loading ? false : item.roles.length === 3,
  );

  return (
    <aside
      className="hidden md:flex w-64 flex-col md:sticky md:top-0 md:z-auto md:h-screen text-[color:var(--sidebar-fg)]"
      style={{ background: 'var(--sidebar)' }}
    >
      {/* Brand + notifications */}
      <div className="px-5 pt-6 pb-4 flex-shrink-0">
        <div className="flex justify-between items-start gap-2">
          <Link href="/dashboard" className="block flex-1 min-w-0">
            <Image
              src="/fusion-logo.png"
              alt="FUSION"
              width={200}
              height={50}
              priority
              className="w-full h-auto max-w-[160px]"
            />
            <p className="text-[10px] text-white/50 mt-2 tracking-[0.22em] uppercase">
              FFG Recon
            </p>
          </Link>
          <NotificationBell />
        </div>
      </div>

      {/* Nav */}
      <nav className="px-3 space-y-0.5 flex-1 overflow-y-auto">
        {visibleItems.map((item) => {
          const isActive =
            item.href === '/admin'
              ? pathname === '/admin' || (pathname.startsWith('/admin/') && !pathname.startsWith('/admin/settings'))
              : pathname === item.href ||
                (item.href !== '/' && pathname.startsWith(item.href + '/'));
          return (
            <Link key={item.href} href={item.href} className="block">
              <div
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors ${
                  isActive
                    ? 'bg-white/10 text-white font-medium'
                    : 'text-white/70 hover:bg-white/5 hover:text-white'
                }`}
              >
                <span
                  className={`flex-shrink-0 ${
                    isActive ? 'text-[color:var(--brand)]' : 'text-white/60'
                  }`}
                >
                  {item.icon}
                </span>
                <span className="truncate">{item.label}</span>
                {isActive && (
                  <span className="ml-auto w-1 h-4 rounded-full bg-[color:var(--brand)]" />
                )}
              </div>
            </Link>
          );
        })}
      </nav>

      {/* Bottom: user chip + theme toggle + logout */}
      <div className="px-3 pt-3 pb-4 border-t border-white/10 flex-shrink-0 space-y-2">
        {user && (
          <div className="flex items-center gap-2.5 px-2 py-1.5">
            <span className="w-8 h-8 rounded-full bg-[color:var(--brand)]/90 text-black flex items-center justify-center text-xs font-semibold">
              {initialsFor(user.name)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs text-white truncate">{user.name}</p>
              <p className="text-[10px] text-white/50 uppercase tracking-wider">
                {user.role}
              </p>
            </div>
          </div>
        )}
        <div className="px-2">
          <ThemeToggle />
        </div>
        <button
          onClick={handleLogout}
          className="w-full text-left px-3 py-2 rounded-lg text-sm text-white/70 hover:bg-red-500/15 hover:text-red-300 transition-colors flex items-center gap-3"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <polyline points="16 17 21 12 16 7" />
            <line x1="21" y1="12" x2="9" y2="12" />
          </svg>
          Logout
        </button>
      </div>
    </aside>
  );
}
