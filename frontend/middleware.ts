import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { jwtVerify } from 'jose';

// Read the JWT secret from frontend/.env.local. This MUST match the
// backend's JWT_SECRET — otherwise verification fails and every user
// gets bounced to /login.
const JWT_SECRET_RAW = process.env.JWT_SECRET;

if (!JWT_SECRET_RAW) {
  // Throwing here means the middleware bundle fails to build, which is
  // exactly what we want — better than running insecurely.
  throw new Error(
    'JWT_SECRET is not set. Add it to frontend/.env.local',
  );
}

// jose's jwtVerify wants the secret as a Uint8Array, not a string.
const JWT_SECRET = new TextEncoder().encode(JWT_SECRET_RAW);

export async function middleware(request: NextRequest) {
  const token = request.cookies.get('token')?.value;

  const isAuthPage = request.nextUrl.pathname === '/login';

  // If no token → block access
  if (!token && !isAuthPage) {
    return NextResponse.redirect(new URL('/login', request.url));
  }

  // If token exists → verify it
  if (token) {
    try {
      await jwtVerify(token, JWT_SECRET);
    } catch (err) {
      // ❌ invalid or expired token → force logout
      const response = NextResponse.redirect(
        new URL('/login', request.url)
      );

      response.cookies.set('token', '', { maxAge: 0 });
      return response;
    }
  }

  // If logged in and trying login page → redirect dashboard
  if (token && isAuthPage) {
    return NextResponse.redirect(new URL('/dashboard', request.url));
  }

  return NextResponse.next();
}

// Apply middleware to protected routes.
// Note: '/' is included so the root redirect is also auth-gated —
// otherwise an unauthenticated user would briefly load the root page
// before being redirected.
export const config = {
  matcher: [
    '/',
    '/dashboard/:path*',
    '/transactions/:path*',
    '/invoices/:path*',
    '/upload/:path*',
    '/cards/:path*',
    '/reports/:path*',
    '/admin/:path*',
    '/users/:path*',
  ],
};