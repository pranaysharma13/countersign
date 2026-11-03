import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const here = path.dirname(fileURLToPath(import.meta.url));

const config: NextConfig = {
  // The local demo backend (db/dist/local.mjs) is loaded at runtime by file path, never bundled.
  agentRules: false,
  poweredByHeader: false,
  outputFileTracingRoot: path.join(here, '..'),
  outputFileTracingIncludes: {
    '/api/**/*': [
      './.local-backend/**/*',
      '../db/dist/**/*',
    ],
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Permissions-Policy', value: 'camera=(), geolocation=(), microphone=(self)' },
        ],
      },
    ];
  },
};
export default config;
