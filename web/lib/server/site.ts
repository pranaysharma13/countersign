import 'server-only';

/** Public origin for this deployment. APP_URL wins; then the incoming request; then Vercel. */
export function publicOrigin(req?: Request): string {
  const pinned = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || '').trim().replace(/\/$/, '');
  if (pinned) return pinned;
  if (req) {
    const host = (req.headers.get('x-forwarded-host') || req.headers.get('host') || '').split(',')[0].trim();
    if (host && !host.startsWith('0.0.0.0')) {
      const proto = req.headers.get('x-forwarded-proto')?.split(',')[0].trim()
        || (host.includes('localhost') || host.startsWith('127.') ? 'http' : 'https');
      return `${proto}://${host}`;
    }
  }
  const vercel = (process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || '').trim();
  if (vercel) return vercel.startsWith('http') ? vercel.replace(/\/$/, '') : `https://${vercel}`;
  return 'http://localhost:3001';
}

export function isHttps(req?: Request): boolean {
  const forwarded = req?.headers.get('x-forwarded-proto')?.split(',')[0].trim();
  if (forwarded === 'https') return true;
  if (forwarded === 'http') return false;
  return publicOrigin(req).startsWith('https://');
}

export function cookieBase(req?: Request, extra: { maxAge?: number } = {}) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    secure: isHttps(req),
    ...extra,
  };
}
