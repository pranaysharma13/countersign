import { NextResponse } from 'next/server';
import { mode } from '@/lib/server/backend';
import { GmailError, gmailConfigProblem, liveTokens } from '@/lib/server/gmail';

export const dynamic = 'force-dynamic';

export async function GET() {
  const problem = gmailConfigProblem();
  const base = { mode: mode(), configured: !problem, problem: problem || '' };
  if (problem) return NextResponse.json({ ...base, connected: false, email: '' });
  try {
    const t = await liveTokens();
    return NextResponse.json({ ...base, connected: !!t, email: t?.email || '' });
  } catch (e) {
    const error = e instanceof GmailError ? e.message : 'Could not check the Gmail connection.';
    return NextResponse.json({ ...base, connected: false, email: '', error });
  }
}
