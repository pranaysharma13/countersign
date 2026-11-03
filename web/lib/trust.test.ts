import assert from 'node:assert/strict';
import test from 'node:test';
import type { Tables } from './client.ts';
import { deskPipes } from './pipes.ts';
import { billTrust, deskSpeech, trustDesk, watchLine } from './trust.ts';

function tables(): Tables {
  return {
    supplier: [
      { id: 'sup_v', name: 'Valley Sand & Gravel', email_domain: 'valley-sand.example' },
      { id: 'sup_h', name: 'Harbor Packing', email_domain: 'harbor-pack.example' },
    ],
    supplier_contact: [{ supplier_id: 'sup_v', email: 'ar@valley-sand.example' }],
    purchase: [
      { id: 'pur_v', supplier_id: 'sup_v', quote_document_id: 'doc_q', po_document_id: 'doc_po', po_number: 'MF-PO-1073' },
      { id: 'pur_h', supplier_id: 'sup_h', quote_document_id: 'doc_hq', po_document_id: 'doc_hpo', po_number: 'MF-PO-1062' },
    ],
    document: [
      { id: 'doc_q', kind: 'quote', filename: 'quote.pdf' },
      { id: 'doc_po', kind: 'po', filename: 'po.pdf' },
      { id: 'doc_inv', kind: 'invoice', filename: 'vs310.pdf' },
      { id: 'doc_other', kind: 'invoice', filename: 'hp220.pdf' },
      { id: 'doc_hq', kind: 'quote', filename: 'hpq.pdf' },
      { id: 'doc_hpo', kind: 'po', filename: 'hppo.pdf' },
    ],
    invoice: [
      {
        id: 'inv_vs310', invoice_number: 'VS-310', supplier_id: 'sup_v', purchase_id: 'pur_v',
        active_revision_id: 'rev1', payment_status: 'not_ready', commercial_status: 'differences_under_review',
        receipt_status: 'manually_confirmed',
      },
      {
        id: 'inv_hp220', invoice_number: 'HP-220', supplier_id: 'sup_h', purchase_id: 'pur_h',
        active_revision_id: 'revh', payment_status: 'not_ready', commercial_status: 'matches',
        receipt_status: 'manually_confirmed',
      },
    ],
    invoice_revision: [
      { id: 'rev1', invoice_id: 'inv_vs310', document_id: 'doc_inv', balance_requested_cents: 399000 },
      { id: 'revh', invoice_id: 'inv_hp220', document_id: 'doc_other', balance_requested_cents: 74000 },
    ],
    invoice_line: [
      { revision_id: 'rev1', kind: 'material', quantity_milli: 95000, unit: 'ton', amount_cents: 399000 },
    ],
    assessment: [
      {
        id: 'a1', revision_id: 'rev1', version: 1, fingerprint: 'abc123def456', policy_version: 'terms-v1',
        claimed_cents: 399000, authorised_cents: 336000, pending_cents: 63000,
        details_json: JSON.stringify({
          lines: [{
            line_id: 'l1', description: 'Class II base', claimed_cents: 399000, accepted_cents: 336000,
            pending_cents: 63000, variance_cents: 0, fragment_ids: ['fr_po'],
          }],
        }),
      },
      {
        id: 'ah', revision_id: 'revh', version: 1, fingerprint: 'hp999', claimed_cents: 74000, authorised_cents: 74000, pending_cents: 0,
        details_json: JSON.stringify({ lines: [{ line_id: 'lh', description: 'Crates', claimed_cents: 74000, accepted_cents: 74000, pending_cents: 0, variance_cents: 0, fragment_ids: ['fr_h'] }] }),
      },
    ],
    source_fragment: [
      { id: 'fr_po', document_id: 'doc_po', text: '80 ton' },
      { id: 'fr_h', document_id: 'doc_other', text: '40 crates' },
    ],
    hold: [
      { id: 'h1', revision_id: 'rev1', status: 'open', code: 'PO_CEILING', amount_cents: 63000 },
      { id: 'hh', revision_id: 'revh', status: 'open', code: 'PROMPT_INJECTION', amount_cents: 0 },
    ],
    audit_log: [
      { id: 1, entity_id: 'inv_vs310', request_id: 'r1', actor_role: 'purchasing', action: 'decide_disputed_line', outcome: 'denied', reason: "role 'purchasing' may not call decide_disputed_line" },
    ],
    request_result: [{ request_id: 'r1', reducer: 'decide_disputed_line', caller_role: 'purchasing', outcome: 'denied' }],
    outbox: [], proposal: [], receipt_attestation: [
      { invoice_id: 'inv_vs310', quantity_milli: 95000, unit: 'ton', reason: '95 tons at the gate' },
    ],
    payee_profile: [{ supplier_id: 'sup_v', status: 'verified', bank_name: 'Delta Aggregate Bank', last4: '3382' }],
    settlement_decision: [{
      invoice_id: 'inv_vs310', status: 'active', decision: 'pay_agreed_dispute_rest', amount_cents: 63000, decided_by_role: 'owner',
    }],
    change_request: [], job: [{
      kind: 'process_document', status: 'done', payload_json: '{"document_id":"doc_inv"}', attempts: 1,
    }],
    payment: [], ledger_line: [
      { ref_id: 'inv_vs310', account: 'accounts_payable', debit_cents: 0, credit_cents: 336000 },
      { ref_id: 'inv_vs310', account: 'inventory', debit_cents: 336000, credit_cents: 0 },
    ],
    email_message: [], extraction_run: [], payment_approval: [], term: [],
  };
}

test('watch matches the gold key for Valley and Harbor', () => {
  const t = tables();
  const vs = billTrust(t, t.invoice[0]);
  assert.equal(vs.watch.scored, true);
  assert.equal(vs.watch.pass, true);
  assert.equal(vs.watch.missed, 0);
  assert.equal(vs.watch.claimedOk, true);
  assert.equal(vs.watch.authorisedOk, true);
  assert.match(watchLine(vs.watch), /quote and the order/);
  const hp = billTrust(t, t.invoice[1]);
  assert.equal(hp.watch.pass, true);
});

test('a missed hold is a watch fail, not a silent pass', () => {
  const t = tables();
  t.hold = t.hold.filter(h => h.code !== 'PO_CEILING');
  t.assessment[0].pending_cents = 0;
  t.assessment[0].authorised_cents = 399000;
  const vs = billTrust(t, t.invoice[0]);
  assert.equal(vs.watch.pass, false);
  assert.equal(vs.watch.missed, 1);
});

test('failed extract without a review hold is a guess', () => {
  const t = tables();
  t.extraction_run = [{ document_id: 'doc_inv', mode: 'live', prompt_version: 'extract-v1.2', status: 'failed', created_at: 2 }];
  const vs = billTrust(t, t.invoice[0]);
  assert.equal(vs.watch.guessed, true);
  assert.equal(vs.watch.pass, false);
});

test('pack names the order and keeps Harbor files out of Valley', () => {
  const vs = billTrust(tables(), tables().invoice[0]);
  assert.equal(vs.pack.leaked, false);
  assert.ok(vs.pack.included.some(d => d.kind === 'po'));
  assert.ok(vs.pack.excludedSuppliers >= 1);
  assert.match(vs.pack.line, /stayed out/);
});

test('canon holds the extra instead of blending the numbers', () => {
  const vs = billTrust(tables(), tables().invoice[0]);
  assert.ok(vs.canon.conflicts.length >= 1);
  assert.ok(vs.canon.facts.some(f => f.name === 'They asked' && f.conflict));
  assert.ok(vs.canon.facts.some(f => f.name === 'Code kept'));
  assert.match(vs.canon.line, /hold is the reconciliation/);
});

test('a Valley lesson does not sit on Harbor, and never auto-pays', () => {
  const d = trustDesk(tables());
  const vs = d.bills.find(b => b.proof.invoiceNumber === 'VS-310')!;
  const hp = d.bills.find(b => b.proof.invoiceNumber === 'HP-220')!;
  assert.ok(vs.lesson.rows.length >= 1);
  assert.equal(hp.lesson.rows.length, 0);
  assert.equal(vs.lesson.isolated, true);
  assert.equal(d.autoPaid, 0);
});

test('replay of a finished job is safe and journals balance', () => {
  const vs = billTrust(tables(), tables().invoice[0]);
  assert.equal(vs.run.replaySafe, true);
  assert.match(vs.run.line, /Finished once|Replay/);
  assert.equal(vs.write.balanced, true);
  assert.equal(vs.write.duplicates, 0);
  assert.ok(vs.write.rows.some(r => r.outcome === 'denied'));
});

test('a resolved bank hold drops off the gold key', () => {
  const t = tables();
  t.invoice[1].payee_status = 'verified';
  t.hold = t.hold.map(h => h.code === 'PROMPT_INJECTION' ? { ...h, status: 'resolved' } : h);
  const hp = billTrust(t, t.invoice[1]);
  assert.equal(hp.watch.pass, true);
  assert.equal(hp.watch.missed, 0);
});

test('an open ceiling hold that still authorises the full claim is drift', () => {
  const t = tables();
  t.assessment[0].authorised_cents = 399000;
  t.assessment[0].pending_cents = 0;
  const vs = billTrust(t, t.invoice[0]);
  assert.equal(vs.watch.pass, false);
  assert.equal(vs.watch.authorisedOk, false);
  assert.match(watchLine(vs.watch), /drift/i);
});

test('a labelled extract that misses gross_cents fails watch', () => {
  const t = tables();
  t.extraction_run = [{
    document_id: 'doc_inv', mode: 'fixture', status: 'ok', created_at: 1,
    fields_json: JSON.stringify({
      fields: {
        invoice_number: { value: 'VS-310' },
        gross_cents: { value: 1 },
        po_number: { value: 'MF-PO-1073' },
        remit_account_last4: { value: '3382' },
        due_date: { value: '2026-11-05' },
        invoice_date: { value: '2026-10-21' },
      },
    }),
  }];
  const vs = billTrust(t, t.invoice[0]);
  assert.equal(vs.watch.pass, false);
  assert.ok(vs.watch.fields.misses.some(m => m.name === 'gross_cents'));
  assert.match(watchLine(vs.watch), /gross_cents/);
});

test('mail never owns the bank last-4', () => {
  const t = tables();
  t.email_message = [{ document_id: 'doc_inv', from_address: 'ar@valley-sand.example' }];
  t.payee_profile = [
    ...t.payee_profile,
    { supplier_id: 'sup_v', status: 'pending', last4: '9999' },
  ];
  t.hold.push({ id: 'hb', revision_id: 'rev1', status: 'open', code: 'PAYEE_CHANGE_PENDING', amount_cents: 0 });
  const mail = deskPipes(t).find(p => p.id === 'mail')!;
  assert.match(mail.never, /last-4/i);
  assert.equal(mail.ok, true);
  assert.match(mail.note, /quote still owns/i);
});

test('desk speech names gold matches and no auto-pay', () => {
  const d = trustDesk(tables());
  assert.equal(d.watchPass, 2);
  assert.equal(d.watchScored, 2);
  const s = deskSpeech(d);
  assert.match(s, /2 of 2 match the quote and the order/);
  assert.match(s, /auto-pay/);
});
