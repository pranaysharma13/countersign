import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { STAFF, mode } from '@/lib/server/backend';
import { currentPersona } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

export async function GET() {
  const s = await currentPersona();
  return NextResponse.json({ ...s, mode: mode(), pinRequired: !!process.env.DEMO_PIN });
}

export async function POST(req: Request) {
  const { persona, pin } = await req.json();
  const c = await cookies();
  if (persona && STAFF.includes(persona)) c.set('cs_persona', persona, { httpOnly: true, sameSite: 'lax', path: '/' });
  if (typeof pin === 'string') {
    if (pin !== process.env.DEMO_PIN) return NextResponse.json({ ok: false, message: "That PIN doesn't match" }, { status: 401 });
    c.set('cs_pin', pin, { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 });
  }
  return NextResponse.json({ ok: true, ...(await currentPersona()) });
}
