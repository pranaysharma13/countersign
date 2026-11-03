import { NextRequest, NextResponse } from 'next/server';
import { coreBase, coreUnavailable } from '@/lib/server/core';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!id) return NextResponse.json({ message: 'missing file' }, { status: 400 });
  const base = coreBase();
  if (!base) return NextResponse.json({ message: coreUnavailable('Document preview') }, { status: 404 });
  const name = req.nextUrl.searchParams.get('name') || '';
  const tries = [`${base}/files/${encodeURIComponent(id)}`];
  if (name) tries.push(`${base}/files/${encodeURIComponent(id)}?name=${encodeURIComponent(name)}`);
  for (const url of tries) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) continue;
      const buf = await r.arrayBuffer();
      const type = r.headers.get('content-type') || 'application/pdf';
      return new NextResponse(buf, {
        headers: {
          'Content-Type': type,
          'Content-Disposition': r.headers.get('content-disposition') || 'inline',
          'Cache-Control': 'private, max-age=60',
        },
      });
    } catch {
      continue;
    }
  }
  return NextResponse.json({ message: 'Document is not available.' }, { status: 404 });
}
