import { NextResponse } from 'next/server';
import { buildTreasury } from '@/lib/banks';
import { booksGraph } from '@/lib/semantic';
import { readTables } from '@/lib/server/backend';
import { probeNessie } from '@/lib/server/nessie';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const tables = await readTables([
      'invoice', 'invoice_revision', 'supplier', 'hold', 'payee_profile', 'purchase', 'project',
    ]);
    const live = await probeNessie();
    const treasury = buildTreasury(tables, live);
    return NextResponse.json(booksGraph(tables, treasury));
  } catch (e) {
    return NextResponse.json({ message: e instanceof Error ? e.message : 'Could not build the graph' }, { status: 502 });
  }
}
