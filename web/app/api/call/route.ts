import { NextResponse } from 'next/server';
import { callReducer } from '@/lib/server/backend';
import { currentPersona } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

// Reducers the public "sneak a charge" page may call without a staff session.
const PUBLIC_REDUCERS = new Set(['enqueue_job']);

export async function POST(req: Request) {
  const { reducer, args, asPublic } = await req.json();
  const { persona, unlocked } = await currentPersona();
  if (asPublic) {
    if (!PUBLIC_REDUCERS.has(reducer)) return NextResponse.json({ outcome: 'denied', message: 'not available on the public page' });
    return NextResponse.json(await callReducer('public', reducer, args ?? {}));
  }
  if (!unlocked) return NextResponse.json({ outcome: 'denied', message: 'Enter the demo PIN to act as a staff member' });
  try {
    return NextResponse.json(await callReducer(persona, reducer, args ?? {}));
  } catch (e) {
    return NextResponse.json({ outcome: 'error', message: (e as Error).message });
  }
}
