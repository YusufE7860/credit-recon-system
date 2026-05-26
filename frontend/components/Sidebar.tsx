'use client';

import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
import Image from 'next/image';
import { logoutUser } from '@/lib/auth';
import { useCurrentUser, type Role } from '@/lib/user-context';
import NotificationBell from './NotificationBell';

// Each nav item declares which roles are allowed to see it.
// `null` in `roles` would mean "everyone" — we use explicit lists for clarity.
interface NavItem {
  label: string;
  href: string;
  roles: Role[];
}

const NAV_ITEMS: NavItem[] = [
  // UPLOADERs don't get a Dashboard — that page shows monetary totals
  // (month spend, overdue amounts, etc.) which they explicitly must
  // not see. They jump straight to the Upload page on login.
  { label: 'Dashboard',    href: '/dashboard',    roles: ['USER', 'REPORTING', 'ADMIN'] },
  // Transactions = the bank-statement feed (debits + amounts). Hidden
  // from UPLOADERs because they shouldn't see card balances at all.
  { label: 'Transactions', href: '/transactions', roles: ['USER', 'REPORTING', 'ADMIN'] },
  // Invoices: UPLOADER sees this BUT the page itself filters to only
  // invoices they uploaded and hides totals (handled in invoices/page).
  { label: 'Invoices',     href: '/invoices',     roles: ['USER', 'UPLOADER', 'REPORTING', 'ADMIN'] },
  { label: 'Upload',       href: '/upload',       roles: ['USER', 'UPLOADER', 'REPORTING', 'ADMIN'] },
  // Cards: managed by privileged users only — plain employees don't
  // need to see the company-wide card directory.
  { label: 'Cards',        href: '/cards',        roles: ['REPORTING', 'ADMIN'] },
  { label: 'Reports',      href: '/reports',      roles: ['REPORTING', 'ADMIN'] },
  { label: 'Admin',        href: '/admin',        roles: ['ADMIN'] },
  // Stub destination — page content arrives in step 33.
  { label: 'Settings',     href: '/admin/settings', roles: ['ADMIN'] },
];

export default function Sidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const { user, loading } = useCurrentUser();

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
    // sticky top-0 + h-screen pins the sidebar to the viewport so it
    // doesn't grow with the page. The nav scrolls internally if it
    // ever overflows, leaving the logout button anchored at the bottom
    // of the visible sidebar regardless of page scroll.
    <aside className="w-64 bg-black text-white sticky top-0 h-screen p-6 flex flex-col">
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
          <NotificationBell />
        </div>
      </div>

      {/* overflow-y-auto so a future longer nav scrolls inside the nav
          region instead of pushing the logout button off-screen. */}
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

      {/* Tiny "Logged in as" footer so users can sanity-check their role */}
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
  );
}
