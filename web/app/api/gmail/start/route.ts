import { NextResponse } from 'next/server';
import { authUrl, gmailConfigured } from '@/lib/server/gmail';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (!gmailConfigured()) {
    return NextResponse.json({
      ok: false,
      message: 'Add GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET to web/.env.local, then restart the web app.',
    }, { status: 400 });
  }
  const state = crypto.randomUUID();
  const res = NextResponse.redirect(authUrl(state));
  res.cookies.set('cs_gmail_state', state, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 600 });
  return res;
}
