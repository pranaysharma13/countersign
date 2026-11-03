import type { Row, Tables } from './client';
import { extractValues, goldOf, sameFact, type GoldBill, type GoldHold } from './evalKey.ts';
import { deskPipes, type Pipe } from './pipes.ts';
import { QUESTIONS } from './questions.ts';
import {
  HOLD_LABEL, ROLE_LABEL, assessmentLines, isSandbox, money, qty,
} from './format.ts';
import { billProof, type BillProof, type Lesson } from './proof.ts';

const MONEY_HOLD = new Set(['PRICE_VARIANCE', 'PROPOSED_CHARGE', 'USAGE_EVIDENCE_MISSING', 'PO_CEILING']);
const UNCERTAIN_HOLD = new Set(['EXTRACTION_REVIEW', 'CONTRACT_REVIEW', 'DUPLICATE_REVIEW']);

const JOB_KIND: Record<string, string> = {
  process_document: 'Read this file',
  assess_invoice: 'Check this bill',
  reset_demo: 'Reset the demo',
};

const REDUCER: Record<string, string> = {
  record_assessment: 'Assessed the bill',
  record_extraction_run: 'Recorded a read',
  open_hold: 'Opened a hold',
  propose_supplier_payment: 'Proposed a payment',
  approve_supplier_payment: 'Paid',
  start_payment: 'Started the transfer',
  record_payment: 'Recorded the transfer',
  attest_receipt: 'Site confirmed delivery',
  decide_payee_profile: 'Owner decided a bank',
  decide_disputed_line: 'Owner decided a line',
  draft_outbox: 'Drafted a letter',
  approve_outbox: 'Sent a letter',
  enqueue_job: 'Queued work',
  claim_job: 'Picked up work',
  finish_job: 'Finished work',
};

export interface HoldGap {
  code: string;
  label: string;
  expectedCents: number | null;
  actualCents: number | null;
  kind: 'missed' | 'extra' | 'match';
}

export interface FieldGap {
  name: string;
  expected: string;
  actual: string;
}

export interface WatchPaper {
  scored: boolean;
  pass: boolean;
  why: string;
  guessed: boolean;
  extract: {
    mode: string;
    prompt: string;
    status: string;
    failed: boolean;
  };
  claimedOk: boolean | null;
  authorisedOk: boolean | null;
  gaps: HoldGap[];
  missed: number;
  extra: number;
  fields: { ok: number; total: number; misses: FieldGap[]; source: 'extract' | 'books' | 'none'; drift: boolean };
}

export interface PackPaper {
  included: { id: string; kind: string; label: string }[];
  excludedSuppliers: number;
  excludedFiles: number;
  cited: number;
  available: number;
  lessons: number;
  policy: string;
  fingerprint: string;
  leaked: boolean;
  line: string;
}

export interface CanonFact {
  name: string;
  value: string;
  owner: string;
  conflict: boolean;
}

export interface CanonPaper {
  facts: CanonFact[];
  conflicts: CanonFact[];
  ingest: { from: string; n: number }[];
  line: string;
}

export interface LessonPaper {
  rows: (Lesson & { supplier: string; supplierId: string })[];
  isolated: boolean;
  stillHeld: number;
  autoPaid: number;
  line: string;
}

export interface RunRow {
  kind: string;
  status: string;
  attempts: number;
  note: string;
  replaySafe: boolean;
}

export interface RunPaper {
  jobs: RunRow[];
  staleApprovals: number;
  outboxDrafts: number;
  replaySafe: boolean;
  line: string;
}

export interface WriteRow {
  requestId: string;
  what: string;
  who: string;
  outcome: string;
}

export interface WritePaper {
  rows: WriteRow[];
  journals: { account: string; debit: number; credit: number }[];
  balanced: boolean;
  duplicates: number;
  simulated: boolean;
  paid: boolean;
  waitingOnOwner: boolean;
  line: string;
}

export interface BillTrust {
  proof: BillProof;
  watch: WatchPaper;
  pack: PackPaper;
  canon: CanonPaper;
  lesson: LessonPaper;
  run: RunPaper;
  write: WritePaper;
}

export interface TrustDesk {
  bills: BillTrust[];
  watchPass: number;
  watchScored: number;
  packsClean: number;
  conflicts: number;
  guessed: number;
  lessons: number;
  autoPaid: number;
  runsSafe: number;
  writesOnce: number;
  sandboxUntouched: boolean;
  fieldsOk: number;
  fieldsScored: number;
  pipes: Pipe[];
}

function rows(t: Tables, name: string): Row[] {
  return t[name] ?? [];
}

function expectedHolds(gold: GoldBill, inv: Row, t: Tables): GoldHold[] {
  const revs = rows(t, 'invoice_revision').filter(r => r.invoice_id === inv.id);
  const rev = revs.find(r => r.id === inv.active_revision_id) ?? revs[0];
  const history = rows(t, 'hold').filter(h => h.revision_id === rev?.id);
  const attested = rows(t, 'receipt_attestation').some(a => a.invoice_id === inv.id)
    || inv.receipt_status === 'manually_confirmed';
  const pendingPayee = rows(t, 'payee_profile').some(p => p.supplier_id === inv.supplier_id && p.status === 'pending')
    || inv.payee_status === 'change_pending';
  const base: GoldHold[] = [];
  for (const h of gold.holds) {
    const row = history.find(x => x.code === h.code);
    if (row && row.status === 'resolved') continue;
    if (h.code === 'RECEIPT_NOT_VERIFIED' && attested) continue;
    if (h.code === 'PAYEE_CHANGE_PENDING' && !pendingPayee && row?.status !== 'open') continue;
    base.push(h);
  }
  if (!attested && !base.some(h => h.code === 'RECEIPT_NOT_VERIFIED')) {
    base.push({ code: 'RECEIPT_NOT_VERIFIED', cents: 0 });
  }
  if (pendingPayee && !base.some(h => h.code === 'PAYEE_CHANGE_PENDING')) {
    base.push({ code: 'PAYEE_CHANGE_PENDING', cents: 0 });
  }
  return base;
}

function latestRun(t: Tables, docIds: string[]): Row | undefined {
  const runs = rows(t, 'extraction_run').filter(r => docIds.includes(String(r.document_id)));
  return runs.sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))[0];
}

function thisAssessment(t: Tables, inv: Row): Row | undefined {
  const revs = rows(t, 'invoice_revision').filter(r => r.invoice_id === inv.id);
  const rev = revs.find(r => r.id === inv.active_revision_id) ?? revs[0];
  return rows(t, 'assessment').filter(a => a.revision_id === rev?.id).sort((a, b) => Number(b.version) - Number(a.version))[0];
}

const EMPTY_FIELDS: WatchPaper['fields'] = { ok: 0, total: 0, misses: [], source: 'none', drift: false };

function scoreFields(t: Tables, inv: Row, proof: BillProof, gold: GoldBill): WatchPaper['fields'] {
  const revs = rows(t, 'invoice_revision').filter(r => r.invoice_id === inv.id);
  const rev = revs.find(r => r.id === inv.active_revision_id) ?? revs[0];
  const docId = String(rev?.document_id || '');
  const runs = rows(t, 'extraction_run').filter(r => String(r.document_id) === docId && r.status === 'ok');
  const extract = runs.sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))[0];
  const fixture = runs.filter(r => r.mode === 'fixture')[0];
  const live = runs.filter(r => r.mode === 'live')[0];
  let drift = false;
  if (fixture && live) {
    const a = extractValues(String(fixture.fields_json || ''));
    const b = extractValues(String(live.fields_json || ''));
    if (a.gross_cents != null && b.gross_cents != null && !sameFact(a.gross_cents, b.gross_cents)) drift = true;
    if (a.invoice_number && b.invoice_number && !sameFact(a.invoice_number, b.invoice_number)) drift = true;
  }
  const payee = rows(t, 'payee_profile').find(p => p.supplier_id === inv.supplier_id && p.status === 'verified');
  const pur = rows(t, 'purchase').find(p => p.id === inv.purchase_id);
  const got: Record<string, unknown> = extract
    ? extractValues(String(extract.fields_json || ''))
    : {
        invoice_number: inv.invoice_number,
        gross_cents: proof.guards.claimedCents,
        po_number: pur?.po_number,
        remit_account_last4: payee?.last4,
        due_date: inv.due_date,
        invoice_date: inv.invoice_date,
      };
  const want: Record<string, unknown> = {
    invoice_number: gold.number,
    gross_cents: gold.claimedCents,
    po_number: gold.fields.po_number,
    remit_account_last4: gold.fields.last4,
    due_date: gold.fields.due_date,
    invoice_date: gold.fields.invoice_date,
  };
  const misses: FieldGap[] = [];
  let total = 0;
  let ok = 0;
  for (const [name, expected] of Object.entries(want)) {
    const actual = got[name];
    if (actual == null || actual === '') {
      if (extract) misses.push({ name, expected: String(expected), actual: 'missing' });
      if (extract) total += 1;
      continue;
    }
    total += 1;
    if (sameFact(expected, actual)) ok += 1;
    else misses.push({ name, expected: String(expected), actual: String(actual) });
  }
  return { ok, total, misses, source: extract ? 'extract' : 'books', drift };
}

function watchOf(t: Tables, inv: Row, proof: BillProof): WatchPaper {
  const gold = goldOf(proof.invoiceNumber);
  const run = latestRun(t, proof.pack.docs.map(d => d.id));
  const failed = ['invalid', 'failed'].includes(String(run?.status || ''));
  const extractHold = proof.guards.holds.some(h => h.code === 'EXTRACTION_REVIEW');
  const assessment = thisAssessment(t, inv);
  const guessed = (failed && !extractHold)
    || assessmentLines(String(assessment?.details_json || ''))
      .some(l => !!l.uncertainty && l.pending_cents === 0 && l.variance_cents === 0
        && !proof.guards.holds.some(h => UNCERTAIN_HOLD.has(h.code) || MONEY_HOLD.has(h.code)));
  const extract = {
    mode: String(run?.mode || 'fixture'),
    prompt: String(run?.prompt_version || (run ? '-' : 'fixture')),
    status: String(run?.status || 'ok'),
    failed,
  };
  const keptExtra = proof.guards.holds.some(h => MONEY_HOLD.has(h.code) && h.cents > 0)
    && proof.guards.pendingCents === 0
    && proof.guards.authorisedCents === proof.guards.claimedCents;
  if (!gold) {
    return {
      scored: false, pass: !guessed && !failed && !keptExtra, why: keptExtra
        ? 'A money hold is open but the assessment kept the full claim.'
        : 'No labelled quote and order for this bill. Clerk still holds extras; it does not guess.',
      guessed, extract, claimedOk: null, authorisedOk: null, gaps: [], missed: 0, extra: 0, fields: EMPTY_FIELDS,
    };
  }
  const expected = expectedHolds(gold, inv, t);
  const actual = proof.guards.holds.map(h => ({ code: h.code, cents: h.cents }));
  const gaps: HoldGap[] = [];
  for (const e of expected) {
    const a = actual.find(x => x.code === e.code);
    if (!a) {
      gaps.push({ code: e.code, label: HOLD_LABEL[e.code] ?? e.code, expectedCents: e.cents, actualCents: null, kind: 'missed' });
    } else if (e.cents > 0 && a.cents !== e.cents) {
      gaps.push({ code: e.code, label: HOLD_LABEL[e.code] ?? e.code, expectedCents: e.cents, actualCents: a.cents, kind: 'missed' });
    } else {
      gaps.push({ code: e.code, label: HOLD_LABEL[e.code] ?? e.code, expectedCents: e.cents, actualCents: a.cents, kind: 'match' });
    }
  }
  for (const a of actual) {
    if (!expected.some(e => e.code === a.code)) {
      gaps.push({ code: a.code, label: HOLD_LABEL[a.code] ?? a.code, expectedCents: null, actualCents: a.cents, kind: 'extra' });
    }
  }
  const claimedOk = proof.guards.claimedCents === gold.claimedCents;
  const authorisedOk = gold.authorisedCents == null
    ? (keptExtra ? false : null)
    : (keptExtra ? false : proof.guards.authorisedCents === gold.authorisedCents);
  const missed = gaps.filter(g => g.kind === 'missed').length;
  const extra = gaps.filter(g => g.kind === 'extra').length;
  const fields = scoreFields(t, inv, proof, gold);
  const pass = missed === 0 && extra === 0 && claimedOk && authorisedOk !== false && !guessed && !keptExtra
    && fields.misses.length === 0 && !fields.drift;
  return {
    scored: true, pass, why: gold.why, guessed, extract, claimedOk, authorisedOk, gaps, missed, extra, fields,
  };
}

function packOf(t: Tables, inv: Row, proof: BillProof): PackPaper {
  const packIds = new Set(proof.pack.docs.map(d => d.id));
  const available = rows(t, 'source_fragment').filter(f => packIds.has(String(f.document_id))).length;
  const assessment = thisAssessment(t, inv);
  const cited = new Set(assessmentLines(String(assessment?.details_json || '')).flatMap(l => l.fragment_ids)).size;
  const otherFiles = rows(t, 'document').filter(d => !packIds.has(String(d.id))).length;
  const policy = String(rows(t, 'assessment').find(a => String(a.fingerprint || '').startsWith(proof.pack.fingerprint))?.policy_version || '');
  const n = proof.pack.docs.length;
  const line = proof.pack.leaked
    ? 'A cited line was not from this supplier. Held.'
    : `${n} file${n === 1 ? '' : 's'}, ${cited} cited line${cited === 1 ? '' : 's'}, ${proof.lessons.length} lesson${proof.lessons.length === 1 ? '' : 's'}. ${proof.pack.otherSuppliers} other suppliers and ${otherFiles} other files stayed out.`;
  return {
    included: proof.pack.docs,
    excludedSuppliers: proof.pack.otherSuppliers,
    excludedFiles: otherFiles,
    cited,
    available,
    lessons: proof.lessons.length,
    policy: policy || 'on-file',
    fingerprint: proof.pack.fingerprint,
    leaked: proof.pack.leaked,
    line,
  };
}

function canonOf(t: Tables, inv: Row, proof: BillProof): CanonPaper {
  const revs = rows(t, 'invoice_revision').filter(r => r.invoice_id === inv.id);
  const rev = revs.find(r => r.id === inv.active_revision_id) ?? revs[0];
  const pur = rows(t, 'purchase').find(p => p.id === inv.purchase_id);
  const att = rows(t, 'receipt_attestation').find(a => a.invoice_id === inv.id);
  const payee = rows(t, 'payee_profile').find(p => p.supplier_id === inv.supplier_id && p.status === 'verified');
  const pendingPayee = rows(t, 'payee_profile').find(p => p.supplier_id === inv.supplier_id && p.status === 'pending');
  const material = rows(t, 'invoice_line').filter(l => l.revision_id === rev?.id && l.kind === 'material');
  const billedMilli = material.reduce((s, l) => s + (Number(l.quantity_milli) || 0), 0);
  const unit = String(material[0]?.unit || att?.unit || '');
  const moneyConflict = proof.guards.pendingCents > 0 || proof.guards.holds.some(h => MONEY_HOLD.has(h.code));
  const countConflict = !!(att && billedMilli && Number(att.quantity_milli) !== billedMilli);
  const bankConflict = !!pendingPayee;
  const facts: CanonFact[] = [
    { name: 'They asked', value: money(Number(rev?.balance_requested_cents) || proof.guards.claimedCents), owner: 'This bill', conflict: moneyConflict },
    { name: 'Code kept', value: money(proof.guards.authorisedCents), owner: 'Assessment', conflict: moneyConflict },
  ];
  if (pur?.po_number) facts.push({ name: 'Order', value: String(pur.po_number), owner: 'Purchase order', conflict: proof.guards.holds.some(h => h.code === 'PO_CEILING') });
  if (att) {
    facts.push({
      name: 'Site counted',
      value: qty(Number(att.quantity_milli) || 0, String(att.unit || unit)),
      owner: 'Delivery note',
      conflict: countConflict,
    });
  } else if (inv.receipt_status === 'required') {
    facts.push({ name: 'Site counted', value: 'Not yet', owner: 'Delivery note', conflict: true });
  }
  if (payee) facts.push({ name: 'Pay', value: `${payee.bank_name} ····${payee.last4}`, owner: 'Account on file', conflict: bankConflict });
  if (pendingPayee) facts.push({ name: 'They emailed', value: `····${pendingPayee.last4}`, owner: 'Mail, never the bank number', conflict: true });
  if (proof.guards.pendingCents > 0) {
    facts.push({ name: 'Not agreed', value: money(proof.guards.pendingCents), owner: 'Held until a person acts', conflict: true });
  }
  const mails = rows(t, 'email_message').filter(m => proof.pack.docs.some(d => d.id === String(m.document_id)));
  const ingest = [
    { from: 'Files', n: proof.pack.docs.length },
    { from: 'Mail', n: mails.length },
    { from: 'Site', n: att ? 1 : 0 },
    { from: 'Bank on file', n: payee || pendingPayee ? 1 : 0 },
  ].filter(x => x.n > 0);
  const conflicts = facts.filter(f => f.conflict);
  const line = conflicts.length
    ? `${conflicts.length === 1 ? '1 fact disagrees' : `${conflicts.length} facts disagree`}. The hold is the reconciliation. Clerk does not blend the numbers.`
    : 'Quote, order, bill, site and bank agree. Code still does not pay.';
  return { facts, conflicts, ingest, line };
}

function lessonOf(t: Tables, proof: BillProof, all: BillProof[]): LessonPaper {
  const rowsL = proof.lessons.map(l => ({ ...l, supplier: proof.supplier, supplierId: proof.supplierId }));
  const leaked = all.some(p => p.supplierId !== proof.supplierId && p.lessons.some(l => proof.lessons.some(x => x.taught === l.taught && x.who === l.who)));
  const stillHeld = all.filter(p => p.supplierId === proof.supplierId && p.guards.holds.some(h => MONEY_HOLD.has(h.code))).length;
  const autoPaid = all.filter(p => p.supplierId === proof.supplierId && p.lessons.length > 0 && p.write.paid && p.guards.holds.some(h => MONEY_HOLD.has(h.code))).length;
  const line = rowsL.length
    ? `${rowsL.length} human lesson${rowsL.length === 1 ? '' : 's'} on ${proof.supplier}. Cite next time. None of them auto-pay.`
    : 'No person has taught this bill yet. Clerk will not guess.';
  return { rows: rowsL, isolated: !leaked, stillHeld, autoPaid, line };
}

function runOf(t: Tables, inv: Row, proof: BillProof): RunPaper {
  const rawJobs = rows(t, 'job').filter(x => {
    const blob = `${x.payload_json || ''} ${x.result_json || ''}`;
    return blob.includes(String(inv.id)) || proof.pack.docs.some(d => blob.includes(d.id));
  });
  const jobs: RunRow[] = rawJobs.map(raw => {
    const status = String(raw.status || '');
    const attempts = Number(raw.attempts) || 0;
    const kind = JOB_KIND[String(raw.kind)] ?? String(raw.kind || 'job').replaceAll('_', ' ');
    const note = status === 'failed'
      ? (`${raw.error || 'Failed'}${attempts ? ` · try ${attempts}` : ''}${raw.next_attempt_at_iso ? `. Next try ${raw.next_attempt_at_iso}.` : ''}`)
      : status === 'claimed'
        ? `In flight.${raw.lease_expires_at_iso ? ` Lease until ${raw.lease_expires_at_iso}.` : ' A stale lease can be picked up again.'}`
        : status === 'queued'
          ? 'Waiting for the worker.'
          : 'Finished once. Replay is safe.';
    return {
      kind,
      status,
      attempts,
      note,
      replaySafe: status !== 'claimed' || !!raw.lease_expires_at_iso,
    };
  });
  const staleApprovals = rows(t, 'payment_approval').filter(a => a.invoice_id === inv.id && a.status === 'stale').length;
  const outboxDrafts = rows(t, 'outbox').filter(o => o.invoice_id === inv.id && (o.status === 'draft' || o.status === 'pending')).length;
  const replaySafe = jobs.every(j => j.replaySafe);
  const line = staleApprovals
    ? `An earlier approval went stale when the bill changed. Review it again.${jobs[0] ? ` ${jobs[0].kind} · ${jobs[0].note}` : ''}`
    : jobs[0]
      ? `${jobs[0].kind} · ${jobs[0].note}`
      : 'No job in flight. Replay of a finished write comes back as already done.';
  return { jobs, staleApprovals, outboxDrafts, replaySafe, line };
}

function writeOf(t: Tables, inv: Row, proof: BillProof): WritePaper {
  const related = new Set<string>([
    String(inv.id), `wi_${inv.id}`,
    ...rows(t, 'invoice_revision').filter(r => r.invoice_id === inv.id).map(r => String(r.id)),
  ]);
  const audits = rows(t, 'audit_log').filter(a => related.has(String(a.entity_id)) || String(a.entity_id) === String(inv.id));
  const ids = [...new Set(audits.map(a => String(a.request_id || '')).filter(Boolean))];
  const results = rows(t, 'request_result').filter(r => ids.includes(String(r.request_id)));
  const writeRows: WriteRow[] = results.slice(-8).map(r => ({
    requestId: String(r.request_id).slice(0, 12),
    what: REDUCER[String(r.reducer)] ?? String(r.reducer || '').replaceAll('_', ' '),
    who: ROLE_LABEL[String(r.caller_role)] ?? String(r.caller_role || ''),
    outcome: String(r.outcome),
  }));
  const journals = rows(t, 'ledger_line')
    .filter(l => related.has(String(l.ref_id)) || String(l.ref_id) === String(inv.id))
    .map(l => ({ account: String(l.account), debit: Number(l.debit_cents) || 0, credit: Number(l.credit_cents) || 0 }));
  const debit = journals.reduce((s, l) => s + l.debit, 0);
  const credit = journals.reduce((s, l) => s + l.credit, 0);
  const waitingOnOwner = !proof.write.paid && (proof.write.leaving.startsWith('Would pay') || proof.write.leaving.includes('Dana'));
  const line = [
    proof.write.leaving,
    proof.write.duplicates ? `${proof.write.duplicates} retry came back as already done.` : 'Retries cannot pay twice.',
    proof.write.simulated && proof.write.paid ? 'Labeled simulated.' : '',
    journals.length && debit !== credit ? 'Journal is not balanced. That should never happen.' : '',
  ].filter(Boolean).join(' ');
  return {
    rows: writeRows,
    journals,
    balanced: journals.length === 0 || debit === credit,
    duplicates: proof.write.duplicates,
    simulated: proof.write.simulated,
    paid: proof.write.paid,
    waitingOnOwner,
    line,
  };
}

export function billTrust(t: Tables, inv: Row, allProofs?: BillProof[]): BillTrust {
  const proof = billProof(t, inv);
  const all = allProofs ?? (rows(t, 'invoice').filter(i => !isSandbox(i)).map(i => billProof(t, i)));
  return {
    proof,
    watch: watchOf(t, inv, proof),
    pack: packOf(t, inv, proof),
    canon: canonOf(t, inv, proof),
    lesson: lessonOf(t, proof, all),
    run: runOf(t, inv, proof),
    write: writeOf(t, inv, proof),
  };
}

export function trustDesk(t: Tables): TrustDesk {
  const invoices = rows(t, 'invoice').filter(i => !isSandbox(i));
  const proofs = invoices.map(i => billProof(t, i));
  const bills = invoices.map(i => billTrust(t, i, proofs));
  const scored = bills.filter(b => b.watch.scored);
  const sandbox = rows(t, 'invoice').filter(isSandbox);
  const companyIds = new Set(invoices.map(i => String(i.id)));
  return {
    bills,
    watchPass: scored.filter(b => b.watch.pass).length,
    watchScored: scored.length,
    packsClean: bills.filter(b => !b.pack.leaked).length,
    conflicts: bills.reduce((n, b) => n + b.canon.conflicts.length, 0),
    guessed: bills.filter(b => b.watch.guessed).length,
    lessons: bills.reduce((n, b) => n + b.lesson.rows.length, 0),
    autoPaid: bills.reduce((n, b) => n + b.lesson.autoPaid, 0),
    runsSafe: bills.filter(b => b.run.replaySafe).length,
    writesOnce: bills.filter(b => b.write.duplicates === 0 && b.write.balanced).length,
    sandboxUntouched: !sandbox.some(s => companyIds.has(String(s.id))),
    fieldsOk: bills.reduce((n, b) => n + b.watch.fields.ok, 0),
    fieldsScored: bills.reduce((n, b) => n + b.watch.fields.total, 0),
    pipes: deskPipes(t),
  };
}

export const CHAPTERS = QUESTIONS;

export function chapterScore(d: TrustDesk, id: string): { num: string; ok: boolean; note: string } {
  const n = d.bills.length || 1;
  switch (id) {
    case 'watch': return { num: d.watchScored ? `${d.watchPass}/${d.watchScored}` : '-', ok: d.watchScored > 0 && d.watchPass === d.watchScored && d.guessed === 0, note: d.guessed ? `${d.guessed} guessed` : `Gold holds matched. ${d.fieldsOk}/${d.fieldsScored || 0} fields.` };
    case 'pack': return { num: `${d.packsClean}/${n}`, ok: d.packsClean === n, note: 'Cited lines stay inside this supplier.' };
    case 'canon': return { num: String(d.conflicts), ok: true, note: d.conflicts ? 'Conflicts are holds, not blended amounts.' : 'Sources agree. Code still does not pay.' };
    case 'lesson': return { num: String(d.lessons), ok: d.autoPaid === 0, note: d.autoPaid ? 'A lesson paid a later extra. That is a bug.' : 'Corrections are cited. None auto-pay.' };
    case 'run': return { num: `${d.runsSafe}/${n}`, ok: d.runsSafe === n, note: 'Finished jobs replay as already done. Stale approvals die.' };
    default: return { num: `${d.writesOnce}/${n}`, ok: d.writesOnce === n, note: 'The same request_id cannot pay twice. Journals balance.' };
  }
}

export function watchLine(w: WatchPaper): string {
  if (!w.scored) return w.why;
  if (w.guessed) return 'A read failed and no person was asked. That is a guess.';
  if (w.fields.drift) return 'A live read disagreed with the labelled quote. Held.';
  if (w.fields.misses.length) return `Extract missed ${w.fields.misses[0].name} (gold ${w.fields.misses[0].expected}).`;
  if (w.authorisedOk === false && w.missed === 0) return 'A money hold is open but the assessment kept the full claim. That is drift.';
  if (w.pass) return `Matches the quote and the order. ${w.why}`;
  if (w.missed) return `Missed ${w.missed} hold${w.missed === 1 ? '' : 's'} the quote and order required.`;
  if (w.extra) return `Opened ${w.extra} hold${w.extra === 1 ? '' : 's'} the quote and order did not expect.`;
  if (w.claimedOk === false) return 'They-asked amount does not match the quote and the order.';
  return w.why;
}

export function deskSpeech(d: TrustDesk): string {
  return [
    `${d.bills.length} company bills.`,
    d.watchScored ? `${d.watchPass} of ${d.watchScored} match the quote and the order.` : '',
    d.fieldsScored ? `${d.fieldsOk} of ${d.fieldsScored} labelled fields matched.` : '',
    `${d.packsClean} packs stayed in their supplier.`,
    `${d.conflicts} source conflicts are holds, not blended numbers.`,
    `${d.lessons} human lessons. None auto-pay.`,
    `${d.writesOnce} writes did not double.`,
    d.sandboxUntouched ? 'Judge sandbox did not change the company books.' : 'Sandbox touched a company bill.',
  ].filter(Boolean).join(' ');
}

export function caseSpeech(b: BillTrust): string {
  return [
    `${b.proof.supplier}, invoice ${b.proof.invoiceNumber.replace(/-/g, ' ')}.`,
    watchLine(b.watch),
    b.pack.line,
    b.canon.line,
    b.lesson.line,
    b.run.line,
    b.write.line,
  ].join(' ').replace(/\s+/g, ' ').trim().slice(0, 1400);
}
