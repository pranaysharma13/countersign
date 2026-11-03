import type { Row, Tables } from './client';
import {
  HOLD_LABEL, ROLE_LABEL, assessmentLines, billStory, ids, isSandbox, money, nextStep, parse, safeReason,
} from './format.ts';

const KIND: Record<string, string> = {
  quote: 'Quote', po: 'Purchase order', invoice: 'This bill', email: 'Mail', terms: 'Terms', other: 'File',
};

const MONEY_HOLD = new Set(['PRICE_VARIANCE', 'PROPOSED_CHARGE', 'USAGE_EVIDENCE_MISSING', 'PO_CEILING']);

export interface PackDoc {
  id: string;
  kind: string;
  label: string;
}

export interface GuardHold {
  code: string;
  label: string;
  cents: number;
}

export interface TapeRow {
  fact: string;
  from: string;
}

export interface Lesson {
  who: string;
  taught: string;
  nextTime: string;
}

export interface RunJob {
  kind: string;
  status: string;
  note: string;
}

export interface BillProof {
  invoiceId: string;
  invoiceNumber: string;
  supplier: string;
  supplierId: string;
  story: string;
  href: string;
  pack: {
    docs: PackDoc[];
    otherSuppliers: number;
    leaked: boolean;
    fingerprint: string;
  };
  guards: {
    claimedCents: number;
    authorisedCents: number;
    pendingCents: number;
    holds: GuardHold[];
    denials: string[];
    guessed: boolean;
  };
  tape: TapeRow[];
  lessons: Lesson[];
  jobs: RunJob[];
  write: {
    leaving: string;
    requestIds: number;
    duplicates: number;
    journals: number;
    paid: boolean;
    simulated: boolean;
  };
}

export interface ProofDesk {
  bills: BillProof[];
  packsClean: number;
  stopsHeld: number;
  writesOnce: number;
  lessons: number;
  denials: number;
  sandboxUntouched: boolean;
}

function docsOfSupplier(t: Tables, supplierId: string): { ids: Set<string>; kinds: Map<string, string> } {
  const ids = new Set<string>();
  const kinds = new Map<string, string>();
  const mark = (id: unknown, kind: string) => {
    const s = String(id || '');
    if (!s) return;
    ids.add(s);
    kinds.set(s, kind);
  };
  for (const p of t.purchase ?? []) {
    if (p.supplier_id !== supplierId) continue;
    mark(p.quote_document_id, 'quote');
    mark(p.po_document_id, 'po');
  }
  for (const inv of t.invoice ?? []) {
    if (inv.supplier_id !== supplierId) continue;
    for (const r of (t.invoice_revision ?? []).filter(x => x.invoice_id === inv.id)) mark(r.document_id, 'invoice');
  }
  const domain = String((t.supplier ?? []).find(s => s.id === supplierId)?.email_domain || '').toLowerCase();
  const mails = new Set((t.supplier_contact ?? []).filter(c => c.supplier_id === supplierId).map(c => String(c.email || '').toLowerCase()));
  for (const m of t.email_message ?? []) {
    const from = String(m.from_address || '').toLowerCase();
    const to = String(m.to_addresses || '').toLowerCase();
    const ours = (domain && (from.endsWith(`@${domain}`) || to.includes(`@${domain}`)))
      || [...mails].some(a => a && (from === a || to.includes(a)));
    if (ours) mark(m.document_id, 'email');
  }
  for (const d of t.document ?? []) {
    if (ids.has(String(d.id))) kinds.set(String(d.id), String(d.kind || kinds.get(String(d.id)) || 'other'));
  }
  return { ids, kinds };
}

function otherSupplierCount(t: Tables, supplierId: string): number {
  return new Set((t.invoice ?? []).filter(i => i.supplier_id !== supplierId && !isSandbox(i)).map(i => String(i.supplier_id))).size;
}

function citedFragments(t: Tables, assessment?: Row): string[] {
  if (!assessment) return [];
  const fromLines = assessmentLines(String(assessment.details_json || '')).flatMap(l => l.fragment_ids);
  const extra = ids(assessment.details_json);
  return [...new Set([...fromLines, ...extra])];
}

function filenameOf(t: Tables, docId: string): string {
  const d = (t.document ?? []).find(x => x.id === docId);
  return String(d?.filename || KIND[String(d?.kind)] || 'File');
}

export function billProof(t: Tables, inv: Row): BillProof {
  const supplierId = String(inv.supplier_id);
  const sup = (t.supplier ?? []).find(s => s.id === supplierId);
  const revs = (t.invoice_revision ?? []).filter(r => r.invoice_id === inv.id);
  const rev = revs.find(r => r.id === inv.active_revision_id) ?? revs[0];
  const holds = (t.hold ?? []).filter(h => h.revision_id === rev?.id && h.status === 'open');
  const assessment = (t.assessment ?? []).filter(a => a.revision_id === rev?.id).sort((a, b) => Number(b.version) - Number(a.version))[0];
  const pack = docsOfSupplier(t, supplierId);
  const cited = citedFragments(t, assessment);
  const leaked = cited.some(fid => {
    const frag = (t.source_fragment ?? []).find(f => f.id === fid);
    const docId = String(frag?.document_id || '');
    return docId && !pack.ids.has(docId);
  });
  const docs: PackDoc[] = [...pack.ids].map(id => ({
    id,
    kind: pack.kinds.get(id) || 'other',
    label: `${KIND[pack.kinds.get(id) || ''] ?? 'File'} · ${filenameOf(t, id)}`,
  })).sort((a, b) => a.kind.localeCompare(b.kind));

  const claimed = Number(assessment?.claimed_cents ?? rev?.balance_requested_cents) || 0;
  const authorised = Number(assessment?.authorised_cents) || 0;
  const pending = Number(assessment?.pending_cents) || 0;
  const related = new Set<string>([
    String(inv.id), `wi_${inv.id}`, ...revs.map(r => String(r.id)),
    ...(t.hold ?? []).filter(h => revs.some(r => r.id === h.revision_id)).map(h => String(h.id)),
    ...(t.outbox ?? []).filter(o => o.invoice_id === inv.id).map(o => String(o.id)),
    ...(t.proposal ?? []).filter(p => p.work_item_id === `wi_${inv.id}`).map(p => String(p.id)),
    ...(t.receipt_attestation ?? []).filter(a => a.invoice_id === inv.id).map(a => String(a.id)),
    ...(t.payment ?? []).filter(p => p.invoice_id === inv.id).map(p => String(p.id)),
  ]);
  const audits = (t.audit_log ?? []).filter(a => related.has(String(a.entity_id)));
  const denials = audits
    .filter(a => a.outcome === 'denied')
    .map(a => `${ROLE_LABEL[String(a.actor_role)] ?? a.actor_role} refused: ${safeReason(String(a.reason || a.action))}`);
  const requestIds = [...new Set(audits.map(a => String(a.request_id || '')).filter(Boolean))];
  const duplicates = (t.request_result ?? []).filter(r => requestIds.includes(String(r.request_id)) && r.outcome === 'duplicate').length;

  const lines = assessment ? assessmentLines(String(assessment.details_json || '')) : [];
  const tape: TapeRow[] = [];
  if (rev) tape.push({ fact: `They asked ${money(rev.balance_requested_cents)}`, from: 'This bill' });
  if (assessment) {
    tape.push({ fact: `Code kept ${money(authorised)}`, from: 'Assessment against the order' });
    if (pending > 0) tape.push({ fact: `${money(pending)} is not agreed`, from: 'Held until a person acts' });
  }
  for (const l of lines.slice(0, 6)) {
    const fr = l.fragment_ids[0];
    const frag = (t.source_fragment ?? []).find(f => f.id === fr);
    const doc = (t.document ?? []).find(d => d.id === frag?.document_id);
    const from = KIND[String(doc?.kind || '')] || (fr ? 'Cited line' : 'This bill');
    if (l.pending_cents + l.variance_cents > 0) {
      tape.push({ fact: `${l.line || 'A line'} · not agreed ${money(l.pending_cents || l.variance_cents)}`, from });
    } else if (l.accepted_cents > 0) {
      tape.push({ fact: `${l.line || 'A line'} · ${money(l.accepted_cents)} matches the order`, from });
    }
  }
  const att = (t.receipt_attestation ?? []).find(a => a.invoice_id === inv.id);
  if (att) tape.push({ fact: `Site counted ${Number(att.quantity_milli) / 1000} ${att.unit}`, from: 'Delivery note' });
  const payee = (t.payee_profile ?? []).find(p => p.supplier_id === supplierId && p.status === 'verified');
  if (payee) tape.push({ fact: `Pay ${payee.bank_name} ····${payee.last4}`, from: 'Account on file' });

  const lessons: Lesson[] = [];
  for (const d of (t.settlement_decision ?? []).filter(x => x.invoice_id === inv.id && x.status !== 'superseded')) {
    lessons.push({
      who: ROLE_LABEL[String(d.decided_by_role)] ?? 'Owner',
      taught: d.decision === 'accept_as_billed'
        ? `Accepted ${money(d.amount_cents)} on a disputed line, with a note.`
        : `Kept the agreed amount. The extra stays on the claim.`,
      nextTime: 'Cite this decision. Do not auto-accept the next extra from this supplier.',
    });
  }
  for (const cr of (t.change_request ?? []).filter(c => {
    const pur = (t.purchase ?? []).find(p => p.id === c.purchase_id);
    return pur?.supplier_id === supplierId && c.internal_status === 'approved';
  }).slice(0, 3)) {
    lessons.push({
      who: ROLE_LABEL[String(cr.decided_by_role)] || 'Buyer',
      taught: cr.decision_note ? String(cr.decision_note) : `Approved a written change for ${money(cr.amount_cents)}.`,
      nextTime: 'A later bill may use this change. A new extra still needs its own yes.',
    });
  }
  if (att) {
    lessons.push({
      who: 'Site',
      taught: `Confirmed ${Number(att.quantity_milli) / 1000} ${att.unit}. “${att.reason}”`,
      nextTime: 'The count is a fact for this bill only. The next drop is confirmed again.',
    });
  }
  const bankDecided = audits.filter(a => a.action === 'decide_payee_profile' && a.outcome === 'ok');
  if (bankDecided.length) {
    lessons.push({
      who: 'Owner',
      taught: 'A bank change only after the number already on the quote.',
      nextTime: 'Never dial a number from the email that asked for the change.',
    });
  }

  const docIds = [...pack.ids];
  const jobs = (t.job ?? []).filter(j => {
    const blob = `${j.payload_json || ''} ${j.result_json || ''}`;
    return blob.includes(String(inv.id)) || docIds.some(d => blob.includes(d));
  }).map(j => ({
    kind: String(j.kind || 'job'),
    status: String(j.status || ''),
    note: j.status === 'failed'
      ? (String(j.error || 'Failed') + (j.attempts ? ` · try ${j.attempts}` : ''))
      : j.status === 'claimed'
        ? 'In flight. A stale lease can be picked up again.'
        : j.status === 'queued' ? 'Waiting for the worker.' : 'Finished once. Replay is safe.',
  }));

  const proposal = (t.proposal ?? []).filter(p => p.work_item_id === `wi_${inv.id}` && p.kind === 'supplier_payment').sort((a, b) => Number(b.created_at) - Number(a.created_at))[0];
  const pay = (t.payment ?? []).find(p => p.proposal_id === proposal?.id || p.id === proposal?.id);
  const journals = (t.ledger_line ?? []).filter(l => related.has(String(l.ref_id)) || String(l.ref_id) === String(inv.id)).length;
  const next = nextStep(inv, holds);
  const leaving = pay
    ? `Paid ${money(pay.amount_cents)} once.`
    : proposal && next.action === 'Pay this bill.'
      ? `Would pay ${money(proposal.amount_cents)} if Dana says yes.`
      : holds.some(h => MONEY_HOLD.has(String(h.code)))
        ? 'Nothing leaves while the extra is held.'
        : next.role ? `${next.action}` : 'Nothing is waiting to leave.';

  return {
    invoiceId: String(inv.id),
    invoiceNumber: String(inv.invoice_number),
    supplier: String(sup?.name ?? 'Supplier'),
    supplierId,
    story: billStory(inv, holds),
    href: `/invoices/${inv.id}`,
    pack: {
      docs,
      otherSuppliers: otherSupplierCount(t, supplierId),
      leaked,
      fingerprint: String(assessment?.fingerprint || '').slice(0, 12),
    },
    guards: {
      claimedCents: claimed,
      authorisedCents: authorised,
      pendingCents: pending,
      holds: holds.map(h => ({
        code: String(h.code),
        label: HOLD_LABEL[String(h.code)] ?? String(h.code),
        cents: Number(h.amount_cents) || 0,
      })),
      denials: [...new Set(denials)].slice(0, 6),
      guessed: pending === 0 && !holds.some(h => ['EXTRACTION_REVIEW', 'CONTRACT_REVIEW'].includes(String(h.code))),
    },
    tape: tape.slice(0, 8),
    lessons: lessons.slice(0, 4),
    jobs,
    write: {
      leaving,
      requestIds: requestIds.length,
      duplicates,
      journals,
      paid: inv.payment_status === 'settled' || String(pay?.status) === 'sent',
      simulated: String(pay?.nessie_transfer_id || '').includes('sim') || !pay,
    },
  };
}

export function proofDesk(t: Tables): ProofDesk {
  const invoices = (t.invoice ?? []).filter(i => !isSandbox(i));
  const bills = invoices.map(i => billProof(t, i));
  const sandbox = (t.invoice ?? []).filter(isSandbox);
  const companyIds = new Set(invoices.map(i => String(i.id)));
  const sandboxTouchedCompany = sandbox.some(s => companyIds.has(String(s.id)));
  return {
    bills,
    packsClean: bills.filter(b => !b.pack.leaked).length,
    stopsHeld: bills.filter(b => b.guards.holds.some(h => MONEY_HOLD.has(h.code)) && !b.write.paid).length,
    writesOnce: bills.filter(b => b.write.duplicates === 0).length,
    lessons: bills.reduce((n, b) => n + b.lessons.length, 0),
    denials: bills.reduce((n, b) => n + b.guards.denials.length, 0),
    sandboxUntouched: !sandboxTouchedCompany,
  };
}

export function packLine(p: BillProof): string {
  if (p.pack.leaked) return 'A cited line was not from this supplier. Held.';
  const n = p.pack.docs.length;
  return n
    ? `${n} source${n === 1 ? '' : 's'} for ${p.supplier} only. ${p.pack.otherSuppliers} other suppliers stayed out.`
    : 'No files on this bill yet.';
}

export function guardLine(p: BillProof): string {
  const hold = p.guards.holds[0];
  if (hold) {
    return `They asked ${money(p.guards.claimedCents)}. ${hold.label}${hold.cents ? ` · ${money(hold.cents)}` : ''}.`;
  }
  if (p.guards.claimedCents && p.guards.authorisedCents !== p.guards.claimedCents) {
    return `They asked ${money(p.guards.claimedCents)}. Code kept ${money(p.guards.authorisedCents)}.`;
  }
  return `They asked ${money(p.guards.claimedCents)}. Code agrees.`;
}

export function proofSpeech(p: BillProof): string {
  const lines = [
    `${p.supplier}, invoice ${p.invoiceNumber.replace(/-/g, ' ')}.`,
    p.story,
    packLine(p),
    guardLine(p),
    p.lessons[0] ? `Last lesson: ${p.lessons[0].taught}` : '',
    p.write.leaving,
  ];
  return lines.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 1400);
}

export function deskSpeech(d: ProofDesk): string {
  return [
    `${d.bills.length} company bills.`,
    `${d.packsClean} ${d.packsClean === 1 ? 'pack stayed' : 'packs stayed'} in their supplier.`,
    `${d.stopsHeld} ${d.stopsHeld === 1 ? 'extra is' : 'extras are'} still held.`,
    `${d.writesOnce} writes did not double.`,
    d.sandboxUntouched ? 'Judge sandbox did not change the company books.' : 'Sandbox touched a company bill.',
    `${d.lessons} human lessons on file. None of them auto-pay.`,
  ].join(' ');
}

/** JSON-LD for one bill: the proof, not a second set of books. */
export function proofGraph(p: BillProof) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Invoice',
    identifier: p.invoiceNumber,
    provider: p.supplier,
    description: p.story,
    additionalProperty: [
      { '@type': 'PropertyValue', name: 'pack', value: packLine(p) },
      { '@type': 'PropertyValue', name: 'guard', value: guardLine(p) },
      { '@type': 'PropertyValue', name: 'write', value: p.write.leaving },
      { '@type': 'PropertyValue', name: 'fingerprint', value: p.pack.fingerprint },
    ],
  };
}

export function parsePayload(json: string): Record<string, unknown> {
  return parse(json, {});
}
