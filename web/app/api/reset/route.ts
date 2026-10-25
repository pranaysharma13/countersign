import { NextResponse } from 'next/server';
import { resetLocal } from '@/lib/server/backend';
import { currentPersona } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

export async function POST() {
  const { persona, unlocked } = await currentPersona();
  if (!unlocked || persona !== 'owner') return NextResponse.json({ ok: false, message: 'Only the owner can reset the demo' }, { status: 403 });
  const ok = await resetLocal();
  return NextResponse.json({ ok, message: ok ? 'Demo reset' : 'Reset the live server with scripts/reset_demo.py' });
}
