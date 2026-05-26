/**
 * Single source of truth for session timing + cookie attributes.
 *
 * The app uses a sliding-window inactivity model:
 *   - Cookie is issued with a SHORT maxAge (default 10 minutes).
 *   - On every authenticated response, an interceptor re-issues the
 *     cookie with a fresh maxAge — so an actively-used session never
 *     expires, but a closed browser invalidates the cookie after the
 *     idle window passes.
 *   - The frontend pings /auth/me every few minutes when the tab is
 *     visible so even an open-but-idle tab stays alive.
 *
 * Tune via env var SESSION_INACTIVITY_MINUTES (defaults to 10).
 */

// Default if SESSION_INACTIVITY_MINUTES isn't set.
const DEFAULT_INACTIVITY_MINUTES = 10;

export function getSessionInactivityMinutes(): number {
  const raw = process.env.SESSION_INACTIVITY_MINUTES;
  if (!raw) return DEFAULT_INACTIVITY_MINUTES;
  const parsed = parseInt(raw, 10);
  // Reject nonsense values rather than silently using a 0-min window
  // (which would log everyone out on every request) or NaN.
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_INACTIVITY_MINUTES;
  }
  return parsed;
}

/**
 * Cookie maxAge in milliseconds — what we hand to res.cookie().
 * Computed every call so a hot-reloaded env var takes effect.
 */
export function getSessionMaxAgeMs(): number {
  return getSessionInactivityMinutes() * 60 * 1000;
}

/**
 * Cookie attributes shared by login, logout, and the sliding refresh.
 * Keeping them in one place means flipping prod/dev behaviour (the
 * secure + sameSite combo) only has to change here.
 *
 * Override via env vars:
 *   - COOKIE_SECURE=false  — for test deployments served over plain
 *     HTTP (e.g. accessing the app via raw public IP before a domain
 *     + HTTPS is set up). Defaults to true in production, false in
 *     development. Flip back to true once you have HTTPS or the
 *     browser will silently drop the auth cookie.
 *   - COOKIE_SAMESITE=lax|strict|none — override the default. 'none'
 *     requires secure=true (browsers reject it otherwise).
 */
export function buildCookieOptions(opts: { maxAgeMs?: number } = {}) {
  const isProd = process.env.NODE_ENV === 'production';

  // secure defaults to true in prod, false in dev; explicit env wins.
  const secureRaw = process.env.COOKIE_SECURE;
  const secure =
    secureRaw === undefined ? isProd : secureRaw.toLowerCase() === 'true';

  // sameSite default mirrors the previous behaviour. 'lax' is the
  // browser default when omitted, which is the safe choice for
  // single-origin apps served over plain HTTP.
  const sameSiteRaw = (process.env.COOKIE_SAMESITE ?? '').toLowerCase();
  const sameSite: 'lax' | 'strict' | 'none' =
    sameSiteRaw === 'lax' || sameSiteRaw === 'strict' || sameSiteRaw === 'none'
      ? sameSiteRaw
      : isProd
      ? 'strict'
      : 'lax';

  return {
    httpOnly: true,
    secure,
    sameSite,
    maxAge: opts.maxAgeMs ?? getSessionMaxAgeMs(),
  };
}
