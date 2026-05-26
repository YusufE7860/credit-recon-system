import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Suppresses the Next.js dev indicator badge that appears at the
  // bottom-left in development mode.
  devIndicators: false,

  // Carry over the API proxy that used to live in next.config.js.
  // Not actively used right now (the frontend calls the backend
  // directly via NEXT_PUBLIC_API_URL) but kept for cases where a
  // /api/* request shows up.
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://localhost:3000/:path*',
      },
    ];
  },
};

export default nextConfig;
