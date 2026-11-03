import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/server/supabase';

export const dynamic = 'force-dynamic';

export async function POST() {
  const sb = await supabaseServer();
  if (sb) await sb.auth.signOut();
  return NextResponse.json({ ok: true });
}
