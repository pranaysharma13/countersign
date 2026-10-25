import { NextResponse } from 'next/server';
import { clearTokens } from '@/lib/server/gmail';

export const dynamic = 'force-dynamic';

export async function POST() {
  await clearTokens();
  return NextResponse.json({ ok: true });
}
