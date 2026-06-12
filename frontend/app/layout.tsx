import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { UserProvider } from "@/lib/user-context";
import MobileTopBar from "@/components/MobileTopBar";
import MobileBottomNav from "@/components/MobileBottomNav";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "FFG Recon System",
  description: "FFG credit card reconciliation and expense management",
  // PWA wiring — manifest defines installable behaviour, the Apple
  // tags exist because iOS Safari ignores the manifest entirely and
  // uses its own legacy meta-tag set.
  manifest: "/manifest.webmanifest",
  applicationName: "FFG Recon",
  appleWebApp: {
    capable: true,
    title: "FFG Recon",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    // iOS picks this one up specifically for the home-screen icon.
    apple: "/apple-touch-icon.png",
    // Keep the original logo around as a small browser favicon.
    shortcut: "/fusion-logo.png",
  },
};

// Theme + viewport — Next 14+ wants these in their own export rather
// than on `metadata`. theme_color matches the sidebar so the browser
// chrome blends in when installed.
export const viewport: Viewport = {
  themeColor: "#000000",
  width: "device-width",
  initialScale: 1,
  // Allow zoom — accessibility. iOS used to default it off, but
  // explicit is clearer for future maintainers.
  maximumScale: 5,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/* Block-layout body. `flex flex-col` was confusing some mobile
          browsers (notably iOS Safari) into treating position:fixed
          children as flex items, which made the bottom nav scroll with
          page content instead of staying pinned to the viewport. Plain
          block layout keeps things straightforward: top bar sticks to
          the top of the scrolling area, content fills below, bottom
          nav is truly fixed to the viewport. */}
      <body className="min-h-full">
        <UserProvider>
          {/* Mobile-only chrome. Both components self-hide on auth
              screens and on md+ breakpoints (where the Sidebar takes
              over). Rendered HERE rather than inside Sidebar so they
              don't end up as flex children alongside page content. */}
          <MobileTopBar />
          {children}
          <MobileBottomNav />
        </UserProvider>
      </body>
    </html>
  );
}
