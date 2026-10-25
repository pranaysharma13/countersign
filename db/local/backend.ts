// LOCAL DEMO BACKEND — runs the real module in-process (spacetimedb test harness), seeded by
// replaying data/seeds/baymix_opening.json (same BM-23104 world as Python). Used by the web app
// when no SpacetimeDB server is reachable, and as an offline fallback for judging. A small
// stand-in worker plays the agent, the gateway and the supplier (all clearly labeled simulated).
// It is NOT the Python agent; with a live server, Python does this.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createModuleTestHarness, TestAuth } from 'spacetimedb/server/test-utils';
import { Identity, Timestamp } from 'spacetimedb';
import spacetimedb from '../src/schema';
import * as mod from '../src/index';
import * as L from '../src/logic';
import * as V from '../src/logic_v2';
import { REDUCER_ARGS } from '../src/reducer_args';
export { REDUCER_ARGS };
import type { Ctx } from '../src/schema';

// Same files Python exports (data/README.md). Path works from db/local (tests) and db/dist (web).
const SEEDS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../data/seeds');
const INV = 'inv_bm23104';
const WI = `wi_${INV}`;
const DEP = 'dep_baymix_oak_1';
type SeedCall = { role: Persona; reducer: string; args: Record<string, unknown> };
const loadSeed = (name: string): SeedCall[] => JSON.parse(readFileSync(resolve(SEEDS_DIR, name), 'utf8'));

export const PERSONAS = {
  admin: { n: 1, name: 'Setup script' },
  owner: { n: 2, name: 'Dana Marlow' },
  bookkeeper: { n: 3, name: 'Sam Okafor' },
  agent: { n: 4, name: 'Countersign agent' },
  gateway: { n: 5, name: 'Payment gateway' },
  sync: { n: 6, name: 'Intake' },
  purchasing: { n: 7, name: 'Jordan Reyes' },
  receiver: { n: 8, name: 'Ana Ruiz' },
} as const;
export type Persona = keyof typeof PERSONAS;
const ident = (n: number) => new Identity('0x' + n.toString(16).padStart(64, '0'));
const ID = Object.fromEntries(Object.entries(PERSONAS).map(([k, v]) => [k, ident(v.n)])) as Record<Persona, Identity>;
const FNS: Record<string, (...a: any[]) => { outcome: string; message: string }> = { ...L, ...V } as any;

const D = (dollars: number) => BigInt(Math.round(dollars * 100));
const j = (v: unknown) => JSON.stringify(v);

export class LocalBackend {
  private h: any;
  private n = 0;
  private clockMicros = BigInt(Date.UTC(2026, 9, 23, 16, 5)) * 1000n; // Oct 23, 9:05 AM PT

  constructor() { this.reset(); }

  reset() {
    this.h = createModuleTestHarness(spacetimedb, mod);
    this.n = 0;
    this.seed();
  }

  private tick() {
    this.clockMicros += 7_000_000n;
    this.h.clock.set(new Timestamp(this.clockMicros));
  }

  private callAs(p: Persona, reducer: string, ...args: unknown[]) {
    const fn = FNS[reducer];
    if (!fn) throw new Error(`unknown reducer ${reducer}`);
    this.tick();
    const rid = `local_${++this.n}`;
    return this.h.withReducerTx(TestAuth.internal(), (ctx: Ctx) => fn(ctx, ID[p], rid, ...args));
  }

  private must(p: Persona, reducer: string, ...args: unknown[]) {
    const r = this.callAs(p, reducer, ...args);
    if (r.outcome !== 'ok' && r.outcome !== 'duplicate') throw new Error(`seed ${reducer}: ${r.outcome} ${r.message}`);
    return r;
  }

  /** Called by the web app: positional args (request_id excluded), like the HTTP API. */
  call(persona: Persona, reducer: string, args: unknown[]) {
    const names = REDUCER_ARGS[reducer];
    if (!names) return { outcome: 'invalid', message: `unknown reducer ${reducer}` };
    const typed = args.map((v, i) => {
      const name = names[i + 1] ?? '';
      return (name.endsWith('_cents') || name.endsWith('_milli')) && v !== null && v !== undefined ? BigInt(v as any) : v;
    });
    const r = this.callAs(persona, reducer, ...typed);
    this.work(); // stand-in worker reacts to the new state
    return r;
  }

  state(tables: string[]) {
    const out: Record<string, unknown[]> = {};
    for (const t of tables) {
      const tbl = this.h.db[t];
      if (!tbl) continue;
      out[t] = [...tbl.iter()].map(toJson);
    }
    return out;
  }

  // ---------------------------------------------------------------- stand-in worker (simulated)

  private q = (table: string) => [...this.h.db[table].iter()] as any[];

  private step(kind: string, title: string, detail: unknown = {}) {
    this.callAs('agent', 'log_agent_step', WI, kind, title, j(detail));
  }

  private replay(calls: SeedCall[]) {
    for (const c of calls) {
      const names = REDUCER_ARGS[c.reducer];
      if (!names) throw new Error(`unknown seed reducer ${c.reducer}`);
      const args = names.slice(1).map(name => {
        const raw = c.args[name];
        const v = (typeof raw === 'string' && raw.startsWith('<identity:') && raw.endsWith('>'))
          ? ID[raw.slice('<identity:'.length, -1) as Persona].toHexString()
          : raw;
        return (name.endsWith('_cents') || name.endsWith('_milli')) && v !== null && v !== undefined ? BigInt(v as any) : v;
      });
      this.must(c.role, c.reducer, ...args);
    }
  }

  private work() {
    for (let guard = 0; guard < 10; guard++) {
      const job = this.q('job').find(x => x.status === 'queued' && ['send_outbox', 'pay_supplier', 'sneak_charge'].includes(x.kind));
      if (job) { this.runJob(job); continue; }
      if (this.maybePropose()) continue;
      break;
    }
  }

  private runJob(job: any) {
    this.callAs(job.assignee_role, 'claim_job', job.id);
    const payload = JSON.parse(job.payload_json);
    if (job.kind === 'send_outbox') {
      this.callAs('sync', 'mark_outbox', payload.outbox_id, 'sent', `simulated-${payload.outbox_id}`);
      this.supplierCorrects();
    } else if (job.kind === 'pay_supplier') {
      this.settle(payload.proposal_id);
    }
    // A judge submission becomes a real invoice on the sandbox supplier only through the Python pipeline
    // (live mode). The stand-in never fakes the checks and never touches BM-23104: it says so and stops.
    const result = job.kind === 'sneak_charge'
      ? j({ status: 'not_run', reason: 'Local demo: judge submissions run on the sandbox supplier through the Python worker (live mode). Nothing was changed.' })
      : '{}';
    this.callAs(job.assignee_role, 'finish_job', job.id, true, result, '');
  }

  /** BayMix's reply and revision 2, from the same seed Python loads onto Maincloud. */
  private supplierCorrects() {
    if (this.h.db.invoice_revision.id.find('rev_bm23104_r2')) return;
    this.replay(loadSeed('baymix_correction.json'));
    this.step('thought', 'Corrected invoice BM-23104 revision 2 received; it supersedes the original.');
    this.step('decision', 'Commercial terms now match. Payment still needs the superintendent to confirm receipt.', {});
  }

  /** The agent proposes payment once nothing but its own decision is missing. */
  private maybePropose(): boolean {
    for (const inv of this.q('invoice')) {
      if (this.tryPropose(inv)) return true;
    }
    return false;
  }

  private tryPropose(inv: any): boolean {
    if (!inv || !inv.active_revision_id || inv.payment_status !== 'not_ready') return false;
    if (inv.receipt_status !== 'manually_confirmed') return false;
    const holds = this.q('hold').filter(x => x.revision_id === inv.active_revision_id && x.status === 'open' && x.code !== 'APPROVAL_STALE');
    if (holds.length) return false;
    const pending = this.q('proposal').some(p => p.work_item_id === `wi_${inv.id}` && p.status === 'pending' && p.kind === 'supplier_payment');
    if (pending) return false;
    const as = this.q('assessment').filter(a => a.revision_id === inv.active_revision_id).sort((a, b) => b.version - a.version)[0];
    const payee = this.q('payee_profile').find(p => p.supplier_id === inv.supplier_id && p.status === 'verified');
    if (!as || !payee || Number(as.proposed_payment_cents) <= 0) return false;
    const id = `pp_${inv.active_revision_id}_${as.version}`;
    if (this.h.db.proposal.id.find(id)) return false;
    const r = this.callAs('agent', 'propose_supplier_payment', id, inv.id, inv.active_revision_id, as.id, as.proposed_payment_cents,
      BigInt(as.deposit_available_cents ?? 0) > 0n && inv.id === INV ? D(10000) : 0n, payee.id);
    this.step('decision', `Proposed paying $${(Number(as.proposed_payment_cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })} for the controller's approval`, { proposal_id: id, invoice_id: inv.id, outcome: r.outcome });
    return r.outcome === 'ok';
  }

  /** Simulated gateway: Nessie-style settlement once, deposit applied once, balanced journals. */
  private settle(proposal_id: string) {
    const s = this.callAs('gateway', 'start_payment', proposal_id);
    if (s.outcome !== 'ok') { this.step('error', 'Gateway refused to start the payment', s); return; }
    const p = this.h.db.proposal.id.find(proposal_id);
    const ref = JSON.parse(p?.evidence_json || '{}');
    const inv = this.h.db.invoice.id.find(ref.invoice_id);
    const rev = this.h.db.invoice_revision.id.find(inv?.active_revision_id);
    const alloc = Number(ref.deposit_allocation_cents || 0);
    if (alloc > 0) {
      const dep = this.q('deposit').find(d => d.purchase_id === inv.purchase_id && d.status === 'settled')
        ?? this.h.db.deposit.id.find(DEP);
      if (dep) this.callAs('gateway', 'record_deposit_allocation', `da_${inv.id}`, dep.id, inv.id, BigInt(alloc));
    }
    this.callAs('gateway', 'record_payment', proposal_id, `nessie_sim_${proposal_id}`, 'sent', '');
    const gross = Number(rev?.gross_cents ?? 0);
    const pay = Number(p?.amount_cents ?? 0);
    const proj = this.h.db.purchase.id.find(inv?.purchase_id)?.project_id ?? 'prj_oak';
    const post = (id: string, refType: string, memo: string, lines: [string, number, number][]) =>
      this.callAs('gateway', 'post_journal', id, '2026-10-24', memo, refType, inv.id,
        j(lines.map(([account, d, c]) => ({ account, debit_cents: d, credit_cents: c }))));
    post(`jr_${inv.id}_bill`, 'invoice', `${inv.invoice_number} accepted, receipt attested`,
      [[`job_material_cost:${proj}`, gross, 0], ['accounts_payable', 0, gross]]);
    if (alloc > 0) {
      post(`jr_${inv.id}_dep`, 'invoice', `Deposit applied to ${inv.invoice_number}`,
        [['accounts_payable', alloc, 0], ['supplier_prepayment', 0, alloc]]);
    }
    post(`jr_${inv.id}_pay`, 'payment', `Settlement of ${inv.invoice_number} (simulated Nessie)`,
      [['accounts_payable', pay, 0], ['cash', 0, pay]]);
  }

  // ---------------------------------------------------------------- seed: Python's baymix_opening.json (BM-23104)

  private seed() {
    this.h.clock.set(new Timestamp(this.clockMicros));
    this.must('admin', 'claim_admin');
    this.replay(loadSeed('baymix_opening.json'));
    this.step('decision', 'Held: $3,725 under review. Drafted a clarification to BayMix for purchasing to review and send.',
      { holds: ['PRICE_VARIANCE', 'PROPOSED_CHARGE', 'RECEIPT_NOT_VERIFIED'] });
    this.replay(loadSeed('queue_companions.json'));
    this.step('thought', 'Two more Oakview invoices on the desk: Cedar & Bolt CB-8802 matches and is ready to pay; Northline NL-441 is held for a bank-account change.');
  }

}

function toJson(row: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = plain(v);
  return out;
}

/** Rows hold bigint, Timestamp and Identity values; turn them into JSON-safe numbers and hex strings. */
function plain(v: unknown): unknown {
  if (typeof v === 'bigint') return Number(v);
  if (v && typeof v === 'object') {
    const o = v as any;
    if (typeof o.microsSinceUnixEpoch === 'bigint') return Number(o.microsSinceUnixEpoch);
    if (typeof o.toHexString === 'function') return o.toHexString();
    if (Array.isArray(v)) return v.map(plain);
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, plain(x)]));
  }
  return v;
}

let singleton: LocalBackend | null = null;
export function localBackend() {
  if (!singleton) singleton = new LocalBackend();
  return singleton;
}
