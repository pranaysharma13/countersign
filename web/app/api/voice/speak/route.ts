import { NextResponse } from 'next/server';
import { CLERK_VOICE, CONTACT_VOICE, speakBytes } from '@/lib/server/cartesia';
import { rateLimited, requireStaff } from '@/lib/server/voiceGate';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(req: Request) {
  const blocked = await requireStaff();
  if (blocked) return blocked;
  if (rateLimited(req, 24)) return NextResponse.json({ message: 'Too many spoken lines. Wait a minute.' }, { status: 429 });
  const body = await req.json().catch(() => ({}));
  const transcript = String(body.transcript ?? '');
  const voice = body.voice === 'contact' ? CONTACT_VOICE : CLERK_VOICE;
  const out = await speakBytes(transcript, voice);
  if (!out.ok) return NextResponse.json({ message: out.message }, { status: out.status });
  return new NextResponse(out.body, {
    headers: { 'Content-Type': out.type, 'Cache-Control': 'no-store' },
  });
}
