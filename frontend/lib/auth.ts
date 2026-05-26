/**
 * Auth helpers (client-side).
 *
 * Note: token lives in an httpOnly cookie that JS cannot read.
 * Route protection happens in `middleware.ts` server-side — DO NOT
 * try to check auth status from client code by reading localStorage.
 *
 * The only client-side action needed is logout: tell the backend to
 * clear the cookie, then navigate away.
 */
const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

export async function logoutUser() {
  try {
    await fetch(`${API_URL}/auth/logout`, {
      method: 'POST',
      credentials: 'include', // required so the cookie is sent and can be cleared
    });
  } catch (err) {
    console.error('Logout request failed:', err);
    // Even if the network call fails, we still want to send the user
    // back to the login page below.
  }
}
