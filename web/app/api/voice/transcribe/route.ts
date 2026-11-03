import { NextResponse } from 'next/server';
import { transcribeFile } from '@/lib/server/cartesia';
import { rateLimited, requireStaff } from '@/lib/server/voiceGate';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(req: Request) {
  const blocked = await requireStaff();
  if (blocked) return blocked;
  if (rateLimited(req, 12)) return NextResponse.json({ message: 'Too many recordings. Wait a minute.' }, { status: 429 });
  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ message: 'Record a reply first' }, { status: 400 });
  }
  const out = await transcribeFile(file);
  if (!out.ok) return NextResponse.json({ message: out.message }, { status: out.status });
  return NextResponse.json({ text: out.text });
}
