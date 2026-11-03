import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/server/supabase';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const sb = await supabaseServer();
  if (!sb) return NextResponse.json({ message: 'Email login is not configured on this host.' }, { status: 503 });
  const { email, password } = await req.json().catch(() => ({}));
  if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || password.length < 8) {
    return NextResponse.json({ message: 'Need an email and a password of at least 8 characters.' }, { status: 400 });
  }
  const { data, error } = await sb.auth.signUp({ email: email.trim(), password });
  if (error) return NextResponse.json({ message: error.message }, { status: 400 });
  if (!data.session) {
    return NextResponse.json({
      ok: true,
      confirm: true,
      message: 'Supabase wants this address confirmed. Turn off “Confirm email” on the Auth project for a local desk, or open the mail it sent.',
    });
  }
  return NextResponse.json({ ok: true });
}
