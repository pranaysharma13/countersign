import { NextRequest, NextResponse } from 'next/server';
import { exchangeCode } from '@/lib/server/gmail';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const err = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const expect = req.cookies.get('cs_gmail_state')?.value;
  const back = new URL('/inbox', url.origin);
  if (err) {
    back.searchParams.set('gmail', err);
    return NextResponse.redirect(back);
  }
  if (!code || !state || state !== expect) {
    back.searchParams.set('gmail', 'bad_state');
    return NextResponse.redirect(back);
  }
  try {
    const tokens = await exchangeCode(code);
    const res = NextResponse.redirect(new URL('/inbox?gmail=ok', url.origin));
    res.cookies.set('cs_gmail', JSON.stringify(tokens), {
      httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 14,
    });
    res.cookies.delete('cs_gmail_state');
    return res;
  } catch (e) {
    back.searchParams.set('gmail', e instanceof Error ? e.message : 'token_failed');
    return NextResponse.redirect(back);
  }
}
