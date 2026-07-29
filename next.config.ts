import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // playwright is loaded at runtime by lib/webLinkRender.ts (add-weblinks renders JS-only
  // catalog pages that a plain fetch sees as an empty shell). It must stay external: bundling
  // it would drag its browser drivers into the server output and break the dynamic import.
  serverExternalPackages: ['playwright'],
  // Raise the 10MB middleware/proxy body buffer so large price-list Excel
  // uploads reach /api/price-lists/import intact.
  experimental: {
    proxyClientMaxBodySize: '500mb',
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
