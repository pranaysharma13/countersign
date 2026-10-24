// Reducer bodies. Each takes (ctx, sender, ...args in CONTRACT order) so tests can call them
// with any identity. index.ts wires them to reducers with ctx.sender.
import { Identity } from 'spacetimedb';
import type { Ctx } from './schema';
import {
  ROLES, SUB_STATUS, PROJECT_STATUS, LIEN_WAIVER_RULES, SOURCE_KINDS, LEDGER_REF_TYPES,
  WORK_KINDS, ORIGINS, STEP_KINDS, CHECK_STATUS, CHECK_SOURCES, CHECK_CODES, HARD_STOP_CHECKS,
  AGENT_TARGET_STATES, AGENT_SOURCE_STATES, PAYMENT_PROPOSE_FROM, HOLD_PROPOSE_FROM,
  JOB_KINDS, PUBLIC_QUEUED_LIMIT,
} from './constants';
import { handle, ok, invalid, deny, audit, oneOf, iso, json, type Call, type Result } from './request';

const nonNeg = (v: bigint, f: string) => (v < 0n ? `${f} can't be negative` : null);
const firstErr = (...errs: (string | null)[]) => errs.find(e => e) ?? null;

function setItemState(c: Call, id: string, state: string, note = '') {
  const wi = c.ctx.db.work_item.id.find(id);
  if (!wi) return;
  const after = { ...wi, state, updated_at: c.ctx.timestamp };
  c.ctx.db.work_item.id.update(after);
  audit(c, 'work_item', id, { state: wi.state }, { state }, note);
}

function insertJob(c: Call, id: string, kind: string, payload: unknown) {
  const row = {
    id, kind, assignee_role: JOB_KINDS[kind].assignee, payload_json: json(payload), status: 'queued',
    requested_by: c.sender_hex, claimed_by: '', result_json: '', error: '',
    created_at: c.ctx.timestamp, updated_at: c.ctx.timestamp,
  };
  c.ctx.db.job.insert(row);
  audit(c, 'job', id, null, row);
}

function failedHardStops(ctx: Ctx, work_item_id: string) {
  return [...ctx.db.check_result.work_item_id.filter(work_item_id)]
    .filter(r => r.status === 'fail' && HARD_STOP_CHECKS.includes(r.check_code));
}

// ======================= 4.1 Setup =======================

export function claim_admin(ctx: Ctx, sender: Identity, request_id: string): Result {
  return handle(ctx, sender, 'claim_admin', request_id, ['*'], c => {
    if ([...ctx.db.actor.iter()].some(a => a.role === 'admin')) return deny(c, 'an admin already exists');
    const row = { identity: sender, role: 'admin', display_name: 'Setup script', created_at: ctx.timestamp };
    const existing = ctx.db.actor.identity.find(sender);
    if (existing) ctx.db.actor.identity.update(row); else ctx.db.actor.insert(row);
    audit(c, 'actor', c.sender_hex, existing ?? null, row);
    return ok();
  });
}

export function register_actor(ctx: Ctx, sender: Identity, request_id: string,
  identity_hex: string, role: string, display_name: string): Result {
  return handle(ctx, sender, 'register_actor', request_id, ['admin'], c => {
    const err = oneOf(role, ROLES.filter(r => r !== 'admin'), 'role');
    if (err) return invalid(err);
    let identity: Identity;
    try { identity = Identity.fromString(identity_hex); } catch { return invalid('identity_hex is not a valid identity'); }
    const row = { identity, role, display_name, created_at: ctx.timestamp };
    const existing = ctx.db.actor.identity.find(identity);
    if (existing?.role === 'admin') return deny(c, "can't change the admin's role", 'actor', identity_hex);
    if (existing) ctx.db.actor.identity.update(row); else ctx.db.actor.insert(row);
    audit(c, 'actor', identity.toHexString(), existing ?? null, row);
    return ok();
  });
}

// ======================= 4.2 Records =======================

export function upsert_company(ctx: Ctx, sender: Identity, request_id: string,
  id: string, name: string, owner_name: string, state: string, bank_account_ref: string, bank_last4: string): Result {
  return handle(ctx, sender, 'upsert_company', request_id, ['sync', 'admin'], c => {
    const row = { id, name, owner_name, state, bank_account_ref, bank_last4 };
    const before = ctx.db.company.id.find(id);
    if (before) ctx.db.company.id.update(row); else ctx.db.company.insert(row);
    audit(c, 'company', id, before, row);
    return ok();
  });
}

export function upsert_project(ctx: Ctx, sender: Identity, request_id: string,
  id: string, name: string, address: string, status: string): Result {
  return handle(ctx, sender, 'upsert_project', request_id, ['sync', 'admin'], c => {
    const err = oneOf(status, PROJECT_STATUS, 'status');
    if (err) return invalid(err);
    const row = { id, name, address, status };
    const before = ctx.db.project.id.find(id);
    if (before) ctx.db.project.id.update(row); else ctx.db.project.insert(row);
    audit(c, 'project', id, before, row);
    return ok();
  });
}

export function upsert_sub(ctx: Ctx, sender: Identity, request_id: string,
  id: string, name: string, trade: string, license_number: string, license_state: string,
  contact_email: string, email_domain: string, phone_on_file: string,
  bank_account_ref: string, bank_last4: string, bank_owner_name: string, crs_ref: string, status: string): Result {
  return handle(ctx, sender, 'upsert_sub', request_id, ['sync', 'admin'], c => {
    const err = oneOf(status, SUB_STATUS, 'status');
    if (err) return invalid(err);
    const before = ctx.db.sub.id.find(id);
    if (before && (before.bank_account_ref !== bank_account_ref || before.bank_last4 !== bank_last4
      || before.bank_owner_name !== bank_owner_name)) {
      // The "quiet bank edit": bank fields only change through an approved, verified bank_change.
      return deny(c, `quiet bank edit blocked: bank details for ${id} can only change through a verified bank change`, 'sub', id);
    }
    const row = {
      id, name, trade, license_number, license_state, contact_email, email_domain, phone_on_file,
      bank_account_ref, bank_last4, bank_owner_name, crs_ref, status,
      created_at: before ? before.created_at : ctx.timestamp,
    };
    if (before) ctx.db.sub.id.update(row); else ctx.db.sub.insert(row);
    audit(c, 'sub', id, before, row);
    return ok();
  });
}

export function upsert_contract(ctx: Ctx, sender: Identity, request_id: string,
  id: string, sub_id: string, project_id: string, title: string, original_value_cents: bigint,
  retainage_bps: number, payment_terms_days: number, lien_waiver_rule: string,
  bank_change_clause: string, source_file_id: string): Result {
  return handle(ctx, sender, 'upsert_contract', request_id, ['sync', 'agent'], c => {
    const err = firstErr(oneOf(lien_waiver_rule, LIEN_WAIVER_RULES, 'lien_waiver_rule'),
      nonNeg(original_value_cents, 'original_value_cents'),
      retainage_bps > 10000 ? 'retainage_bps must be at most 10000' : null);
    if (err) return invalid(err);
    const before = ctx.db.contract.id.find(id);
    if (before?.status === 'confirmed') return deny(c, `contract ${id} is confirmed and can't be edited`, 'contract', id);
    const row = {
      id, sub_id, project_id, title, original_value_cents, retainage_bps, payment_terms_days,
      lien_waiver_rule, bank_change_clause, source_file_id, status: 'draft', confirmed_by_role: '',
    };
    if (before) ctx.db.contract.id.update(row); else ctx.db.contract.insert(row);
    audit(c, 'contract', id, before, row);
    return ok();
  });
}

export function upsert_contract_line(ctx: Ctx, sender: Identity, request_id: string,
  id: string, contract_id: string, code: string, description: string, scheduled_value_cents: bigint): Result {
  return handle(ctx, sender, 'upsert_contract_line', request_id, ['sync', 'agent'], c => {
    const k = ctx.db.contract.id.find(contract_id);
    if (!k) return invalid(`contract ${contract_id} not found`);
    if (k.status === 'confirmed') return deny(c, `contract ${contract_id} is confirmed and can't be edited`, 'contract_line', id);
    const err = nonNeg(scheduled_value_cents, 'scheduled_value_cents');
    if (err) return invalid(err);
    const row = { id, contract_id, code, description, scheduled_value_cents };
    const before = ctx.db.contract_line.id.find(id);
    if (before) ctx.db.contract_line.id.update(row); else ctx.db.contract_line.insert(row);
    audit(c, 'contract_line', id, before, row);
    return ok();
  });
}

export function confirm_contract(ctx: Ctx, sender: Identity, request_id: string, contract_id: string): Result {
  return handle(ctx, sender, 'confirm_contract', request_id, ['owner', 'bookkeeper'], c => {
    const k = ctx.db.contract.id.find(contract_id);
    if (!k) return invalid(`contract ${contract_id} not found`);
    if (k.status === 'confirmed') return invalid(`contract ${contract_id} is already confirmed`);
    const after = { ...k, status: 'confirmed', confirmed_by_role: c.role };
    ctx.db.contract.id.update(after);
    audit(c, 'contract', contract_id, k, after);
    return ok();
  });
}

export function record_source_file(ctx: Ctx, sender: Identity, request_id: string,
  id: string, kind: string, filename: string, sha256: string, received_at_iso: string,
  from_address: string, subject: string, storage_path: string): Result {
  return handle(ctx, sender, 'record_source_file', request_id, ['sync'], c => {
    const err = oneOf(kind, SOURCE_KINDS, 'kind');
    if (err) return invalid(err);
    const row = { id, kind, filename, sha256, received_at_iso, from_address, subject, storage_path };
    const before = ctx.db.source_file.id.find(id);
    if (before) ctx.db.source_file.id.update(row); else ctx.db.source_file.insert(row);
    audit(c, 'source_file', id, before, row);
    return ok();
  });
}

export function record_bill(ctx: Ctx, sender: Identity, request_id: string,
  id: string, sub_id: string, contract_id: string, source_file_id: string, invoice_number: string,
  bill_date: string, due_date: string, period_label: string, amount_cents: bigint, retainage_cents: bigint,
  remit_bank_name: string, remit_account_ref: string, remit_account_last4: string, from_address: string,
  has_lien_waiver: boolean, extracted_json: string): Result {
  return handle(ctx, sender, 'record_bill', request_id, ['sync', 'agent'], c => {
    const err = firstErr(nonNeg(amount_cents, 'amount_cents'), nonNeg(retainage_cents, 'retainage_cents'));
    if (err) return invalid(err);
    const row = {
      id, sub_id, contract_id, source_file_id, invoice_number, bill_date, due_date, period_label,
      amount_cents, retainage_cents, remit_bank_name, remit_account_ref, remit_account_last4,
      from_address, has_lien_waiver, extracted_json,
    };
    const before = ctx.db.bill.id.find(id);
    if (before) ctx.db.bill.id.update(row); else ctx.db.bill.insert(row);
    audit(c, 'bill', id, before, row);
    return ok();
  });
}

export function record_bill_line(ctx: Ctx, sender: Identity, request_id: string,
  id: string, bill_id: string, contract_line_code: string, description: string,
  this_period_cents: bigint, previous_cents: bigint, percent_complete_bps: number): Result {
  return handle(ctx, sender, 'record_bill_line', request_id, ['sync', 'agent'], c => {
    if (!ctx.db.bill.id.find(bill_id)) return invalid(`bill ${bill_id} not found`);
    const row = { id, bill_id, contract_line_code, description, this_period_cents, previous_cents, percent_complete_bps };
    const before = ctx.db.bill_line.id.find(id);
    if (before) ctx.db.bill_line.id.update(row); else ctx.db.bill_line.insert(row);
    audit(c, 'bill_line', id, before, row);
    return ok();
  });
}

export function record_bank_snapshot(ctx: Ctx, sender: Identity, request_id: string,
  id: string, account_ref: string, balance_cents: bigint, as_of_iso: string): Result {
  return handle(ctx, sender, 'record_bank_snapshot', request_id, ['sync', 'gateway'], c => {
    const row = { id, account_ref, balance_cents, as_of_iso };
    const before = ctx.db.bank_snapshot.id.find(id);
    if (before) ctx.db.bank_snapshot.id.update(row); else ctx.db.bank_snapshot.insert(row);
    audit(c, 'bank_snapshot', id, before, row);
    return ok();
  });
}

export function post_journal(ctx: Ctx, sender: Identity, request_id: string,
  journal_id: string, entry_date: string, memo: string, ref_type: string, ref_id: string, lines_json: string): Result {
  return handle(ctx, sender, 'post_journal', request_id, ['sync', 'gateway'], c => {
    const err = oneOf(ref_type, LEDGER_REF_TYPES, 'ref_type');
    if (err) return invalid(err);
    if ([...ctx.db.ledger_line.journal_id.filter(journal_id)].length > 0) return invalid(`journal ${journal_id} already posted`);
    let lines: { account: string; debit_cents: unknown; credit_cents: unknown }[];
    try { lines = JSON.parse(lines_json); } catch { return invalid('lines_json is not valid JSON'); }
    if (!Array.isArray(lines) || lines.length < 2) return invalid('a journal needs at least two lines');
    const toCents = (v: unknown): bigint | null => {
      if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
      if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
      return null;
    };
    let dr = 0n, cr = 0n;
    const parsed = [];
    for (const [i, l] of lines.entries()) {
      const d = toCents(l?.debit_cents), k = toCents(l?.credit_cents);
      if (!l || typeof l.account !== 'string' || !l.account) return invalid(`line ${i}: account is required`);
      if (d === null || k === null) return invalid(`line ${i}: amounts must be whole, non-negative cents`);
      if ((d > 0n) === (k > 0n)) return invalid(`line ${i}: exactly one of debit_cents or credit_cents must be above zero`);
      dr += d; cr += k;
      parsed.push({ account: l.account, debit_cents: d, credit_cents: k });
    }
    if (dr !== cr) return invalid(`journal doesn't balance: debits ${dr} ≠ credits ${cr}`);
    for (const l of parsed) {
      ctx.db.ledger_line.insert({ id: 0n, journal_id, entry_date, memo, ref_type, ref_id, ...l });
    }
    audit(c, 'journal', journal_id, null, { entry_date, memo, ref_type, ref_id, lines: parsed });
    return ok();
  });
}

// ======================= 4.3 Work =======================

export function create_work_item(ctx: Ctx, sender: Identity, request_id: string,
  id: string, kind: string, entity_id: string, origin: string, summary: string): Result {
  return handle(ctx, sender, 'create_work_item', request_id, ['sync', 'agent'], c => {
    const err = firstErr(oneOf(kind, WORK_KINDS, 'kind'), oneOf(origin, ORIGINS, 'origin'));
    if (err) return invalid(err);
    if (ctx.db.work_item.id.find(id)) return ok('already exists');
    const row = {
      id, kind, entity_id, origin, state: 'new', summary, risk_level: 'low',
      created_at: ctx.timestamp, updated_at: ctx.timestamp,
    };
    ctx.db.work_item.insert(row);
    audit(c, 'work_item', id, null, row);
    return ok();
  });
}

export function set_work_item_state(ctx: Ctx, sender: Identity, request_id: string,
  id: string, state: string, note: string): Result {
  return handle(ctx, sender, 'set_work_item_state', request_id, ['agent'], c => {
    const wi = ctx.db.work_item.id.find(id);
    if (!wi) return invalid(`work item ${id} not found`);
    if (!AGENT_TARGET_STATES.includes(state)) return deny(c, `the agent can't move a work item to '${state}'`, 'work_item', id);
    if (!AGENT_SOURCE_STATES.includes(wi.state)) {
      return deny(c, `the agent can't move a work item out of '${wi.state}'`, 'work_item', id);
    }
    setItemState(c, id, state, note);
    return ok();
  });
}

export function log_agent_step(ctx: Ctx, sender: Identity, request_id: string,
  work_item_id: string, kind: string, title: string, detail_json: string): Result {
  return handle(ctx, sender, 'log_agent_step', request_id, ['agent'], () => {
    const err = oneOf(kind, STEP_KINDS, 'kind');
    if (err) return invalid(err);
    if (!ctx.db.work_item.id.find(work_item_id)) return invalid(`work item ${work_item_id} not found`);
    ctx.db.agent_step.insert({ id: 0n, work_item_id, at: ctx.timestamp, kind, title, detail_json });
    return ok();
  });
}

export function record_check(ctx: Ctx, sender: Identity, request_id: string,
  work_item_id: string, check_code: string, status: string, summary: string, evidence_json: string, source: string): Result {
  return handle(ctx, sender, 'record_check', request_id, ['agent'], c => {
    const err = firstErr(oneOf(check_code, CHECK_CODES, 'check_code'), oneOf(status, CHECK_STATUS, 'status'),
      oneOf(source, CHECK_SOURCES, 'source'));
    if (err) return invalid(err);
    if (!ctx.db.work_item.id.find(work_item_id)) return invalid(`work item ${work_item_id} not found`);
    const id = `${work_item_id}:${check_code}`;
    const before = ctx.db.check_result.id.find(id);
    // The AI can add holds, never remove them: a failed check can't be rewritten as anything else.
    if (before?.status === 'fail' && status !== 'fail') {
      return deny(c, `check ${check_code} already failed and can't be changed to '${status}'`, 'check_result', id);
    }
    const row = { id, work_item_id, check_code, status, summary, evidence_json, source, at: ctx.timestamp };
    if (before) ctx.db.check_result.id.update(row); else ctx.db.check_result.insert(row);
    audit(c, 'check_result', id, before, row);
    if (status === 'fail' || status === 'error') {
      const wi = ctx.db.work_item.id.find(work_item_id)!;
      const level = HARD_STOP_CHECKS.includes(check_code) || status === 'error' ? 'high' : 'medium';
      if (wi.risk_level !== 'high' && wi.risk_level !== level) {
        ctx.db.work_item.id.update({ ...wi, risk_level: level, updated_at: ctx.timestamp });
      }
    }
    return ok();
  });
}

export function propose(ctx: Ctx, sender: Identity, request_id: string,
  id: string, work_item_id: string, kind: string, amount_cents: bigint, payee_sub_id: string,
  payee_account_ref: string, reason: string, evidence_json: string): Result {
  return handle(ctx, sender, 'propose', request_id, ['agent'], c => {
    const err = firstErr(oneOf(kind, ['payment', 'hold'], 'kind'), nonNeg(amount_cents, 'amount_cents'));
    if (err) return invalid(err);
    const wi = ctx.db.work_item.id.find(work_item_id);
    if (!wi) return invalid(`work item ${work_item_id} not found`);
    if (ctx.db.proposal.id.find(id)) return invalid(`proposal ${id} already exists`);

    if (kind === 'hold') {
      if (!HOLD_PROPOSE_FROM.includes(wi.state)) return deny(c, `can't propose a hold while the item is '${wi.state}'`, 'proposal', id);
    } else {
      if (!PAYMENT_PROPOSE_FROM.includes(wi.state)) {
        return deny(c, `can't propose a payment while the item is '${wi.state}'`, 'proposal', id);
      }
      if (amount_cents <= 0n) return invalid('a payment must be above zero');
      const sub = ctx.db.sub.id.find(payee_sub_id);
      if (!sub) return deny(c, `payee ${payee_sub_id} is not a known sub`, 'proposal', id);
      if (sub.status !== 'active') return deny(c, `sub ${sub.id} is '${sub.status}', not active`, 'proposal', id);
      if (payee_account_ref !== sub.bank_account_ref) {
        return deny(c, `payee account doesn't match the account on file for ${sub.name}`, 'proposal', id);
      }
      if (wi.kind === 'bill') {
        const b = ctx.db.bill.id.find(wi.entity_id);
        if (!b) return invalid(`bill ${wi.entity_id} not found`);
        if (b.sub_id !== payee_sub_id) return deny(c, `payee ${payee_sub_id} isn't the sub on this bill`, 'proposal', id);
        if (amount_cents > b.amount_cents) return deny(c, 'payment is larger than the bill', 'proposal', id);
        const k = ctx.db.contract.id.find(b.contract_id);
        if (!k || k.status !== 'confirmed') return deny(c, 'the contract for this bill is not confirmed', 'proposal', id);
      }
      const checks = [...ctx.db.check_result.work_item_id.filter(work_item_id)];
      const hard = checks.filter(r => r.status === 'fail' && HARD_STOP_CHECKS.includes(r.check_code));
      if (hard.length) {
        return deny(c, `can't propose payment: hard-stop check failed (${hard.map(r => r.check_code).join(', ')})`, 'proposal', id);
      }
      // Fail safe: outside an owner override, any failed or errored check means hold, not pay.
      if (wi.state !== 'override_requested') {
        const bad = checks.filter(r => r.status === 'fail' || r.status === 'error');
        if (bad.length) {
          return deny(c, `can't propose payment: checks failed or errored (${bad.map(r => r.check_code).join(', ')})`, 'proposal', id);
        }
      }
    }

    for (const p of ctx.db.proposal.work_item_id.filter(work_item_id)) {
      if (p.status === 'pending') {
        const after = { ...p, status: 'cancelled', decision_note: `superseded by ${id}` };
        ctx.db.proposal.id.update(after);
        audit(c, 'proposal', p.id, { status: p.status }, { status: 'cancelled' }, `superseded by ${id}`);
      }
    }
    const row = {
      id, work_item_id, kind, amount_cents, payee_sub_id, payee_account_ref, reason, evidence_json,
      status: 'pending', proposed_by_role: c.role, proposed_by_identity: c.sender_hex,
      decided_by_role: '', decided_by_identity: '', decision_note: '', created_at: ctx.timestamp, decided_at_iso: '',
    };
    ctx.db.proposal.insert(row);
    audit(c, 'proposal', id, null, row, reason);
    setItemState(c, work_item_id, kind === 'payment' ? 'proposed' : 'held', reason);
    return ok();
  });
}

export function decide_proposal(ctx: Ctx, sender: Identity, request_id: string,
  proposal_id: string, approve: boolean, note: string): Result {
  return handle(ctx, sender, 'decide_proposal', request_id, ['owner', 'bookkeeper'], c => {
    const p = ctx.db.proposal.id.find(proposal_id);
    if (!p) return invalid(`proposal ${proposal_id} not found`);
    if (p.proposed_by_identity === c.sender_hex) return deny(c, "you can't decide your own proposal", 'proposal', p.id);
    if (c.role !== 'owner') return deny(c, `only the owner decides ${p.kind} proposals`, 'proposal', p.id);
    if (p.status !== 'pending') return invalid(`proposal ${p.id} is '${p.status}', not pending`);

    const decide = (status: string) => {
      const after = {
        ...p, status, decided_by_role: c.role, decided_by_identity: c.sender_hex,
        decision_note: note, decided_at_iso: iso(c),
      };
      ctx.db.proposal.id.update(after);
      audit(c, 'proposal', p.id, { status: p.status }, { status }, note);
    };

    if (p.kind === 'payment') {
      if (approve) {
        const sub = ctx.db.sub.id.find(p.payee_sub_id);
        if (!sub || sub.bank_account_ref !== p.payee_account_ref) {
          return deny(c, "can't approve: payee account no longer matches the account on file", 'proposal', p.id);
        }
        const hard = failedHardStops(ctx, p.work_item_id);
        if (hard.length) {
          return deny(c, `Can't pay: ${hard[0].summary}. Start a bank change verification instead.`, 'proposal', p.id);
        }
        decide('approved');
        setItemState(c, p.work_item_id, 'approved', note);
        insertJob(c, `job_pay_${p.id}`, 'pay_proposal', { proposal_id: p.id });
      } else {
        decide('rejected');
        setItemState(c, p.work_item_id, 'rejected', note);
      }
      return ok();
    }

    if (p.kind === 'hold') {
      if (approve) {
        decide('approved');
        setItemState(c, p.work_item_id, 'closed_held', note);
      } else {
        const hard = failedHardStops(ctx, p.work_item_id);
        if (hard.length) {
          return deny(c, `Can't pay: ${hard[0].summary}. Start a bank change verification instead.`, 'proposal', p.id);
        }
        decide('rejected');
        setItemState(c, p.work_item_id, 'override_requested', note);
        insertJob(c, `job_override_${p.id}`, 'prepare_override_payment', { work_item_id: p.work_item_id, note });
      }
      return ok();
    }

    return deny(c, `deciding '${p.kind}' proposals isn't available yet`, 'proposal', p.id);
  });
}

export function cancel_proposal(ctx: Ctx, sender: Identity, request_id: string, id: string, note: string): Result {
  return handle(ctx, sender, 'cancel_proposal', request_id, ['agent', 'owner'], c => {
    const p = ctx.db.proposal.id.find(id);
    if (!p) return invalid(`proposal ${id} not found`);
    if (p.status !== 'pending') return invalid(`proposal ${id} is '${p.status}', not pending`);
    if (c.role === 'agent' && p.kind !== 'payment') return deny(c, "the agent can't cancel a hold", 'proposal', id);
    ctx.db.proposal.id.update({ ...p, status: 'cancelled', decision_note: note });
    audit(c, 'proposal', id, { status: p.status }, { status: 'cancelled' }, note);
    return ok();
  });
}

// ======================= 4.4 Payments =======================

export function start_payment(ctx: Ctx, sender: Identity, request_id: string, proposal_id: string): Result {
  return handle(ctx, sender, 'start_payment', request_id, ['gateway'], c => {
    const p = ctx.db.proposal.id.find(proposal_id);
    if (!p || p.kind !== 'payment') return invalid(`payment proposal ${proposal_id} not found`);
    if (p.status !== 'approved') return deny(c, `proposal is '${p.status}', not approved`, 'proposal', proposal_id);
    const sub = ctx.db.sub.id.find(p.payee_sub_id);
    if (!sub || sub.bank_account_ref !== p.payee_account_ref) {
      return deny(c, "payee account no longer matches the account on file", 'proposal', proposal_id);
    }
    ctx.db.proposal.id.update({ ...p, status: 'executing' });
    audit(c, 'proposal', proposal_id, { status: p.status }, { status: 'executing' });
    setItemState(c, p.work_item_id, 'paying');
    return ok();
  });
}

export function record_payment(ctx: Ctx, sender: Identity, request_id: string,
  proposal_id: string, nessie_transfer_id: string, status: string, error: string): Result {
  const r = handle(ctx, sender, 'record_payment', request_id, ['gateway'], c => {
    const err = oneOf(status, ['sent', 'failed'], 'status');
    if (err) return invalid(err);
    const p = ctx.db.proposal.id.find(proposal_id);
    if (!p || p.kind !== 'payment') return invalid(`payment proposal ${proposal_id} not found`);
    if (ctx.db.payment.id.find(proposal_id)) return { outcome: 'duplicate', message: 'payment already recorded for this proposal' };
    if (p.status !== 'approved' && p.status !== 'executing') {
      return deny(c, `proposal is '${p.status}', not approved`, 'proposal', proposal_id);
    }
    const row = {
      id: proposal_id, proposal_id, nessie_transfer_id, amount_cents: p.amount_cents,
      payee_account_ref: p.payee_account_ref, status, error, at: ctx.timestamp,
    };
    ctx.db.payment.insert(row);
    audit(c, 'payment', proposal_id, null, row);
    const pstatus = status === 'sent' ? 'executed' : 'failed';
    ctx.db.proposal.id.update({ ...p, status: pstatus });
    audit(c, 'proposal', proposal_id, { status: p.status }, { status: pstatus });
    setItemState(c, p.work_item_id, status === 'sent' ? 'paid' : 'failed', error);
    return ok();
  });
  return r;
}

// ======================= 4.5 Jobs =======================

export function enqueue_job(ctx: Ctx, sender: Identity, request_id: string,
  id: string, kind: string, payload_json: string): Result {
  return handle(ctx, sender, 'enqueue_job', request_id, ['*'], c => {
    const spec = JOB_KINDS[kind];
    if (!spec) return invalid(`unknown job kind '${kind}'`);
    if (!spec.enqueue_by.includes('*') && !spec.enqueue_by.includes(c.role)) {
      return deny(c, `role '${c.role}' may not enqueue '${kind}' jobs`, 'job', id);
    }
    try { JSON.parse(payload_json); } catch { return invalid('payload_json is not valid JSON'); }
    if (ctx.db.job.id.find(id)) return invalid(`job ${id} already exists`);
    if (c.role === 'public') {
      const queued = [...ctx.db.job.status.filter('queued')].filter(j => j.requested_by === c.sender_hex).length;
      if (queued >= PUBLIC_QUEUED_LIMIT) return deny(c, `limit of ${PUBLIC_QUEUED_LIMIT} queued jobs reached; wait for one to finish`, 'job', id);
    }
    const row = {
      id, kind, assignee_role: spec.assignee, payload_json, status: 'queued', requested_by: c.sender_hex,
      claimed_by: '', result_json: '', error: '', created_at: ctx.timestamp, updated_at: ctx.timestamp,
    };
    ctx.db.job.insert(row);
    audit(c, 'job', id, null, row);
    return ok();
  });
}

export function claim_job(ctx: Ctx, sender: Identity, request_id: string, job_id: string): Result {
  return handle(ctx, sender, 'claim_job', request_id, ['*'], c => {
    const j = ctx.db.job.id.find(job_id);
    if (!j) return invalid(`job ${job_id} not found`);
    if (c.role !== j.assignee_role) return deny(c, `job ${job_id} is for '${j.assignee_role}'`, 'job', job_id);
    if (j.status !== 'queued') return invalid(`job ${job_id} is '${j.status}', not queued`);
    ctx.db.job.id.update({ ...j, status: 'claimed', claimed_by: c.sender_hex, updated_at: ctx.timestamp });
    audit(c, 'job', job_id, { status: j.status }, { status: 'claimed' });
    return ok();
  });
}

export function finish_job(ctx: Ctx, sender: Identity, request_id: string,
  job_id: string, ok_: boolean, result_json: string, error: string): Result {
  return handle(ctx, sender, 'finish_job', request_id, ['*'], c => {
    const j = ctx.db.job.id.find(job_id);
    if (!j) return invalid(`job ${job_id} not found`);
    if (j.claimed_by !== c.sender_hex) return deny(c, `job ${job_id} wasn't claimed by you`, 'job', job_id);
    if (j.status !== 'claimed') return invalid(`job ${job_id} is '${j.status}', not claimed`);
    const status = ok_ ? 'done' : 'failed';
    ctx.db.job.id.update({ ...j, status, result_json, error, updated_at: ctx.timestamp });
    audit(c, 'job', job_id, { status: j.status }, { status, result_json, error });
    return ok();
  });
}
