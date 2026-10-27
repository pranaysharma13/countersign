import { NextRequest, NextResponse } from 'next/server';
import { mode } from '@/lib/server/backend';
import { coreBase } from '@/lib/server/core';
import { GmailError, MESSAGE_ID, clearTokens, fetchRaw, liveTokens } from '@/lib/server/gmail';
import { currentPersona } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

/** Import one Gmail message, only when a person presses Import: fetch it whole (format=raw) and hand it to the
 * Python intake, which records the body and each PDF attachment as documents and queues them for reading.
 * Mail is data: nothing in it is followed or fetched. Importing the same message again records nothing new. */
export async function POST(req: NextRequest) {
  if (!(req.headers.get('content-type') || '').includes('application/json')) {
    return NextResponse.json({ message: 'Send JSON.' }, { status: 415 });
  }
  const { id } = await req.json().catch(() => ({})) as { id?: unknown };
  if (typeof id !== 'string' || !MESSAGE_ID.test(id)) return NextResponse.json({ message: 'Unknown message.' }, { status: 400 });
  if (!(await currentPersona()).unlocked) return NextResponse.json({ message: 'Enter the demo PIN first.' }, { status: 403 });
  if (mode() !== 'live') {
    return NextResponse.json({
      message: 'Import needs live mode: SpacetimeDB, the Python API and worker, and DATA_SOURCE=live in web/.env.local. ' +
        'The offline demo only has the seeded documents.',
    }, { status: 409 });
  }
  let raw: { raw: string; receivedAtIso: string };
  try {
    const t = await liveTokens();
    if (!t) return NextResponse.json({ message: 'Connect Gmail first.' }, { status: 401 });
    raw = await fetchRaw(t.access_token, id);
  } catch (e) {
    if (e instanceof GmailError) {
      if (e.reconnect) await clearTokens();
      return NextResponse.json({ message: e.message, code: e.code }, { status: e.status });
    }
    return NextResponse.json({ message: 'Could not read that message from Gmail.' }, { status: 502 });
  }
  let r: Response;
  try {
    r = await fetch(`${coreBase()}/intake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-countersign-intake': '1' /* header names are case-insensitive; the name is unchanged */ },
      body: JSON.stringify({ source: 'gmail', message_id: id, raw_base64url: raw.raw, received_at_iso: raw.receivedAtIso }),
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json({
      message: "The Clerk API isn't running. Start it: uv run --project core uvicorn countersign.api:app --port 8000",
    }, { status: 502 });
  }
  const body = await r.json().catch(() => ({})) as { detail?: unknown };
  if (!r.ok) {
    const detail = typeof body.detail === 'string' ? body.detail : `HTTP ${r.status}`;
    return NextResponse.json({ message: `Clerk couldn't import it: ${detail}` }, { status: r.status === 503 ? 503 : 502 });
  }
  return NextResponse.json(body);
}
