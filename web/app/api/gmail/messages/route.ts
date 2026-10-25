import { NextResponse } from 'next/server';
import { GmailError, clearTokens, listInbox, liveTokens } from '@/lib/server/gmail';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const t = await liveTokens();
    if (!t) return NextResponse.json({ letters: [], email: '' });
    const letters = await listInbox(t.access_token);
    return NextResponse.json({ letters, email: t.email });
  } catch (e) {
    if (e instanceof GmailError) {
      if (e.reconnect) await clearTokens();
      return NextResponse.json({ letters: [], email: '', error: e.message, code: e.code }, { status: e.status });
    }
    return NextResponse.json({ letters: [], email: '', error: 'Could not read Gmail.' }, { status: 502 });
  }
}
