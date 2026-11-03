import { NextResponse } from 'next/server';
import { companyAnswer, deskCaseFrom } from '@/lib/deskCall';
import { rateLimited, requireStaff } from '@/lib/server/voiceGate';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const blocked = await requireStaff();
  if (blocked) return blocked;
  if (rateLimited(req, 20)) return NextResponse.json({ message: 'Too many calls. Wait a minute.' }, { status: 429 });
  const body = await req.json().catch(() => ({}));
  const c = deskCaseFrom({
    invoiceId: String(body.invoiceId ?? ''),
    invoiceNumber: String(body.invoiceNumber ?? ''),
    supplier: String(body.supplier ?? ''),
    contactName: String(body.contactName ?? ''),
    contactPhone: String(body.contactPhone ?? ''),
    holdCode: String(body.holdCode ?? ''),
    extraCents: Number(body.extraCents) || 0,
  });
  if (!c) return NextResponse.json({ message: 'This bill is not a mismatch we call about.' }, { status: 400 });
  const heard = String(body.heard ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
  const turn = Math.max(0, Math.min(8, Number(body.turn) || 0));
  return NextResponse.json(companyAnswer({ ...c, heard, turn }));
}
