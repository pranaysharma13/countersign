// CONTRACT §9: supplier invoices. Same request pattern as v1 (see request.ts).
// Every money/quantity value is bigint (cents / thousandths). No floats anywhere.
import { Identity } from 'spacetimedb';
import type { Ctx } from './schema';
import { handle, ok, invalid, deny, audit, oneOf, iso, json, type Call, type Result } from './request';
import { setItemState, insertJob } from './helpers';
import { AGENT_SOURCE_STATES } from './constants';

// ---------- enums (§9.2) ----------
const SUPPLIER_STATUS = ['active', 'on_hold', 'blocked'];
const DOC_KINDS = ['quote', 'terms', 'po', 'invoice', 'email', 'other'];
const EXTRACTION_MODES = ['live', 'fixture'];
const EXTRACTION_STATUS = ['ok', 'invalid', 'failed'];
const PURCHASE_STATUS = ['open', 'contract_review', 'closed'];
const TERM_CODES = ['unit_price', 'max_quantity', 'valid_through', 'deposit', 'payment_terms', 'price_change_rule',
  'extra_charge_rule', 'fuel_surcharge_rule'];
const TERM_STATUS = ['accepted', 'proposed', 'declined', 'superseded'];
const CR_KINDS = ['extra_charge', 'price_change', 'quantity_change'];
const AUTHORISED = ['AUTHORISED_FIXED', 'AUTHORISED_RATE_USAGE_MISSING'];
const CR_CLASSIFICATIONS = [...AUTHORISED, 'PROPOSED', 'DECLINED', 'AMBIGUOUS', 'UNRELATED'];
const SUPPLIER_ACCEPTANCE = ['none', 'proposed', 'accepted', 'declined'];
const LINE_KINDS = ['material', 'extra', 'waiting', 'fuel', 'tax', 'freight', 'other'];
const COMMERCIAL_STATUS = ['pending', 'matches', 'differences_under_review', 'contract_review'];
export const HOLD_CODES = ['CONTRACT_REVIEW', 'PRICE_VARIANCE', 'PROPOSED_CHARGE', 'USAGE_EVIDENCE_MISSING', 'PO_CEILING',
  'DUPLICATE_REVIEW', 'EXTRACTION_REVIEW', 'RECEIPT_NOT_VERIFIED', 'PAYEE_CHANGE_PENDING', 'APPROVAL_STALE',
  'PROMPT_INJECTION', 'SUPPLIER_RISK'];
// §9.3: the owner may resolve only these with resolve_hold. The rest clear only through their own event.
export const OWNER_RESOLVABLE_HOLDS = ['PRICE_VARIANCE', 'PROPOSED_CHARGE', 'USAGE_EVIDENCE_MISSING', 'PO_CEILING',
  'DUPLICATE_REVIEW', 'EXTRACTION_REVIEW', 'CONTRACT_REVIEW', 'PROMPT_INJECTION', 'SUPPLIER_RISK'];
// §9.8.2: holds carried onto a corrected revision. A correction doesn't prove receipt, verify a payee or clear a risk flag.
const CARRY_OVER_HOLDS = ['RECEIPT_NOT_VERIFIED', 'PAYEE_CHANGE_PENDING', 'SUPPLIER_RISK'];

const nonNeg = (v: bigint, f: string) => (v < 0n ? `${f} can't be negative` : null);
const firstErr = (...e: (string | null)[]) => e.find(x => x) ?? null;

function parseIds(s: string): string[] | null {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) && v.every(x => typeof x === 'string') ? v : null; } catch { return null; }
}
function missingFragments(ctx: Ctx, s: string): string | null {
  const ids = parseIds(s);
  if (ids === null) return 'fragment ids must be a JSON list of strings';
  const missing = ids.filter(id => !ctx.db.source_fragment.id.find(id));
  return missing.length ? `unknown source fragments: ${missing.join(', ')}` : null;
}

// ---------- shared helpers ----------

function touchInvoice(c: Call, invoice_id: string, changes: Record<string, unknown>, reason = '') {
  const inv = c.ctx.db.invoice.id.find(invoice_id);
  if (!inv) return;
  const before: Record<string, unknown> = {};
  for (const k of Object.keys(changes)) before[k] = (inv as any)[k];
  c.ctx.db.invoice.id.update({ ...inv, ...changes, updated_at: c.ctx.timestamp } as any);
  audit(c, 'invoice', invoice_id, before, changes, reason);
}

function openHoldRow(c: Call, id: string, revision_id: string, code: string, amount_cents: bigint, reason: string, evidence_json = '[]') {
  const existing = c.ctx.db.hold.id.find(id);
  if (existing) return existing.status === 'open';
  const row = {
    id, revision_id, code, status: 'open', amount_cents, reason, evidence_json, opened_by_role: c.role,
    resolved_by_role: '', resolution_note: '', created_at: c.ctx.timestamp, resolved_at_iso: '',
  };
  c.ctx.db.hold.insert(row);
  audit(c, 'hold', id, null, row, reason);
  return true;
}

/** §9.8.2: a hold the module opens itself, one per code per revision (`hold_<revision_id>_<code>`). Reopens it if closed. */
function moduleHold(c: Call, revision_id: string, code: string, amount_cents: bigint, reason: string, evidence_json = '[]') {
  const id = `hold_${revision_id}_${code.toLowerCase()}`;
  const existing = c.ctx.db.hold.id.find(id);
  if (!existing) return openHoldRow(c, id, revision_id, code, amount_cents, reason, evidence_json);
  if (existing.status === 'open') return true;
  const row = { ...existing, status: 'open', amount_cents, reason, evidence_json, opened_by_role: c.role,
    resolved_by_role: '', resolution_note: '', resolved_at_iso: '' };
  c.ctx.db.hold.id.update(row);
  audit(c, 'hold', id, { status: existing.status }, { status: 'open' }, reason);
  return true;
}

function closeHold(c: Call, id: string, status: 'resolved' | 'superseded', note: string) {
  const h = c.ctx.db.hold.id.find(id);
  if (!h || h.status !== 'open') return;
  c.ctx.db.hold.id.update({ ...h, status, resolved_by_role: c.role, resolution_note: note, resolved_at_iso: iso(c) });
  audit(c, 'hold', id, { status: h.status }, { status }, note);
}

const openHolds = (ctx: Ctx, revision_id: string) =>
  [...ctx.db.hold.revision_id.filter(revision_id)].filter(h => h.status === 'open');

function latestAssessment(ctx: Ctx, revision_id: string) {
  let best: ReturnType<typeof ctx.db.assessment.id.find> = null;
  for (const a of [...ctx.db.assessment.revision_id.filter(revision_id)]) {
    if (!best || a.version > best.version) best = a;
  }
  return best;
}

function currentVerifiedProfile(ctx: Ctx, supplier_id: string) {
  return [...ctx.db.payee_profile.supplier_id.filter(supplier_id)].find(p => p.status === 'verified') ?? null;
}

function depositRemaining(ctx: Ctx, purchase_id: string) {
  let total = 0n, used = 0n;
  for (const d of [...ctx.db.deposit.iter()]) {
    if (d.purchase_id !== purchase_id || d.status !== 'settled') continue;
    total += d.amount_cents;
    for (const a of [...ctx.db.deposit_allocation.deposit_id.filter(d.id)]) used += a.amount_cents;
  }
  return total - used;
}

/** Mark an approval stale, reflect it on the invoice, and open APPROVAL_STALE on the invoice's active revision. */
function makeStale(c: Call, approval_id: string, reason: string) {
  const ap = c.ctx.db.payment_approval.id.find(approval_id);
  if (!ap || ap.status !== 'active') return;
  c.ctx.db.payment_approval.id.update({ ...ap, status: 'stale', stale_reason: reason });
  audit(c, 'payment_approval', ap.id, { status: 'active' }, { status: 'stale', stale_reason: reason }, reason);
  const inv = c.ctx.db.invoice.id.find(ap.invoice_id);
  if (inv) {
    touchInvoice(c, inv.id, { approval_status: 'stale', payment_status: 'not_ready', next_owner_role: 'owner',
      next_action: 'Re-approve: the approved payment is out of date' }, reason);
    const rev = inv.active_revision_id || ap.revision_id;
    moduleHold(c, rev, 'APPROVAL_STALE', ap.amount_cents, `Approval is stale: ${reason}`, json({ approval_ids: [ap.id] }));
  }
  const p = c.ctx.db.proposal.id.find(ap.proposal_id);
  if (p && p.status === 'approved') {
    c.ctx.db.proposal.id.update({ ...p, status: 'cancelled', decision_note: `approval stale: ${reason}` });
    audit(c, 'proposal', p.id, { status: p.status }, { status: 'cancelled' }, reason);
  }
}

function activeApprovalsForInvoice(ctx: Ctx, invoice_id: string) {
  return [...ctx.db.payment_approval.iter()].filter(a => a.invoice_id === invoice_id && a.status === 'active');
}

// ======================= Setup and records (A) =======================

export function set_authority(ctx: Ctx, sender: Identity, request_id: string,
  identity_hex: string, role: string, limit_cents: bigint, project_scope: string): Result {
  return handle(ctx, sender, 'set_authority', request_id, ['admin'], c => {
    let identity: Identity;
    try { identity = Identity.fromString(identity_hex); } catch { return invalid('identity_hex is not a valid identity'); }
    const err = firstErr(nonNeg(limit_cents, 'limit_cents'), project_scope ? null : "project_scope is required ('*' or a project id)");
    if (err) return invalid(err);
    const row = { identity, role, limit_cents, project_scope };
    const before = ctx.db.authority.identity.find(identity);
    if (before) ctx.db.authority.identity.update(row); else ctx.db.authority.insert(row);
    audit(c, 'authority', identity.toHexString(), before, row);
    return ok();
  });
}

export function upsert_supplier(ctx: Ctx, sender: Identity, request_id: string,
  id: string, name: string, email_domain: string, phone_on_file: string, crs_ref: string, status: string): Result {
  return handle(ctx, sender, 'upsert_supplier', request_id, ['sync', 'admin'], c => {
    const err = oneOf(status, SUPPLIER_STATUS, 'status');
    if (err) return invalid(err);
    const before = ctx.db.supplier.id.find(id);
    if (before && before.phone_on_file !== phone_on_file) {
      return deny(c, `the phone on file for ${id} can't be changed here; it's used to verify payment changes`, 'supplier', id);
    }
    const row = { id, name, email_domain, phone_on_file, crs_ref, status, created_at: before ? before.created_at : ctx.timestamp };
    if (before) ctx.db.supplier.id.update(row); else ctx.db.supplier.insert(row);
    audit(c, 'supplier', id, before, row);
    return ok();
  });
}

export function upsert_supplier_contact(ctx: Ctx, sender: Identity, request_id: string,
  id: string, supplier_id: string, name: string, email: string, phone: string, title: string, pre_established: boolean): Result {
  return handle(ctx, sender, 'upsert_supplier_contact', request_id, ['sync', 'admin'], c => {
    if (!ctx.db.supplier.id.find(supplier_id)) return invalid(`supplier ${supplier_id} not found`);
    const before = ctx.db.supplier_contact.id.find(id);
    if (before) {
      // A trusted contact is what payee changes are verified against, so it can't be rewritten or newly promoted.
      if (!before.pre_established && pre_established) {
        return deny(c, "an existing contact can't be promoted to pre-established", 'supplier_contact', id);
      }
      if (before.pre_established && (before.email !== email || before.phone !== phone || before.supplier_id !== supplier_id || !pre_established)) {
        return deny(c, "a pre-established contact's email, phone and supplier can't be changed", 'supplier_contact', id);
      }
    }
    const row = { id, supplier_id, name, email, phone, title, pre_established };
    if (before) ctx.db.supplier_contact.id.update(row); else ctx.db.supplier_contact.insert(row);
    audit(c, 'supplier_contact', id, before, row);
    return ok();
  });
}

export function add_payee_profile(ctx: Ctx, sender: Identity, request_id: string,
  id: string, supplier_id: string, version: number, account_ref: string, last4: string, bank_name: string, requested_via: string): Result {
  return handle(ctx, sender, 'add_payee_profile', request_id, ['sync', 'agent', 'admin'], c => {
    const err = firstErr(oneOf(requested_via, ['seed', 'email', 'portal'], 'requested_via'),
      id === `${supplier_id}:v${version}` ? null : `id must be '${supplier_id}:v${version}'`);
    if (err) return invalid(err);
    if (!ctx.db.supplier.id.find(supplier_id)) return invalid(`supplier ${supplier_id} not found`);
    const existing = ctx.db.payee_profile.id.find(id);
    if (existing) {
      const same = existing.supplier_id === supplier_id && existing.version === version && existing.account_ref === account_ref
        && existing.last4 === last4 && existing.bank_name === bank_name && existing.requested_via === requested_via;
      if (same) return { outcome: 'duplicate', message: 'payee profile exists' };
      return deny(c, 'payee profiles are immutable; add a new version', 'payee_profile', id);
    }

    const seedVerified = c.role === 'admin' && requested_via === 'seed';
    if (seedVerified && currentVerifiedProfile(ctx, supplier_id)) {
      return deny(c, `${supplier_id} already has a verified payee; changes go through verification`, 'payee_profile', id);
    }
    const row = {
      id, supplier_id, version, account_ref, last4, bank_name, status: seedVerified ? 'verified' : 'pending',
      requested_via, verified_by_role: seedVerified ? 'admin' : '', verified_via_contact_id: '', created_at: ctx.timestamp,
    };
    ctx.db.payee_profile.insert(row);
    audit(c, 'payee_profile', id, null, { ...row, account_ref: `…${last4}` });

    if (!seedVerified) {
      for (const inv of [...ctx.db.invoice.supplier_id.filter(supplier_id)]) {
        if (inv.payment_status === 'settled') continue;
        touchInvoice(c, inv.id, { payee_status: 'change_pending', next_owner_role: 'owner',
          next_action: 'Verify the payee change through a contact already on file' }, 'payee change requested');
        if (inv.active_revision_id) {
          moduleHold(c, inv.active_revision_id, 'PAYEE_CHANGE_PENDING', 0n,
            `New bank account ending ${last4} requested via ${requested_via}; not verified`, json({ payee_profile_id: id }));
        }
      }
    }
    return ok();
  });
}

export function record_document(ctx: Ctx, sender: Identity, request_id: string,
  id: string, kind: string, source_file_id: string, sha256: string, filename: string, pages: number): Result {
  return handle(ctx, sender, 'record_document', request_id, ['sync'], c => {
    const err = oneOf(kind, DOC_KINDS, 'kind');
    if (err) return invalid(err);
    const before = ctx.db.document.id.find(id);
    if (before) {
      if (before.sha256 !== sha256) return deny(c, `document ${id} already exists with different contents`, 'document', id);
      return { outcome: 'duplicate', message: 'document exists' };
    }
    const row = { id, kind, source_file_id, sha256, filename, pages, status: 'received', created_at: ctx.timestamp };
    ctx.db.document.insert(row);
    audit(c, 'document', id, null, row);
    return ok();
  });
}

export function add_fragment(ctx: Ctx, sender: Identity, request_id: string,
  id: string, document_id: string, page: number, email_message_id: string, line_start: number, line_end: number, text: string): Result {
  return handle(ctx, sender, 'add_fragment', request_id, ['sync', 'agent'], c => {
    if (!ctx.db.document.id.find(document_id)) return invalid(`document ${document_id} not found`);
    if (line_end < line_start) return invalid('line_end must be at or after line_start');
    const before = ctx.db.source_fragment.id.find(id);
    if (before) {
      if (before.text === text && before.document_id === document_id) return { outcome: 'duplicate', message: 'fragment exists' };
      return deny(c, `source fragment ${id} is immutable`, 'source_fragment', id);
    }
    const row = { id, document_id, page, email_message_id, line_start, line_end, text, created_at: ctx.timestamp };
    ctx.db.source_fragment.insert(row);
    audit(c, 'source_fragment', id, null, row);
    return ok();
  });
}

export function record_email(ctx: Ctx, sender: Identity, request_id: string,
  id: string, thread_id: string, document_id: string, from_address: string, to_addresses: string, subject: string,
  original_sent_at_iso: string, ingested_at_iso: string, body_fragment_id: string): Result {
  return handle(ctx, sender, 'record_email', request_id, ['sync'], c => {
    if (ctx.db.email_message.id.find(id)) return { outcome: 'duplicate', message: 'email exists' };
    const from = from_address.trim().toLowerCase();
    // Exact match against known contacts only. A lookalike domain is not a known contact.
    const from_known_contact = [...ctx.db.supplier_contact.iter()].some(sc => sc.email.trim().toLowerCase() === from);
    const row = { id, thread_id, document_id, from_address, to_addresses, subject, original_sent_at_iso, ingested_at_iso,
      body_fragment_id, from_known_contact };
    ctx.db.email_message.insert(row);
    audit(c, 'email_message', id, null, row);
    return ok();
  });
}

export function record_extraction_run(ctx: Ctx, sender: Identity, request_id: string,
  id: string, document_id: string, mode: string, model: string, prompt_version: string, status: string, error: string, fields_json: string): Result {
  return handle(ctx, sender, 'record_extraction_run', request_id, ['agent'], c => {
    const err = firstErr(oneOf(mode, EXTRACTION_MODES, 'mode'), oneOf(status, EXTRACTION_STATUS, 'status'));
    if (err) return invalid(err);
    const doc = ctx.db.document.id.find(document_id);
    if (!doc) return invalid(`document ${document_id} not found`);
    if (ctx.db.extraction_run.id.find(id)) return { outcome: 'duplicate', message: 'extraction run exists' };
    const row = { id, document_id, mode, model, prompt_version, status, error, fields_json, created_at: ctx.timestamp };
    ctx.db.extraction_run.insert(row);
    audit(c, 'extraction_run', id, null, row);
    const docStatus = status === 'ok' ? 'extracted' : status === 'invalid' ? 'needs_review' : 'failed';
    ctx.db.document.id.update({ ...doc, status: docStatus });
    audit(c, 'document', document_id, { status: doc.status }, { status: docStatus });
    return ok();
  });
}

export function upsert_purchase(ctx: Ctx, sender: Identity, request_id: string,
  id: string, supplier_id: string, project_id: string, description: string, unit: string, po_number: string,
  quote_document_id: string, po_document_id: string, status: string): Result {
  return handle(ctx, sender, 'upsert_purchase', request_id, ['sync', 'agent'], c => {
    const err = oneOf(status, PURCHASE_STATUS, 'status');
    if (err) return invalid(err);
    if (!ctx.db.supplier.id.find(supplier_id)) return invalid(`supplier ${supplier_id} not found`);
    const before = ctx.db.purchase.id.find(id);
    const row = { id, supplier_id, project_id, description, unit, currency: 'USD', po_number, quote_document_id, po_document_id,
      status, created_at: before ? before.created_at : ctx.timestamp };
    if (before) ctx.db.purchase.id.update(row); else ctx.db.purchase.insert(row);
    audit(c, 'purchase', id, before, row);
    return ok();
  });
}

export function record_term(ctx: Ctx, sender: Identity, request_id: string,
  id: string, purchase_id: string, code: string, label: string, amount_cents: bigint, quantity_milli: bigint, text: string,
  scope_json: string, effective_from: string, effective_to: string, status: string, source_fragment_ids_json: string, version: number): Result {
  return handle(ctx, sender, 'record_term', request_id, ['sync', 'agent'], c => {
    const err = firstErr(oneOf(code, TERM_CODES, 'code'), oneOf(status, TERM_STATUS, 'status'),
      nonNeg(amount_cents, 'amount_cents'), nonNeg(quantity_milli, 'quantity_milli'),
      missingFragments(ctx, source_fragment_ids_json));
    if (err) return invalid(err);
    if (!ctx.db.purchase.id.find(purchase_id)) return invalid(`purchase ${purchase_id} not found`);
    const before = ctx.db.term.id.find(id);
    if (before && before.version > version) return invalid(`term ${id} is already at version ${before.version}`);
    const row = { id, purchase_id, code, label, amount_cents, quantity_milli, text, scope_json, effective_from, effective_to,
      status, source_fragment_ids_json, version };
    if (before) ctx.db.term.id.update(row); else ctx.db.term.insert(row);
    audit(c, 'term', id, before, row);
    return ok();
  });
}

export function record_deposit(ctx: Ctx, sender: Identity, request_id: string,
  id: string, purchase_id: string, supplier_id: string, amount_cents: bigint, status: string, transfer_ref: string): Result {
  return handle(ctx, sender, 'record_deposit', request_id, ['sync', 'gateway'], c => {
    const err = firstErr(oneOf(status, ['approved', 'settled'], 'status'), amount_cents > 0n ? null : 'amount_cents must be above zero');
    if (err) return invalid(err);
    const before = ctx.db.deposit.id.find(id);
    if (before && before.amount_cents !== amount_cents) return deny(c, `deposit ${id} amount can't change`, 'deposit', id);
    if (before && before.status === 'settled' && status !== 'settled') return deny(c, `deposit ${id} is already settled`, 'deposit', id);
    const row = { id, purchase_id, supplier_id, amount_cents, status, transfer_ref, approved_by_role: before?.approved_by_role || c.role,
      created_at: before ? before.created_at : ctx.timestamp };
    if (before) ctx.db.deposit.id.update(row); else ctx.db.deposit.insert(row);
    audit(c, 'deposit', id, before, row);
    return ok();
  });
}

// ======================= Amendments (A) =======================

export function propose_change_request(ctx: Ctx, sender: Identity, request_id: string,
  id: string, purchase_id: string, kind: string, description: string, amount_cents: bigint, rate_cents: bigint, rate_unit: string,
  scope_json: string, effective_from: string, original_sent_at_iso: string, ingested_at_iso: string, classification: string,
  supplier_acceptance: string, source_fragment_ids_json: string): Result {
  return handle(ctx, sender, 'propose_change_request', request_id, ['agent', 'sync', 'purchasing'], c => {
    const err = firstErr(oneOf(kind, CR_KINDS, 'kind'), oneOf(classification, CR_CLASSIFICATIONS, 'classification'),
      oneOf(supplier_acceptance, SUPPLIER_ACCEPTANCE, 'supplier_acceptance'),
      nonNeg(amount_cents, 'amount_cents'), nonNeg(rate_cents, 'rate_cents'), missingFragments(ctx, source_fragment_ids_json),
      AUTHORISED.includes(classification)
        ? "a new change request can't be authorised; only the in-app decision and supplier acceptance make it so" : null,
      rate_cents > 0n && !rate_unit ? 'a rate needs a unit' : null,
      parseScope(scope_json) ? null : 'scope_json must be a JSON object');
    if (err) return invalid(err);
    if (!ctx.db.purchase.id.find(purchase_id)) return invalid(`purchase ${purchase_id} not found`);
    if (ctx.db.change_request.id.find(id)) return { outcome: 'duplicate', message: 'change request exists' };
    const row = {
      id, purchase_id, kind, description, amount_cents, rate_cents, rate_unit, scope_json, effective_from,
      original_sent_at_iso, ingested_at_iso, classification, supplier_acceptance, supplier_acceptance_fragment_ids_json: '[]',
      requested_by_identity: c.sender_hex, internal_status: 'pending', decided_by_identity: '', decided_by_role: '',
      decision_note: '', source_fragment_ids_json, created_at: ctx.timestamp,
    };
    ctx.db.change_request.insert(row);
    audit(c, 'change_request', id, null, row);
    return ok();
  });
}

export function record_supplier_acceptance(ctx: Ctx, sender: Identity, request_id: string,
  change_request_id: string, supplier_acceptance: string, fragment_ids_json: string): Result {
  return handle(ctx, sender, 'record_supplier_acceptance', request_id, ['agent', 'sync'], c => {
    const err = firstErr(oneOf(supplier_acceptance, SUPPLIER_ACCEPTANCE, 'supplier_acceptance'), missingFragments(ctx, fragment_ids_json));
    if (err) return invalid(err);
    const cr = ctx.db.change_request.id.find(change_request_id);
    if (!cr) return invalid(`change request ${change_request_id} not found`);
    if (supplier_acceptance === 'accepted' && (parseIds(fragment_ids_json) ?? []).length === 0) {
      return invalid('an acceptance needs the source fragment that shows it');
    }
    const after = { ...cr, supplier_acceptance, supplier_acceptance_fragment_ids_json: fragment_ids_json };
    after.classification = classify(after);
    ctx.db.change_request.id.update(after);
    audit(c, 'change_request', cr.id, { supplier_acceptance: cr.supplier_acceptance, classification: cr.classification },
      { supplier_acceptance, fragment_ids_json, classification: after.classification });
    return ok();
  });
}

function parseScope(scope_json: string): Record<string, unknown> | null {
  try { const v = JSON.parse(scope_json || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}

type ChangeRequest = NonNullable<ReturnType<Ctx['db']['change_request']['id']['find']>>;
type Purchase = NonNullable<ReturnType<Ctx['db']['purchase']['id']['find']>>;

/** The stored classification follows the decision records; only they can make a change authorised. */
function classify(cr: ChangeRequest): string {
  if (cr.internal_status === 'rejected' || cr.supplier_acceptance === 'declined') return 'DECLINED';
  if (cr.internal_status === 'approved' && cr.supplier_acceptance === 'accepted') {
    return cr.kind === 'extra_charge' && cr.rate_cents > 0n ? 'AUTHORISED_RATE_USAGE_MISSING' : 'AUTHORISED_FIXED';
  }
  return AUTHORISED.includes(cr.classification) ? 'PROPOSED' : cr.classification;
}

/** §9.8.1 worst case: the latest accepted max_quantity minus the material quantity already paid for. Null = no ceiling. */
function remainingCeiling(ctx: Ctx, purchase: Purchase): bigint | null {
  let ceiling: { version: number; quantity_milli: bigint } | null = null;
  for (const t of [...ctx.db.term.iter()]) {
    if (t.purchase_id !== purchase.id || t.code !== 'max_quantity' || t.status !== 'accepted') continue;
    if (!ceiling || t.version > ceiling.version) ceiling = t;
  }
  if (!ceiling) return null;
  // Only settled invoices use quantity up: an unscoped price change could still reach one that's billed but unpaid.
  let paid = 0n;
  for (const inv of [...ctx.db.invoice.iter()]) {
    if (inv.purchase_id !== purchase.id || inv.payment_status !== 'settled' || !inv.active_revision_id) continue;
    for (const l of [...ctx.db.invoice_line.revision_id.filter(inv.active_revision_id)]) {
      if (l.kind === 'material' && l.unit === purchase.unit) paid += l.quantity_milli;
    }
  }
  const left = ceiling.quantity_milli - paid;
  return left > 0n ? left : 0n;
}

/** Money an approval commits (§9.8.1): a fixed amount plus rate × quantity, rounded up. Null = can't be sized. */
function changeRequestExposure(ctx: Ctx, cr: ChangeRequest, purchase: Purchase): { cents: bigint | null; why: string } {
  if (cr.rate_cents === 0n) return { cents: cr.amount_cents, why: '' };
  const scope = parseScope(cr.scope_json) ?? {};
  const unit = typeof scope.unit === 'string' && scope.unit ? scope.unit : purchase.unit;
  if (unit !== cr.rate_unit) return { cents: null, why: `the rate is per ${cr.rate_unit} but the quantity is in ${unit}` };
  let qty: bigint | null = null;
  const q = scope.quantity_milli;
  if (q === undefined || q === null) {
    qty = remainingCeiling(ctx, purchase); // worst case: the rest of the PO
    if (qty === null) return { cents: null, why: 'no scoped quantity and no accepted max_quantity term' };
  } else {
    try { qty = typeof q === 'number' || typeof q === 'string' ? BigInt(q) : null; } catch { qty = null; }
    if (qty === null || qty < 0n) return { cents: null, why: 'scope_json.quantity_milli is not a whole number of thousandths' };
  }
  return { cents: cr.amount_cents + (cr.rate_cents * qty + 999n) / 1000n, why: '' };
}

export function decide_change_request(ctx: Ctx, sender: Identity, request_id: string, id: string, approve: boolean, note: string): Result {
  return handle(ctx, sender, 'decide_change_request', request_id, ['purchasing', 'owner'], c => {
    const cr = ctx.db.change_request.id.find(id);
    if (!cr) return invalid(`change request ${id} not found`);
    if (cr.internal_status !== 'pending') return invalid(`change request ${id} is already ${cr.internal_status}`);
    if (cr.requested_by_identity === c.sender_hex) return deny(c, "you can't decide a change you requested", 'change_request', id);
    const purchase = ctx.db.purchase.id.find(cr.purchase_id);
    if (!purchase) return invalid(`purchase ${cr.purchase_id} not found`);
    // Fail safe: no authority row means no purchasing authority, for the owner too.
    const auth = ctx.db.authority.identity.find(sender);
    if (!auth || (auth.project_scope !== '*' && auth.project_scope !== purchase.project_id)) {
      return deny(c, `no purchasing authority on ${purchase.project_id}`, 'change_request', id);
    }
    if (approve) {
      const exposure = changeRequestExposure(ctx, cr, purchase);
      if (exposure.cents === null) {
        return deny(c, `can't size this change (${exposure.why}); scope it to a quantity first`, 'change_request', id);
      }
      if (auth.limit_cents === 0n || exposure.cents > auth.limit_cents) {
        return deny(c, `above your approval limit: ${exposure.cents} cents > ${auth.limit_cents} cents`, 'change_request', id);
      }
    }
    const after = { ...cr, internal_status: approve ? 'approved' : 'rejected', decided_by_identity: c.sender_hex,
      decided_by_role: c.role, decision_note: note };
    after.classification = classify(after);
    ctx.db.change_request.id.update(after);
    audit(c, 'change_request', id, { internal_status: cr.internal_status, classification: cr.classification },
      { internal_status: after.internal_status, classification: after.classification }, note);
    return ok();
  });
}

// ======================= Invoices and assessment (A) =======================

export function record_invoice(ctx: Ctx, sender: Identity, request_id: string,
  id: string, supplier_id: string, purchase_id: string, invoice_number: string, invoice_date: string, due_date: string, currency: string): Result {
  return handle(ctx, sender, 'record_invoice', request_id, ['sync', 'agent'], c => {
    if (!ctx.db.supplier.id.find(supplier_id)) return invalid(`supplier ${supplier_id} not found`);
    if (currency !== 'USD') return invalid('only USD invoices are supported');
    if (ctx.db.invoice.id.find(id)) return { outcome: 'duplicate', message: 'invoice exists' };
    const profiles = [...ctx.db.payee_profile.supplier_id.filter(supplier_id)];
    const payee_status = profiles.some(p => p.status === 'pending') ? 'change_pending'
      : profiles.some(p => p.status === 'verified') ? 'verified' : 'unverified';
    const row = {
      id, supplier_id, purchase_id, invoice_number, invoice_date, due_date, currency, active_revision_id: '',
      commercial_status: 'pending', receipt_status: 'required', payee_status, approval_status: 'none',
      payment_status: 'not_ready', next_owner_role: 'agent', next_action: 'Check the invoice against what was agreed',
      updated_at: ctx.timestamp,
    };
    ctx.db.invoice.insert(row);
    audit(c, 'invoice', id, null, row);
    const wi = {
      id: `wi_${id}`, kind: 'supplier_invoice', entity_id: id, origin: 'inbox', state: 'new',
      summary: `Invoice ${invoice_number}`, risk_level: 'low', created_at: ctx.timestamp, updated_at: ctx.timestamp,
    };
    if (!ctx.db.work_item.id.find(wi.id)) { ctx.db.work_item.insert(wi); audit(c, 'work_item', wi.id, null, wi); }
    return ok();
  });
}

export function record_invoice_revision(ctx: Ctx, sender: Identity, request_id: string,
  id: string, invoice_id: string, revision: number, document_id: string, gross_cents: bigint, deposit_shown_cents: bigint,
  balance_requested_cents: bigint, supersedes_revision_id: string): Result {
  return handle(ctx, sender, 'record_invoice_revision', request_id, ['sync', 'agent'], c => {
    const err = firstErr(nonNeg(gross_cents, 'gross_cents'), nonNeg(deposit_shown_cents, 'deposit_shown_cents'),
      nonNeg(balance_requested_cents, 'balance_requested_cents'));
    if (err) return invalid(err);
    const inv = ctx.db.invoice.id.find(invoice_id);
    if (!inv) return invalid(`invoice ${invoice_id} not found`);
    if (ctx.db.invoice_revision.id.find(id)) return { outcome: 'duplicate', message: 'revision exists' };
    if ((supersedes_revision_id || '') !== (inv.active_revision_id || '')) {
      return invalid(inv.active_revision_id
        ? `supersedes_revision_id must be the active revision (${inv.active_revision_id})`
        : 'the first revision supersedes nothing');
    }
    const old = supersedes_revision_id ? ctx.db.invoice_revision.id.find(supersedes_revision_id) : null;
    if (old && revision <= old.revision) return invalid(`revision must be above ${old.revision}`);

    const row = { id, invoice_id, revision, document_id, gross_cents, deposit_shown_cents, balance_requested_cents,
      supersedes_revision_id, status: 'active', created_at: ctx.timestamp };
    ctx.db.invoice_revision.insert(row);
    audit(c, 'invoice_revision', id, null, row);

    if (old) {
      ctx.db.invoice_revision.id.update({ ...old, status: 'superseded' });
      audit(c, 'invoice_revision', old.id, { status: old.status }, { status: 'superseded' }, `superseded by ${id}`);
      for (const h of openHolds(ctx, old.id)) {
        closeHold(c, h.id, 'superseded', `superseded by revision ${id}`);
        // A correction doesn't prove receipt, verify a bank account or clear a risk flag: carry those holds forward.
        if (CARRY_OVER_HOLDS.includes(h.code)) {
          moduleHold(c, id, h.code, h.amount_cents, h.reason, h.evidence_json);
        }
      }
      for (const ap of activeApprovalsForInvoice(ctx, invoice_id)) makeStale(c, ap.id, 'revision superseded');
    }
    // A payee change still pending applies to every new revision too.
    for (const p of [...ctx.db.payee_profile.supplier_id.filter(inv.supplier_id)]) {
      if (p.status === 'pending') {
        moduleHold(c, id, 'PAYEE_CHANGE_PENDING', 0n,
          `New bank account ending ${p.last4} requested via ${p.requested_via}; not verified`, json({ payee_profile_id: p.id }));
      }
    }
    touchInvoice(c, invoice_id, { active_revision_id: id, commercial_status: 'pending', next_owner_role: 'agent',
      next_action: old ? 'Check the corrected invoice' : 'Check the invoice against what was agreed',
      ...(inv.payment_status === 'ready' ? { payment_status: 'not_ready' } : {}) });
    const wi = ctx.db.work_item.id.find(`wi_${invoice_id}`);
    if (wi && old && !['paying', 'paid'].includes(wi.state)) setItemState(c, wi.id, 'investigating', `new revision ${id}`);
    return ok();
  });
}

export function record_invoice_line(ctx: Ctx, sender: Identity, request_id: string,
  id: string, revision_id: string, kind: string, description: string, quantity_milli: bigint, unit: string,
  unit_price_cents: bigint, amount_cents: bigint, linked_term_id: string, linked_change_request_id: string,
  source_fragment_ids_json: string): Result {
  return handle(ctx, sender, 'record_invoice_line', request_id, ['sync', 'agent'], c => {
    const err = firstErr(oneOf(kind, LINE_KINDS, 'kind'), nonNeg(quantity_milli, 'quantity_milli'),
      nonNeg(unit_price_cents, 'unit_price_cents'), missingFragments(ctx, source_fragment_ids_json));
    if (err) return invalid(err);
    const row = { id, revision_id, kind, description, quantity_milli, unit, unit_price_cents, amount_cents,
      linked_term_id, linked_change_request_id, source_fragment_ids_json };
    const before = ctx.db.invoice_line.id.find(id);
    if (before) {
      const same = (Object.keys(row) as (keyof typeof row)[]).every(k => before[k] === row[k]);
      if (same) return { outcome: 'duplicate', message: 'line exists' };
      return deny(c, 'invoice lines are immutable; record a corrected revision', 'invoice_line', id);
    }
    const rev = ctx.db.invoice_revision.id.find(revision_id);
    if (!rev) return invalid(`revision ${revision_id} not found`);
    if (rev.status !== 'active') return invalid(`revision ${revision_id} is superseded`);
    if (quantity_milli > 0n && unit_price_cents > 0n) {
      const product = quantity_milli * unit_price_cents;
      if (product % 1000n !== 0n || product / 1000n !== amount_cents) {
        return invalid(`line math doesn't hold: ${quantity_milli} × ${unit_price_cents} / 1000 ≠ ${amount_cents}`);
      }
    }
    ctx.db.invoice_line.insert(row);
    audit(c, 'invoice_line', id, null, row);
    return ok();
  });
}

export function record_assessment(ctx: Ctx, sender: Identity, request_id: string,
  id: string, revision_id: string, version: number, fingerprint: string, policy_version: string, claimed_cents: bigint,
  authorised_cents: bigint, pending_cents: bigint, variance_cents: bigint, deposit_available_cents: bigint,
  proposed_payment_cents: bigint, commercial_status: string, summary: string, details_json: string, next_action: string): Result {
  return handle(ctx, sender, 'record_assessment', request_id, ['agent'], c => {
    const err = firstErr(oneOf(commercial_status, COMMERCIAL_STATUS, 'commercial_status'),
      fingerprint ? null : 'fingerprint is required', nonNeg(proposed_payment_cents, 'proposed_payment_cents'));
    if (err) return invalid(err);
    const rev = ctx.db.invoice_revision.id.find(revision_id);
    if (!rev) return invalid(`revision ${revision_id} not found`);
    if (ctx.db.assessment.id.find(id)) return { outcome: 'duplicate', message: 'assessment exists' };
    const prev = latestAssessment(ctx, revision_id);
    if (prev && version <= prev.version) return invalid(`version must be above ${prev.version}`);
    const row = { id, revision_id, version, fingerprint, policy_version, claimed_cents, authorised_cents, pending_cents,
      variance_cents, deposit_available_cents, proposed_payment_cents, commercial_status, summary, details_json, next_action,
      created_at: ctx.timestamp };
    ctx.db.assessment.insert(row);
    audit(c, 'assessment', id, null, row, summary);
    const inv = ctx.db.invoice.id.find(rev.invoice_id);
    if (inv && inv.active_revision_id === revision_id) {
      // Who acts next: once the commercial terms match, the remaining gap is usually receipt.
      const next_owner_role = commercial_status === 'matches' && inv.receipt_status === 'required' ? 'receiver' : inv.next_owner_role;
      touchInvoice(c, inv.id, { commercial_status, next_action, next_owner_role });
      for (const ap of activeApprovalsForInvoice(ctx, inv.id)) {
        if (ap.assessment_fingerprint !== fingerprint) makeStale(c, ap.id, 'assessment changed');
      }
    }
    return ok();
  });
}

export function open_hold(ctx: Ctx, sender: Identity, request_id: string,
  id: string, revision_id: string, code: string, amount_cents: bigint, reason: string, evidence_json: string): Result {
  return handle(ctx, sender, 'open_hold', request_id, ['agent', 'sync'], c => {
    const err = firstErr(oneOf(code, HOLD_CODES, 'code'), nonNeg(amount_cents, 'amount_cents'), reason ? null : 'reason is required');
    if (err) return invalid(err);
    const rev = ctx.db.invoice_revision.id.find(revision_id);
    if (!rev) return invalid(`revision ${revision_id} not found`);
    if (rev.status !== 'active') return invalid(`revision ${revision_id} is superseded`);
    if (ctx.db.hold.id.find(id)) return { outcome: 'duplicate', message: 'hold exists' };
    openHoldRow(c, id, revision_id, code, amount_cents, reason, evidence_json);
    const inv = ctx.db.invoice.id.find(rev.invoice_id);
    if (inv && inv.payment_status === 'ready') touchInvoice(c, inv.id, { payment_status: 'not_ready' }, `hold ${code} opened`);
    return ok();
  });
}

export function resolve_hold(ctx: Ctx, sender: Identity, request_id: string, id: string, note: string): Result {
  return handle(ctx, sender, 'resolve_hold', request_id, ['owner'], c => {
    const h = ctx.db.hold.id.find(id);
    if (!h) return invalid(`hold ${id} not found`);
    if (h.status !== 'open') return invalid(`hold ${id} is ${h.status}`);
    if (!note.trim()) return invalid('a note is required to resolve a hold');
    if (!OWNER_RESOLVABLE_HOLDS.includes(h.code)) {
      const how = h.code === 'RECEIPT_NOT_VERIFIED' ? 'the receiver attesting receipt'
        : h.code === 'PAYEE_CHANGE_PENDING' ? 'verifying the payee through a contact on file'
          : 'a new payment approval';
      return deny(c, `${h.code} can only be cleared by ${how}`, 'hold', id);
    }
    closeHold(c, id, 'resolved', note);
    return ok();
  });
}

// ======================= People in the loop (A) =======================

export function attest_receipt(ctx: Ctx, sender: Identity, request_id: string,
  id: string, invoice_id: string, scope: string, quantity_milli: bigint, unit: string, reason: string): Result {
  return handle(ctx, sender, 'attest_receipt', request_id, ['receiver'], c => {
    const err = firstErr(quantity_milli > 0n ? null : 'quantity_milli must be above zero', reason.trim() ? null : 'reason is required',
      unit ? null : 'unit is required');
    if (err) return invalid(err);
    const inv = ctx.db.invoice.id.find(invoice_id);
    if (!inv) return invalid(`invoice ${invoice_id} not found`);
    if (ctx.db.receipt_attestation.id.find(id)) return { outcome: 'duplicate', message: 'attestation exists' };
    const row = { id, invoice_id, scope, quantity_milli, unit, reason, label: 'MANUALLY_CONFIRMED',
      attested_by_identity: c.sender_hex, attested_by_role: c.role, created_at: ctx.timestamp };
    ctx.db.receipt_attestation.insert(row);
    audit(c, 'receipt_attestation', id, null, row);

    if (!inv.active_revision_id) return ok('recorded; no active revision to check against yet');
    let attested = 0n, billed = 0n;
    for (const a of [...ctx.db.receipt_attestation.invoice_id.filter(invoice_id)]) if (a.unit === unit) attested += a.quantity_milli;
    for (const l of [...ctx.db.invoice_line.revision_id.filter(inv.active_revision_id)]) {
      if (l.kind === 'material' && l.unit === unit) billed += l.quantity_milli;
    }
    if (billed > 0n && attested >= billed) {
      for (const h of openHolds(ctx, inv.active_revision_id)) {
        if (h.code === 'RECEIPT_NOT_VERIFIED') closeHold(c, h.id, 'resolved', `receipt attested: ${attested} ${unit} (milli)`);
      }
      touchInvoice(c, invoice_id, { receipt_status: 'manually_confirmed' }, 'receipt attested');
      return ok();
    }
    return ok(`recorded; attested ${attested} of ${billed} ${unit} (milli) billed`);
  });
}

export function decide_payee_profile(ctx: Ctx, sender: Identity, request_id: string,
  id: string, approve: boolean, verified_via_contact_id: string, note: string): Result {
  return handle(ctx, sender, 'decide_payee_profile', request_id, ['owner'], c => {
    const p = ctx.db.payee_profile.id.find(id);
    if (!p) return invalid(`payee profile ${id} not found`);
    if (p.status !== 'pending') return invalid(`payee profile ${id} is ${p.status}`);
    // Approving or rejecting (§9.8.3), the call goes to a contact that was on file before the request.
    const contact = ctx.db.supplier_contact.id.find(verified_via_contact_id);
    if (!contact || contact.supplier_id !== p.supplier_id || !contact.pre_established) {
      return deny(c, 'verify through a contact that was on file before this request (pre-established), never one from the request',
        'payee_profile', id);
    }
    if (approve) {
      const old = currentVerifiedProfile(ctx, p.supplier_id);
      if (old) {
        ctx.db.payee_profile.id.update({ ...old, status: 'superseded' });
        audit(c, 'payee_profile', old.id, { status: 'verified' }, { status: 'superseded' }, `replaced by ${id}`);
        for (const ap of [...ctx.db.payment_approval.iter()]) {
          if (ap.status === 'active' && ap.payee_profile_id === old.id) makeStale(c, ap.id, 'payee profile changed');
        }
      }
      ctx.db.payee_profile.id.update({ ...p, status: 'verified', verified_by_role: c.role, verified_via_contact_id });
      audit(c, 'payee_profile', id, { status: 'pending' }, { status: 'verified', verified_via_contact_id }, note);
    } else {
      ctx.db.payee_profile.id.update({ ...p, status: 'rejected', verified_via_contact_id });
      audit(c, 'payee_profile', id, { status: 'pending' }, { status: 'rejected', verified_via_contact_id }, note);
    }
    // Once no change is pending for this supplier, PAYEE_CHANGE_PENDING clears; the invoice payee status follows what's left.
    const stillPending = [...ctx.db.payee_profile.supplier_id.filter(p.supplier_id)].some(x => x.status === 'pending');
    if (stillPending) return ok();
    const hasVerified = !!currentVerifiedProfile(ctx, p.supplier_id);
    const resolution = note || (approve ? `payee change verified via ${contact.name}` : `payee change rejected after calling ${contact.name}`);
    for (const inv of [...ctx.db.invoice.supplier_id.filter(p.supplier_id)]) {
      if (inv.payment_status === 'settled') continue;
      if (inv.active_revision_id) {
        for (const h of openHolds(ctx, inv.active_revision_id)) {
          if (h.code === 'PAYEE_CHANGE_PENDING') closeHold(c, h.id, 'resolved', resolution);
        }
      }
      touchInvoice(c, inv.id, { payee_status: hasVerified ? 'verified' : 'unverified' });
    }
    return ok();
  });
}

// ======================= Clarifications (B) =======================

export function draft_outbox(ctx: Ctx, sender: Identity, request_id: string,
  id: string, invoice_id: string, to_contact_id: string, subject: string, body: string): Result {
  return handle(ctx, sender, 'draft_outbox', request_id, ['agent'], c => {
    const inv = ctx.db.invoice.id.find(invoice_id);
    if (!inv) return invalid(`invoice ${invoice_id} not found`);
    const contact = ctx.db.supplier_contact.id.find(to_contact_id);
    if (!contact || contact.supplier_id !== inv.supplier_id) return invalid("the recipient must be a contact of the invoice's supplier");
    if (ctx.db.outbox.id.find(id)) return { outcome: 'duplicate', message: 'draft exists' };
    const row = { id, invoice_id, to_contact_id, to_address: contact.email, subject, body, status: 'draft', simulated: true,
      created_by_role: c.role, approved_by_role: '', delivery_ref: '', created_at: ctx.timestamp };
    ctx.db.outbox.insert(row);
    audit(c, 'outbox', id, null, row);
    touchInvoice(c, invoice_id, { next_owner_role: 'purchasing', next_action: 'Review and send the clarification to the supplier' });
    return ok();
  });
}

export function approve_outbox(ctx: Ctx, sender: Identity, request_id: string, id: string): Result {
  return handle(ctx, sender, 'approve_outbox', request_id, ['purchasing', 'owner'], c => {
    const o = ctx.db.outbox.id.find(id);
    if (!o) return invalid(`outbox ${id} not found`);
    if (o.status !== 'draft') return invalid(`outbox ${id} is ${o.status}`);
    ctx.db.outbox.id.update({ ...o, status: 'approved', approved_by_role: c.role });
    audit(c, 'outbox', id, { status: 'draft' }, { status: 'approved' });
    insertJob(c, `job_send_${id}`, 'send_outbox', { outbox_id: id });
    touchInvoice(c, o.invoice_id, { next_owner_role: 'supplier', next_action: 'Waiting for the supplier to reply' });
    return ok();
  });
}

export function mark_outbox(ctx: Ctx, sender: Identity, request_id: string, id: string, status: string, delivery_ref: string): Result {
  return handle(ctx, sender, 'mark_outbox', request_id, ['sync'], c => {
    const err = oneOf(status, ['sent', 'failed'], 'status');
    if (err) return invalid(err);
    const o = ctx.db.outbox.id.find(id);
    if (!o) return invalid(`outbox ${id} not found`);
    if (o.status !== 'approved') return deny(c, `outbox ${id} is ${o.status}, not approved`, 'outbox', id);
    ctx.db.outbox.id.update({ ...o, status, delivery_ref });
    audit(c, 'outbox', id, { status: o.status }, { status, delivery_ref });
    return ok();
  });
}

// ======================= Payment (A) =======================

interface SupplierPaymentRef {
  invoice_id: string; revision_id: string; assessment_id: string; deposit_allocation_cents: string; payee_profile_id: string;
}
const refOf = (evidence_json: string): SupplierPaymentRef | null => {
  try { const r = JSON.parse(evidence_json); return r && typeof r.invoice_id === 'string' ? r : null; } catch { return null; }
};

export function propose_supplier_payment(ctx: Ctx, sender: Identity, request_id: string,
  id: string, invoice_id: string, revision_id: string, assessment_id: string, amount_cents: bigint,
  deposit_allocation_cents: bigint, payee_profile_id: string): Result {
  return handle(ctx, sender, 'propose_supplier_payment', request_id, ['agent'], c => {
    const err = firstErr(amount_cents > 0n ? null : 'amount_cents must be above zero', nonNeg(deposit_allocation_cents, 'deposit_allocation_cents'));
    if (err) return invalid(err);
    const inv = ctx.db.invoice.id.find(invoice_id);
    const rev = ctx.db.invoice_revision.id.find(revision_id);
    const a = ctx.db.assessment.id.find(assessment_id);
    const payee = ctx.db.payee_profile.id.find(payee_profile_id);
    if (!inv || !rev || rev.invoice_id !== invoice_id) return invalid('invoice and revision do not match');
    if (!a || a.revision_id !== revision_id) return invalid('assessment is not for this revision');
    if (!payee || payee.supplier_id !== inv.supplier_id) return invalid("payee profile is not the supplier's");
    if (ctx.db.proposal.id.find(id)) return { outcome: 'duplicate', message: 'proposal exists' };
    if (amount_cents !== a.proposed_payment_cents) {
      return deny(c, `amount ${amount_cents} must equal the assessment's proposed payment ${a.proposed_payment_cents}`, 'proposal', id);
    }
    const wi_id = `wi_${invoice_id}`;
    for (const p of [...ctx.db.proposal.work_item_id.filter(wi_id)]) {
      if (p.status === 'pending') {
        ctx.db.proposal.id.update({ ...p, status: 'cancelled', decision_note: `superseded by ${id}` });
        audit(c, 'proposal', p.id, { status: 'pending' }, { status: 'cancelled' }, `superseded by ${id}`);
      }
    }
    const ref: SupplierPaymentRef = { invoice_id, revision_id, assessment_id,
      deposit_allocation_cents: deposit_allocation_cents.toString(), payee_profile_id };
    const row = {
      id, work_item_id: wi_id, kind: 'supplier_payment', amount_cents, payee_sub_id: inv.supplier_id,
      payee_account_ref: payee.account_ref, reason: a.summary, evidence_json: json(ref), status: 'pending',
      proposed_by_role: c.role, proposed_by_identity: c.sender_hex, decided_by_role: '', decided_by_identity: '',
      decision_note: '', created_at: ctx.timestamp, decided_at_iso: '',
    };
    ctx.db.proposal.insert(row);
    audit(c, 'proposal', id, null, { ...row, payee_account_ref: `…${payee.last4}` }, a.summary);
    touchInvoice(c, invoice_id, { next_owner_role: 'owner', next_action: 'Review and approve the payment' });
    const wi = ctx.db.work_item.id.find(wi_id);
    if (wi && [...AGENT_SOURCE_STATES, 'held', 'proposed'].includes(wi.state)) setItemState(c, wi_id, 'proposed', a.summary);
    return ok();
  });
}

/** §9.4's six eligibility rules. Returns the reasons a payment can't go ahead (empty = eligible). */
export function blockedReasons(ctx: Ctx, proposal_id: string, expected_fingerprint: string | null): string[] {
  const p = ctx.db.proposal.id.find(proposal_id);
  const ref = p ? refOf(p.evidence_json) : null;
  if (!p || !ref) return ['proposal not found'];
  const reasons: string[] = [];
  const inv = ctx.db.invoice.id.find(ref.invoice_id);
  if (!inv) return ['invoice not found'];
  // 1. the active revision
  if (inv.active_revision_id !== ref.revision_id) reasons.push('the invoice has a newer revision');
  // 2. no open holds (APPROVAL_STALE is what this approval clears, so it doesn't block it)
  const holds = openHolds(ctx, ref.revision_id).filter(h => h.code !== 'APPROVAL_STALE' || expected_fingerprint === null);
  for (const h of holds) reasons.push(`open hold ${h.code}: ${h.reason}`);
  // 3. receipt
  if (inv.receipt_status !== 'manually_confirmed' && inv.receipt_status !== 'not_required') reasons.push('receipt not attested');
  // 4. the current verified payee
  const verified = currentVerifiedProfile(ctx, inv.supplier_id);
  if (!verified || verified.id !== ref.payee_profile_id) reasons.push("payee is not the supplier's current verified account");
  if (verified && p.payee_account_ref !== verified.account_ref) reasons.push('payee account does not match the verified profile');
  // 5. the latest assessment
  const latest = latestAssessment(ctx, ref.revision_id);
  const fp = expected_fingerprint ?? ctx.db.payment_approval.id.find(`appr_${proposal_id}`)?.assessment_fingerprint ?? '';
  if (!latest || latest.fingerprint !== fp || latest.id !== ref.assessment_id && latest.fingerprint !== fp) {
    reasons.push('the assessment has changed since this was proposed');
  }
  if (latest && latest.proposed_payment_cents !== p.amount_cents) reasons.push('amount differs from the latest assessment');
  // 6. deposit allocation fits
  const alloc = BigInt(ref.deposit_allocation_cents || '0');
  if (alloc > 0n && alloc > depositRemaining(ctx, inv.purchase_id)) reasons.push('deposit allocation exceeds the remaining deposit');
  return reasons;
}

export function approve_supplier_payment(ctx: Ctx, sender: Identity, request_id: string,
  proposal_id: string, expected_fingerprint: string, note: string): Result {
  return handle(ctx, sender, 'approve_supplier_payment', request_id, ['owner'], c => {
    const p = ctx.db.proposal.id.find(proposal_id);
    if (!p || p.kind !== 'supplier_payment') return invalid(`supplier payment proposal ${proposal_id} not found`);
    if (p.proposed_by_identity === c.sender_hex) return deny(c, "you can't approve your own proposal", 'proposal', proposal_id);
    if (p.status !== 'pending') return invalid(`proposal is ${p.status}, not pending`);
    const reasons = blockedReasons(ctx, proposal_id, expected_fingerprint);
    if (reasons.length) return deny(c, JSON.stringify(reasons), 'proposal', proposal_id);

    const ref = refOf(p.evidence_json)!;
    const latest = latestAssessment(ctx, ref.revision_id)!;
    const ap = {
      id: `appr_${proposal_id}`, proposal_id, invoice_id: ref.invoice_id, revision_id: ref.revision_id, amount_cents: p.amount_cents,
      deposit_allocation_cents: BigInt(ref.deposit_allocation_cents || '0'), payee_profile_id: ref.payee_profile_id,
      assessment_fingerprint: latest.fingerprint, policy_version: latest.policy_version, approved_by_identity: c.sender_hex,
      status: 'active', stale_reason: '', created_at: ctx.timestamp,
    };
    const prior = ctx.db.payment_approval.id.find(ap.id);
    if (prior) ctx.db.payment_approval.id.update(ap); else ctx.db.payment_approval.insert(ap);
    audit(c, 'payment_approval', ap.id, prior, ap, note);
    ctx.db.proposal.id.update({ ...p, status: 'approved', decided_by_role: c.role, decided_by_identity: c.sender_hex,
      decision_note: note, decided_at_iso: iso(c) });
    audit(c, 'proposal', proposal_id, { status: 'pending' }, { status: 'approved' }, note);
    for (const h of openHolds(ctx, ref.revision_id)) if (h.code === 'APPROVAL_STALE') closeHold(c, h.id, 'resolved', 'new approval');
    touchInvoice(c, ref.invoice_id, { approval_status: 'approved', payment_status: 'ready', next_owner_role: 'gateway',
      next_action: 'Settle the payment' });
    setItemState(c, p.work_item_id, 'approved', note);
    insertJob(c, `job_pay_${proposal_id}`, 'pay_supplier', { proposal_id });
    return ok();
  });
}

export function reject_supplier_payment(ctx: Ctx, sender: Identity, request_id: string, proposal_id: string, note: string): Result {
  return handle(ctx, sender, 'reject_supplier_payment', request_id, ['owner'], c => {
    const p = ctx.db.proposal.id.find(proposal_id);
    if (!p || p.kind !== 'supplier_payment') return invalid(`supplier payment proposal ${proposal_id} not found`);
    if (p.status !== 'pending') return invalid(`proposal is ${p.status}, not pending`);
    ctx.db.proposal.id.update({ ...p, status: 'rejected', decided_by_role: c.role, decided_by_identity: c.sender_hex,
      decision_note: note, decided_at_iso: iso(c) });
    audit(c, 'proposal', proposal_id, { status: 'pending' }, { status: 'rejected' }, note);
    const ref = refOf(p.evidence_json);
    if (ref) touchInvoice(c, ref.invoice_id, { approval_status: 'rejected', next_owner_role: 'agent', next_action: `Owner rejected: ${note}` });
    setItemState(c, p.work_item_id, 'rejected', note);
    return ok();
  });
}

/** Called by start_payment for supplier payments: re-check every bound value. Returns a denial reason or null. */
export function recheckSupplierApproval(c: Call, proposal_id: string): string | null {
  const ap = c.ctx.db.payment_approval.id.find(`appr_${proposal_id}`);
  if (!ap || ap.status !== 'active') return 'no active approval for this payment';
  const reasons = blockedReasons(c.ctx, proposal_id, ap.assessment_fingerprint);
  const p = c.ctx.db.proposal.id.find(proposal_id);
  if (p && p.amount_cents !== ap.amount_cents) reasons.push('amount changed since approval');
  if (reasons.length) {
    makeStale(c, ap.id, reasons.join('; '));
    return JSON.stringify(reasons);
  }
  return null;
}

/** Called by start_payment / record_payment to keep the invoice's payment status in step. */
export function onSupplierPayment(c: Call, proposal_id: string, phase: 'submitted' | 'settled' | 'failed') {
  const p = c.ctx.db.proposal.id.find(proposal_id);
  const ref = p ? refOf(p.evidence_json) : null;
  if (!ref) return;
  touchInvoice(c, ref.invoice_id, { payment_status: phase,
    next_owner_role: phase === 'settled' ? '' : phase === 'failed' ? 'owner' : 'gateway',
    next_action: phase === 'settled' ? 'Paid' : phase === 'failed' ? 'Payment failed; review' : 'Settling' });
  if (phase === 'settled') {
    const ap = c.ctx.db.payment_approval.id.find(`appr_${proposal_id}`);
    if (ap && ap.status === 'active') {
      c.ctx.db.payment_approval.id.update({ ...ap, status: 'used' });
      audit(c, 'payment_approval', ap.id, { status: 'active' }, { status: 'used' });
    }
  }
}

export function record_deposit_allocation(ctx: Ctx, sender: Identity, request_id: string,
  id: string, deposit_id: string, invoice_id: string, amount_cents: bigint): Result {
  return handle(ctx, sender, 'record_deposit_allocation', request_id, ['gateway'], c => {
    if (amount_cents <= 0n) return invalid('amount_cents must be above zero');
    const d = ctx.db.deposit.id.find(deposit_id);
    if (!d) return invalid(`deposit ${deposit_id} not found`);
    if (d.status !== 'settled') return invalid(`deposit ${deposit_id} is not settled`);
    if (!ctx.db.invoice.id.find(invoice_id)) return invalid(`invoice ${invoice_id} not found`);
    if (ctx.db.deposit_allocation.id.find(id)) return { outcome: 'duplicate', message: 'allocation exists' };
    let used = 0n;
    for (const a of [...ctx.db.deposit_allocation.deposit_id.filter(deposit_id)]) {
      if (a.invoice_id === invoice_id) return invalid(`deposit ${deposit_id} is already applied to invoice ${invoice_id}`);
      used += a.amount_cents;
    }
    if (used + amount_cents > d.amount_cents) {
      return invalid(`allocation would exceed the deposit: ${used} + ${amount_cents} > ${d.amount_cents}`);
    }
    const row = { id, deposit_id, invoice_id, amount_cents, created_at: ctx.timestamp };
    ctx.db.deposit_allocation.insert(row);
    audit(c, 'deposit_allocation', id, null, row);
    return ok();
  });
}
