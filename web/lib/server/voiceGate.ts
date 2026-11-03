import 'server-only';
import { NextResponse } from 'next/server';
import { currentPersona } from './session';

const WINDOW_MS = 60_000;
const hits = new Map<string, number[]>();

function clientKey(req: Request): string {
  const h = req.headers;
  return h.get('x-forwarded-for')?.split(',')[0]?.trim() || h.get('x-real-ip') || 'local';
}

export function rateLimited(req: Request, limit: number): boolean {
  const key = `${clientKey(req)}:${limit}`;
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter(t => now - t < WINDOW_MS);
  if (recent.length >= limit) {
    hits.set(key, recent);
    return true;
  }
  recent.push(now);
  hits.set(key, recent);
  return false;
}

export async function requireStaff(): Promise<NextResponse | null> {
  const { unlocked } = await currentPersona();
  if (!unlocked) return NextResponse.json({ message: 'Enter the demo PIN first' }, { status: 401 });
  return null;
}
