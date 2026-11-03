import assert from 'node:assert/strict';
import test from 'node:test';
import type { Tables } from './client.ts';
import { billProof, deskSpeech, packLine, proofDesk, proofSpeech } from './proof.ts';

function tables(): Tables {
  return {
    supplier: [{ id: 'sup_v', name: 'Valley Sand & Gravel', email_domain: 'valley-sand.example' }],
    supplier_contact: [{ supplier_id: 'sup_v', email: 'ar@valley-sand.example' }],
    purchase: [{ id: 'pur_v', supplier_id: 'sup_v', quote_document_id: 'doc_q', po_document_id: 'doc_po' }],
    document: [
      { id: 'doc_q', kind: 'quote', filename: 'quote.pdf' },
      { id: 'doc_po', kind: 'po', filename: 'po.pdf' },
      { id: 'doc_inv', kind: 'invoice', filename: 'vs310.pdf' },
      { id: 'doc_other', kind: 'invoice', filename: 'other.pdf' },
    ],
    invoice: [{
      id: 'inv_vs310', invoice_number: 'VS-310', supplier_id: 'sup_v', purchase_id: 'pur_v',
      active_revision_id: 'rev1', payment_status: 'not_ready', commercial_status: 'differences_under_review',
    }],
    invoice_revision: [{ id: 'rev1', invoice_id: 'inv_vs310', document_id: 'doc_inv', balance_requested_cents: 399000 }],
    invoice_line: [],
    assessment: [{
      id: 'a1', revision_id: 'rev1', version: 1, fingerprint: 'abc123def456',
      claimed_cents: 399000, authorised_cents: 336000, pending_cents: 63000,
      details_json: JSON.stringify({
        lines: [{
          line_id: 'l1', description: 'Class II base', claimed_cents: 399000, accepted_cents: 336000,
          pending_cents: 63000, variance_cents: 0, fragment_ids: ['fr_po'],
        }],
      }),
    }],
    source_fragment: [{ id: 'fr_po', document_id: 'doc_po', text: '80 ton' }],
    hold: [{ id: 'h1', revision_id: 'rev1', status: 'open', code: 'PO_CEILING', amount_cents: 63000 }],
    audit_log: [
      { id: 1, entity_id: 'inv_vs310', request_id: 'r1', actor_role: 'purchasing', action: 'decide_disputed_line', outcome: 'denied', reason: "role 'purchasing' may not call decide_disputed_line" },
    ],
    request_result: [{ request_id: 'r1', outcome: 'denied' }],
    outbox: [], proposal: [], receipt_attestation: [], payee_profile: [],
    settlement_decision: [], change_request: [], job: [], payment: [], ledger_line: [],
    email_message: [],
  };
}

test('pack stays on this supplier and names the quote and order', () => {
  const p = billProof(tables(), tables().invoice[0]);
  assert.equal(p.pack.leaked, false);
  assert.ok(p.pack.docs.some(d => d.kind === 'quote'));
  assert.ok(p.pack.docs.some(d => d.kind === 'po'));
  assert.match(packLine(p), /other suppliers stayed out/);
});

test('a cited fragment from another file is a leak', () => {
  const t = tables();
  t.source_fragment = [{ id: 'fr_po', document_id: 'doc_other', text: 'oops' }];
  const p = billProof(t, t.invoice[0]);
  assert.equal(p.pack.leaked, true);
});

test('guards keep the extra and log the refused owner action', () => {
  const p = billProof(tables(), tables().invoice[0]);
  assert.equal(p.guards.claimedCents, 399000);
  assert.equal(p.guards.authorisedCents, 336000);
  assert.equal(p.guards.holds[0].code, 'PO_CEILING');
  assert.ok(p.guards.denials[0].includes('refused'));
  assert.equal(p.write.paid, false);
  assert.match(p.write.leaving, /Nothing leaves/);
});

test('desk speech counts clean packs and held extras', () => {
  const d = proofDesk(tables());
  assert.equal(d.packsClean, 1);
  assert.equal(d.stopsHeld, 1);
  assert.equal(d.sandboxUntouched, true);
  const s = deskSpeech(d);
  assert.match(s, /1 pack stayed/);
  assert.match(s, /auto-pay/);
});

test('proof speech names the supplier and the extra', () => {
  const p = billProof(tables(), tables().invoice[0]);
  const s = proofSpeech(p);
  assert.match(s, /Valley Sand/);
  assert.match(s, /VS 310/);
});
