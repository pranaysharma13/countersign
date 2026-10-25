import { NextResponse } from 'next/server';
import { readTables, mode } from '@/lib/server/backend';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const tables = (new URL(req.url).searchParams.get('t') ?? '').split(',').filter(Boolean);
  try {
    return NextResponse.json({ mode: mode(), tables: await readTables(tables) });
  } catch (e) {
    return NextResponse.json({ mode: mode(), error: (e as Error).message }, { status: 502 });
  }
}
