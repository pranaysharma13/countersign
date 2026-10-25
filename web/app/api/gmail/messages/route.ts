import { NextResponse } from 'next/server';
import { listInbox, liveTokens } from '@/lib/server/gmail';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const t = await liveTokens();
    if (!t) return NextResponse.json({ letters: [], email: '' });
    const letters = await listInbox(t.access_token);
    return NextResponse.json({ letters, email: t.email });
  } catch (e) {
    return NextResponse.json({ letters: [], email: '', error: e instanceof Error ? e.message : 'gmail_failed' }, { status: 502 });
  }
}
