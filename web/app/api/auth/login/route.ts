import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/server/supabase';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const sb = await supabaseServer();
  if (!sb) return NextResponse.json({ message: 'Email login is not configured on this host.' }, { status: 503 });
  const { email, password } = await req.json().catch(() => ({}));
  if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) {
    return NextResponse.json({ message: 'Need an email and a password.' }, { status: 400 });
  }
  const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
  if (error) return NextResponse.json({ message: error.message }, { status: 401 });
  return NextResponse.json({ ok: true });
}
