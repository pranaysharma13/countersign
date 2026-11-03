import { NextRequest, NextResponse } from 'next/server';
import { readTables } from '@/lib/server/backend';
import { proofGraph } from '@/lib/proof';
import { billTrust, trustDesk } from '@/lib/trust';

export const dynamic = 'force-dynamic';

const TABLES = [
  'invoice', 'invoice_revision', 'invoice_line', 'assessment', 'hold', 'supplier', 'supplier_contact',
  'purchase', 'document', 'source_fragment', 'email_message', 'outbox', 'audit_log', 'receipt_attestation',
  'change_request', 'proposal', 'settlement_decision', 'job', 'payee_profile', 'payment', 'ledger_line',
  'request_result', 'extraction_run', 'term', 'payment_approval',
];

export async function GET(req: NextRequest) {
  const t = await readTables(TABLES);
  const id = req.nextUrl.searchParams.get('id');
  if (id) {
    const inv = (t.invoice ?? []).find(i => String(i.id) === id);
    if (!inv) return NextResponse.json({ message: 'No bill' }, { status: 404 });
    const trust = billTrust(t, inv);
    return NextResponse.json({ proof: trust.proof, trust, graph: proofGraph(trust.proof) });
  }
  const desk = trustDesk(t);
  return NextResponse.json({
    watchPass: desk.watchPass,
    watchScored: desk.watchScored,
    packsClean: desk.packsClean,
    conflicts: desk.conflicts,
    lessons: desk.lessons,
    autoPaid: desk.autoPaid,
    writesOnce: desk.writesOnce,
    guessed: desk.guessed,
    fieldsOk: desk.fieldsOk,
    fieldsScored: desk.fieldsScored,
    pipes: desk.pipes.map(p => ({ id: p.id, name: p.name, n: p.n, ok: p.ok })),
    sandboxUntouched: desk.sandboxUntouched,
    bills: desk.bills.map(b => ({
      id: b.proof.invoiceId, number: b.proof.invoiceNumber, supplier: b.proof.supplier, story: b.proof.story, href: b.proof.href,
      watch: b.watch.pass, leaked: b.pack.leaked,
    })),
  });
}
