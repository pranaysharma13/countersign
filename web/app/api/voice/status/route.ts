import { NextResponse } from 'next/server';
import { cartesiaKey } from '@/lib/server/cartesia';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ ready: !!cartesiaKey() });
}
