import { NextResponse } from 'next/server';
import { buildTreasury } from '@/lib/banks';
import { readTables } from '@/lib/server/backend';
import { probeNessie } from '@/lib/server/nessie';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [tables, live] = await Promise.all([
      readTables(['invoice', 'invoice_revision', 'supplier', 'hold', 'payee_profile']),
      probeNessie(),
    ]);
    const treasury = buildTreasury(tables, live);
    return NextResponse.json({ treasury, nessie: { source: live.source, reason: live.reason ?? null } });
  } catch (e) {
    return NextResponse.json({ message: e instanceof Error ? e.message : 'Could not read the bank book' }, { status: 502 });
  }
}
