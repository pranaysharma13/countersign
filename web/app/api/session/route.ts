import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { supabaseConfigured } from '@/lib/authRole';
import { STAFF, mode } from '@/lib/server/backend';
import { currentPersona } from '@/lib/server/session';
import { cookieBase } from '@/lib/server/site';

export const dynamic = 'force-dynamic';

export async function GET() {
  const s = await currentPersona();
  return NextResponse.json({
    ...s,
    mode: mode(),
    pinRequired: !!process.env.DEMO_PIN,
    emailLogin: supabaseConfigured(),
  });
}

export async function POST(req: Request) {
  const { persona, pin, lock } = await req.json();
  const c = await cookies();
  if (lock) {
    c.delete('cs_pin');
    return NextResponse.json({ ok: true, ...(await currentPersona()), mode: mode(), pinRequired: !!process.env.DEMO_PIN, emailLogin: supabaseConfigured() });
  }
  const now = await currentPersona();
  if (now.auth === 'supabase') {
    return NextResponse.json({
      ok: true,
      ...now,
      mode: mode(),
      pinRequired: !!process.env.DEMO_PIN,
      emailLogin: supabaseConfigured(),
    });
  }
  if (typeof persona === 'string' && STAFF.includes(persona as typeof STAFF[number])) {
    c.set('cs_persona', persona, cookieBase(req));
  }
  if (typeof pin === 'string') {
    if (pin !== process.env.DEMO_PIN) return NextResponse.json({ ok: false, message: "That PIN doesn't match" }, { status: 401 });
    c.set('cs_pin', pin, cookieBase(req, { maxAge: 60 * 60 * 12 }));
  }
  return NextResponse.json({ ok: true, ...(await currentPersona()), mode: mode(), pinRequired: !!process.env.DEMO_PIN, emailLogin: supabaseConfigured() });
}
