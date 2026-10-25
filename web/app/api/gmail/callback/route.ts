import { NextRequest, NextResponse } from 'next/server';
import { GmailError, STATE_COOKIE, TOKEN_COOKIE, cookieOptions, exchangeCode, sameState } from '@/lib/server/gmail';

export const dynamic = 'force-dynamic';

/** Google sends the browser back here. Every outcome clears the one-time state and returns to /inbox with a
 * short code the page explains; tokens go only into the httpOnly cookie. */
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const back = (code: string) => {
    const res = NextResponse.redirect(new URL(`/inbox?gmail=${encodeURIComponent(code)}`, url.origin));
    res.cookies.delete(STATE_COOKIE);
    return res;
  };
  const err = url.searchParams.get('error');
  if (err) return back(err === 'access_denied' ? 'denied' : 'google_error');
  const code = url.searchParams.get('code');
  if (!code || !sameState(req.cookies.get(STATE_COOKIE)?.value, url.searchParams.get('state'))) return back('bad_state');
  try {
    const tokens = await exchangeCode(code);
    const res = back('ok');
    res.cookies.set(TOKEN_COOKIE, JSON.stringify(tokens), cookieOptions(60 * 60 * 24 * 14));
    return res;
  } catch (e) {
    return back(e instanceof GmailError ? e.code : 'token_failed');
  }
}
