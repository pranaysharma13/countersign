/** Build-time public origin for metadata. Not a secret. */
export function siteUrl(): string {
  const pinned = (process.env.NEXT_PUBLIC_APP_URL || process.env.APP_URL || '').trim().replace(/\/$/, '');
  if (pinned) return pinned;
  const vercel = (process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || '').trim();
  if (vercel) return vercel.startsWith('http') ? vercel.replace(/\/$/, '') : `https://${vercel}`;
  return 'http://localhost:3001';
}
