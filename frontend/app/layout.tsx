import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { UserProvider } from "@/lib/user-context";

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
      <body className="min-h-full flex flex-col">
        <UserProvider>{children}</UserProvider>
      </body>
    </html>
  );
}
