import { NextResponse } from 'next/server';
import { coreBase, coreUnavailable } from '@/lib/server/core';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id) return NextResponse.json({ message: 'missing invoice' }, { status: 400 });
  const base = coreBase();
  if (!base) return NextResponse.json({ message: coreUnavailable('Audit download') }, { status: 404 });
  try {
    const r = await fetch(`${base}/invoices/${encodeURIComponent(id)}/audit?format=csv`, { cache: 'no-store' });
    if (!r.ok) return NextResponse.json({ message: 'Audit is not available.' }, { status: r.status });
    return new NextResponse(await r.arrayBuffer(), {
      headers: {
        'Content-Type': r.headers.get('content-type') || 'text/csv',
        'Content-Disposition': r.headers.get('content-disposition') || `attachment; filename="${id}-audit.csv"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch {
    return NextResponse.json({ message: coreUnavailable('Audit download') }, { status: 502 });
  }
}
