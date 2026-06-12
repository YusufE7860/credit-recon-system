'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCurrentUser, type Role } from '@/lib/user-context';

// Three-tab bottom navigation for mobile, modeled on the TRAXIS pattern:
// flat side tabs (Home, Invoices) plus a raised central action (Upload).
// Sits fixed to the viewport bottom and only appears on small screens;
// the desktop sidebar takes over from md+.
//
// Tab visibility:
//   - Home / Dashboard: any role that can see the dashboard. UPLOADERs
//     don't have dashboard access, so for them the "Home" slot links to
//     /upload too (it's their actual home page).
//   - Upload: everyone.
//   - Invoices: everyone.

interface TabDef {
  label: string;
  href: string;
  iconName: 'home' | 'upload' | 'invoices';
}

function getTabs(role: Role | undefined): TabDef[] {
  // UPLOADER landing is /upload — give the Home tab the same target so
  // they don't tap into a 403 page.
  const homeHref = role === 'UPLOADER' ? '/upload' : '/dashboard';
  return [
    { label: 'Home', href: homeHref, iconName: 'home' },
    { label: 'Upload', href: '/upload', iconName: 'upload' },
    { label: 'Invoices', href: '/invoices', iconName: 'invoices' },
  ];
}

export default function MobileBottomNav() {
  const pathname = usePathname();
  const { user } = useCurrentUser();
  // Hide the bar on login/forgot-password screens — they shouldn't
  // appear over an unauthenticated page.
  if (
    pathname.startsWith('/login') ||
    pathname.startsWith('/forgot-password') ||
    pathname.startsWith('/reset-password')
  ) {
    return null;
  }

  const tabs = getTabs(user?.role);

  return (
    <nav
      // Fixed to viewport bottom. The pb-safe utility doesn't exist in
      // base Tailwind so we use env(safe-area-inset-bottom) inline to
      // stay above iPhone's home indicator bar.
      className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-white border-t border-gray-200 shadow-[0_-2px_8px_rgba(0,0,0,0.04)]"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      aria-label="Primary navigation"
    >
      <div className="relative flex items-end justify-around px-2 pt-2 pb-1.5">
        {tabs.map((tab) => {
          const isActive =
            tab.iconName === 'upload'
              ? pathname === '/upload'
              : pathname === tab.href ||
                (tab.href !== '/' && pathname.startsWith(tab.href));
          if (tab.iconName === 'upload') {
            return (
              <Link
                key={tab.iconName}
                href={tab.href}
                aria-label={tab.label}
                // Floating action button — raised above the bar with a
                // negative top margin and a shadow. Dark circle to mimic
                // the TRAXIS reference where the central CTA dominates.
                className="-mt-7 flex flex-col items-center justify-center"
              >
                <span
                  className={`w-14 h-14 rounded-full flex items-center justify-center shadow-lg transition active:scale-95 ${
                    isActive ? 'bg-orange-500 text-white' : 'bg-black text-white'
                  }`}
                >
                  <UploadIcon />
                </span>
                <span className="text-[10px] mt-1 text-gray-600">
                  {tab.label}
                </span>
              </Link>
            );
          }
          return (
            <Link
              key={tab.iconName}
              href={tab.href}
              aria-label={tab.label}
              className="flex-1 flex flex-col items-center justify-center py-1.5 max-w-[110px]"
            >
              <span
                className={`flex items-center justify-center ${isActive ? 'text-orange-600' : 'text-gray-500'}`}
              >
                {tab.iconName === 'home' ? <HomeIcon /> : <InvoicesIcon />}
              </span>
              <span
                className={`text-[11px] mt-0.5 ${isActive ? 'text-orange-600 font-semibold' : 'text-gray-600'}`}
              >
                {tab.label}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

// ---------- Icons ----------

function HomeIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="8" height="10" rx="1" />
      <rect x="13" y="3" width="8" height="8" rx="1" />
      <rect x="13" y="13" width="8" height="8" rx="1" />
      <rect x="3" y="3" width="8" height="6" rx="1" />
    </svg>
  );
}

function UploadIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
      <circle cx="12" cy="13" r="4" />
    </svg>
  );
}

function InvoicesIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11l-2 2 4 4 8-8" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  );
}
