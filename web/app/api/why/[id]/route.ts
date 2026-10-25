import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

function coreBase(): string {
  return (process.env.NEXT_PUBLIC_CORE_URL || process.env.CORE_URL || 'http://localhost:8000').replace(/\/$/, '');
}

/** Proxies the Python API's cited "why?" explanation (read-only: it can't change amounts, holds or approvals). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const q = new URLSearchParams();
  for (const k of ['line', 'hold']) {
    const v = req.nextUrl.searchParams.get(k);
    if (v) q.set(k, v);
  }
  try {
    const r = await fetch(`${coreBase()}/invoices/${encodeURIComponent(id)}/why?${q}`, { cache: 'no-store' });
    const body = await r.json().catch(() => ({ message: 'No explanation available.' }));
    return NextResponse.json(body, { status: r.status });
  } catch {
    return NextResponse.json({ message: 'The explanation service (the Python API on port 8000) is not running.' }, { status: 502 });
  }
}
