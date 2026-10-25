import { NextRequest, NextResponse } from 'next/server';
import { STATE_COOKIE, authUrl, cookieOptions, gmailConfigProblem, gmailRedirect } from '@/lib/server/gmail';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const here = req.nextUrl;
  if (gmailConfigProblem()) return NextResponse.redirect(new URL('/inbox?gmail=config', here.origin));
  // The state cookie must live on the host Google sends the browser back to (localhost vs 127.0.0.1).
  const back = new URL(gmailRedirect());
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || here.host; // what the browser used
  if (host !== back.host && !here.searchParams.has('hop')) {
    return NextResponse.redirect(new URL('/api/gmail/start?hop=1', back.origin));
  }
  const state = crypto.randomUUID();
  const res = NextResponse.redirect(authUrl(state));
  res.cookies.set(STATE_COOKIE, state, cookieOptions(600));
  return res;
}
