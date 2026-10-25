import { NextResponse } from 'next/server';
import { clearTokens, readTokens } from '@/lib/server/gmail';

export const dynamic = 'force-dynamic';

/** Forget the sign-in here and ask Google to revoke it (best effort: the cookie is cleared either way). */
export async function POST() {
  const t = await readTokens();
  await clearTokens();
  const token = t?.refresh_token || t?.access_token;
  if (token) {
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
      cache: 'no-store',
    }).catch(() => undefined);
  }
  return NextResponse.json({ ok: true });
}
