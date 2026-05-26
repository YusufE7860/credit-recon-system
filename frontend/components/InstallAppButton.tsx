'use client';

import { useEffect, useState } from 'react';

/**
 * "Add to Home Screen" button for the login screen.
 *
 * Platform reality:
 *   - Android Chrome / Edge / Brave / Opera all fire a
 *     `beforeinstallprompt` event we can capture and trigger
 *     programmatically on a click. One-tap install, zero instructions.
 *   - iOS Safari does NOT expose any programmatic install API. The
 *     only way is the user manually tapping Share → Add to Home
 *     Screen. We can't open Share for them — best we can do is show
 *     a clear illustrated instruction sheet.
 *   - Desktop browsers also fire `beforeinstallprompt` but the user
 *     asked specifically for phones, so we hide the button on
 *     viewports wider than a phone.
 *   - When the app is ALREADY installed (running in standalone mode)
 *     we hide the button entirely — installing twice would just
 *     duplicate the home-screen icon.
 *
 * Render contract:
 *   - Returns null on desktop, when already installed, or when there
 *     is genuinely nothing to offer (e.g. Firefox on Android, which
 *     no longer supports add-to-homescreen in stock builds).
 *   - Otherwise renders a single button. iOS users get a modal with
 *     step-by-step instructions; Android users get the native
 *     install prompt.
 */

// The shape of the event the browser fires. Not in TS lib types because
// it's a Chrome extension to the spec, so we type it ourselves.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

type Platform = 'android' | 'ios' | 'desktop' | 'other';

// Cheap platform sniff. We don't need browser detection — just enough
// to choose between the Android install API and the iOS instructions
// modal, and to decide whether the button should show at all.
function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'other';
  const ua = navigator.userAgent;
  // iPadOS 13+ reports as Mac desktop UA. The MaxTouchPoints check is
  // the canonical workaround.
  const isIPad =
    /iPad/.test(ua) ||
    (ua.includes('Mac') && navigator.maxTouchPoints > 1);
  if (/iPhone|iPod/.test(ua) || isIPad) return 'ios';
  if (/Android/.test(ua)) return 'android';
  // Anything else with a touch screen we treat as "other" (not phone) —
  // the button hides itself.
  return 'desktop';
}

// True if we're already running inside an installed PWA.
// `display-mode: standalone` covers Android + desktop Chrome.
// `navigator.standalone` is the iOS Safari-specific equivalent.
function isInstalled(): boolean {
  if (typeof window === 'undefined') return false;
  const standalone =
    window.matchMedia &&
    window.matchMedia('(display-mode: standalone)').matches;
  const iosStandalone =
    (window.navigator as Navigator & { standalone?: boolean })
      .standalone === true;
  return standalone || iosStandalone;
}

export default function InstallAppButton() {
  const [platform, setPlatform] = useState<Platform>('other');
  const [installed, setInstalled] = useState(false);
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [iosHelpOpen, setIosHelpOpen] = useState(false);

  // Detect once on mount — these don't change without a page reload.
  useEffect(() => {
    setPlatform(detectPlatform());
    setInstalled(isInstalled());
  }, []);

  // Capture the install prompt event so we can fire it on click later.
  // Browsers throw away the event if we don't preventDefault, so we
  // do it here even though we're going to use it later.
  useEffect(() => {
    function onBeforeInstall(e: Event) {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    }
    function onInstalled() {
      // Browser dispatches this once the app is installed.
      setInstalled(true);
      setDeferredPrompt(null);
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  // ---------- Render decisions ----------

  // Hide entirely if installed, on desktop, or unknown.
  if (installed) return null;
  if (platform !== 'android' && platform !== 'ios') return null;
  // Android without a prompt event means the browser doesn't support
  // it (e.g. stock Firefox). Don't show a button that won't work.
  if (platform === 'android' && !deferredPrompt) return null;

  async function handleClick() {
    if (platform === 'ios') {
      setIosHelpOpen(true);
      return;
    }
    if (deferredPrompt) {
      try {
        await deferredPrompt.prompt();
        await deferredPrompt.userChoice;
      } catch {
        // User dismissed or the browser rejected — nothing to do.
      } finally {
        // Prompt can only be used once. Clear it either way.
        setDeferredPrompt(null);
      }
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        className="w-full mt-3 flex items-center justify-center gap-2 border-2 border-dashed border-gray-300 text-gray-700 py-3 rounded-lg hover:border-orange-500 hover:text-orange-600 transition"
      >
        <DownloadIcon />
        <span>Add to Home Screen</span>
      </button>

      {/* iOS instructions modal. Only renders for iOS users. */}
      {iosHelpOpen && (
        <div
          className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center z-50 p-4"
          onClick={() => setIosHelpOpen(false)}
        >
          <div
            className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold mb-1">
              Add to Home Screen
            </h3>
            <p className="text-sm text-gray-600 mb-4">
              Apple doesn&apos;t let websites install themselves on
              iPhone — you have to do it from Safari&apos;s Share menu.
              Three taps:
            </p>

            <ol className="space-y-3 text-sm">
              <li className="flex items-start gap-3">
                <Step n={1} />
                <div>
                  Tap the <strong>Share</strong> icon at the bottom of
                  Safari{' '}
                  <span className="inline-block align-middle">
                    <ShareIcon />
                  </span>
                </div>
              </li>
              <li className="flex items-start gap-3">
                <Step n={2} />
                <div>
                  Scroll down and tap <strong>Add to Home Screen</strong>
                </div>
              </li>
              <li className="flex items-start gap-3">
                <Step n={3} />
                <div>
                  Tap <strong>Add</strong> in the top-right corner
                </div>
              </li>
            </ol>

            <p className="text-xs text-gray-500 mt-4">
              You&apos;ll then find FFG Recon on your home screen like
              a normal app. Make sure you&apos;re using Safari — Chrome
              on iPhone doesn&apos;t support this.
            </p>

            <button
              onClick={() => setIosHelpOpen(false)}
              className="w-full mt-5 bg-black text-white py-3 rounded-lg font-medium hover:opacity-90"
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// ---------- Tiny inline icons (avoid pulling an icon lib) ----------

function DownloadIcon() {
  return (
    <svg
      width="20" height="20" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function ShareIcon() {
  // iOS share glyph (rounded square with up-arrow). Approximation.
  return (
    <svg
      width="18" height="18" viewBox="0 0 24 24" fill="none"
      stroke="#0078ff" strokeWidth="2" strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" />
      <polyline points="16 6 12 2 8 6" />
      <line x1="12" y1="2" x2="12" y2="15" />
    </svg>
  );
}

function Step({ n }: { n: number }) {
  return (
    <span className="flex-shrink-0 w-6 h-6 rounded-full bg-orange-500 text-white text-xs font-bold flex items-center justify-center">
      {n}
    </span>
  );
}
