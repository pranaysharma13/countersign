import { NextRequest, NextResponse } from 'next/server';
import { coreBase, coreUnavailable } from '@/lib/server/core';

export const dynamic = 'force-dynamic';

/** Proxies the Python API's cited "why?" explanation (read-only: it can't change amounts, holds or approvals). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const base = coreBase();
  if (!base) return NextResponse.json({ message: coreUnavailable('Why') }, { status: 502 });
  const q = new URLSearchParams();
  for (const k of ['line', 'hold']) {
    const v = req.nextUrl.searchParams.get(k);
    if (v) q.set(k, v);
  }
  try {
    const r = await fetch(`${base}/invoices/${encodeURIComponent(id)}/why?${q}`, { cache: 'no-store' });
    const body = await r.json().catch(() => ({ message: 'No explanation available.' }));
    return NextResponse.json(body, { status: r.status });
  } catch {
    return NextResponse.json({ message: coreUnavailable('Why') }, { status: 502 });
  }
}
