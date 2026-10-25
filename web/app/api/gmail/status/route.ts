import { NextResponse } from 'next/server';
import { gmailConfigured, liveTokens } from '@/lib/server/gmail';

export const dynamic = 'force-dynamic';

export async function GET() {
  if (!gmailConfigured()) {
    return NextResponse.json({ configured: false, connected: false, email: '' });
  }
  try {
    const t = await liveTokens();
    return NextResponse.json({ configured: true, connected: !!t, email: t?.email || '' });
  } catch {
    return NextResponse.json({ configured: true, connected: false, email: '' });
  }
}
