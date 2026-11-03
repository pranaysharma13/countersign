import type { Row, Tables } from './client';
import { HOLD_LABEL, nextWho, billStory, daysUntil, isSandbox, money, nextStep } from './format';

/** Demo books stay on this Monday so the 13-week tape does not drift. */
export const BOOKS_DATE = '2026-10-27';
export const CLOSE_MONTH = 'October 2026';

const MONEY_HOLD = new Set(['PRICE_VARIANCE', 'PROPOSED_CHARGE', 'USAGE_EVIDENCE_MISSING', 'PO_CEILING']);
const BLOCK_HOLD = new Set([
  ...MONEY_HOLD,
  'PAYEE_CHANGE_PENDING', 'RECEIPT_NOT_VERIFIED', 'PROMPT_INJECTION', 'SUPPLIER_RISK',
  'DUPLICATE_REVIEW', 'EXTRACTION_REVIEW', 'CONTRACT_REVIEW',
]);

export type FlowKind = 'in' | 'out';
export type FlowStatus = 'landed' | 'expected' | 'held';

export interface MoneyFlow {
  id: string;
  iso: string;
  cents: number;
  kind: FlowKind;
  status: FlowStatus;
  who: string;
  what: string;
  href?: string;
}

export interface Escalation {
  invoiceId: string;
  number: string;
  supplier: string;
  cents: number;
  role: string;
  action: string;
  story: string;
  hold: string;
  waitingDays: number;
}

export interface Control {
  id: string;
  label: string;
  ok: boolean;
  note: string;
}

export interface Concentration {
  name: string;
  cents: number;
  shareBps: number;
}

export interface CloseItem {
  id: string;
  label: string;
  done: boolean;
  note: string;
  href?: string;
}

export interface WeekTape {
  start: string;
  inCents: number;
  outCents: number;
  heldCents: number;
  endCash: number;
}

export interface Learned {
  title: string;
  body: string;
}

export interface AskReport {
  title: string;
  lede: string;
  checked: string;
  rows: { left: string; right: string; href?: string }[];
}

export interface OfficeSnap {
  cashOnHand: number;
  askedCents: number;
  heldCents: number;
  readyCents: number;
  collectedCents: number;
  recognizedCents: number;
  remainingContractCents: number;
  unpaidCount: number;
  readyCount: number;
  humanCount: number;
  weeks: WeekTape[];
  flows: MoneyFlow[];
  escalations: Escalation[];
  close: CloseItem[];
  learned: Learned[];
  revenue: { iso: string; label: string; cents: number; status: 'recognized' | 'scheduled' }[];
  entities: { name: string; asked: number; held: number; ready: number }[];
  controls: Control[];
  concentration: Concentration[];
  shortfalls: WeekTape[];
  oldestWait: number;
  aging: { id: string; label: string; count: number; cents: number }[];
  accruals: { label: string; cents: number; note: string }[];
  rec: { left: string; right: string; strong?: boolean }[];
  flux: { title: string; body: string };
  appliedIn: number;
  appliedOut: number;
  allocations: { job: string; cents: number; count: number }[];
  captured: { checked: number; total: number };
}

/** Fictional Oakview owner draws. Not a real company. Amounts are integer cents. */
const OWNER = 'Oakview Lane Owner';
const DRAWS: { id: string; iso: string; cents: number; label: string; landed: boolean }[] = [
  { id: 'draw_found', iso: '2026-10-10', cents: 4_800_000, label: 'Draw 1 · foundations in place', landed: true },
  { id: 'draw_frame', iso: '2026-10-17', cents: 3_600_000, label: 'Draw 2 · framing signed', landed: true },
  { id: 'draw_mep', iso: '2026-11-07', cents: 4_200_000, label: 'Draw 3 · MEP rough-in', landed: false },
  { id: 'draw_dry', iso: '2026-11-21', cents: 2_800_000, label: 'Draw 4 · drywall hung', landed: false },
  { id: 'draw_fin', iso: '2026-12-12', cents: 3_100_000, label: 'Draw 5 · finish punch', landed: false },
];

const CONTRACT_CENTS = DRAWS.reduce((s, d) => s + d.cents, 0);
const OPENING_CASH = 9_240_000; // $92,400 already in the job account after draws 1–2

function asIso(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.length >= 10 ? v.slice(0, 10) : v;
}

function parseDay(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(iso: string, n: number): string {
  const d = parseDay(iso);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

export function mondayOf(iso: string): string {
  const d = parseDay(iso);
  const day = d.getDay(); // 0 Sun
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return ymd(d);
}

function centsOf(row: Row | undefined, key: string): number {
  if (!row) return 0;
  return Number(row[key]) || 0;
}

function supplierName(t: Tables, id: unknown): string {
  return t.supplier.find(s => s.id === id)?.name ?? 'Supplier';
}

function holdsOf(t: Tables, revId: unknown): Row[] {
  return t.hold.filter(h => h.status === 'open' && h.revision_id === revId);
}

function waitDays(holds: Row[], books: string, invoiceIso: string): number {
  const micros = holds
    .map(h => Number(h.created_at) || 0)
    .filter(n => n > 0);
  const oldest = micros.length ? Math.min(...micros) : 0;
  const holdIso = oldest ? ymd(new Date(oldest > 1e12 ? oldest / 1000 : oldest)) : '';
  return Math.max(ageOn(holdIso, books), ageOn(invoiceIso, books));
}

function rankHold(label: string): number {
  if (label === 'New bank account') return 0;
  if (label.startsWith('Hidden')) return 1;
  if (label === 'Delivery not confirmed') return 3;
  return 2;
}

function ageOn(iso: string, books: string): number {
  if (!iso) return 0;
  const n = daysUntil(iso, parseDay(books));
  return n == null ? 0 : Math.max(0, -n);
}

function readyToPay(inv: Row, holds: Row[]): boolean {
  if (inv.payment_status === 'settled') return false;
  if (holds.some(h => BLOCK_HOLD.has(String(h.code)))) return false;
  if (inv.commercial_status !== 'matches') return false;
  if (inv.receipt_status === 'required') return false;
  if (inv.payee_status === 'change_pending' || inv.payee_status === 'unverified') return false;
  return true;
}

export function buildOffice(t: Tables, books = BOOKS_DATE): OfficeSnap {
  const invoices = t.invoice.filter(i => !isSandbox(i));
  const unpaid = invoices.filter(i => i.payment_status !== 'settled');
  const rev = (inv: Row) => t.invoice_revision.find(r => r.id === inv.active_revision_id);

  const flows: MoneyFlow[] = [];
  DRAWS.forEach(d => {
    flows.push({
      id: d.id, iso: d.iso, cents: d.cents, kind: 'in',
      status: d.landed ? 'landed' : 'expected',
      who: OWNER, what: d.label,
    });
  });

  unpaid.forEach(inv => {
    const holds = holdsOf(t, inv.active_revision_id);
    const asked = centsOf(rev(inv), 'balance_requested_cents');
    const held = holds.filter(h => MONEY_HOLD.has(String(h.code)))
      .reduce((s, h) => s + (Number(h.amount_cents) || 0), 0);
    const ready = readyToPay(inv, holds);
    const payCents = ready ? asked : Math.max(asked - held, 0);
    const iso = asIso(inv.due_date) || books;
    if (payCents > 0 && ready) {
      flows.push({
        id: `pay_${inv.id}`, iso, cents: payCents, kind: 'out', status: 'expected',
        who: supplierName(t, inv.supplier_id), what: `${inv.invoice_number} · ready to pay`,
        href: `/invoices/${inv.id}`,
      });
    }
    if (held > 0 || !ready) {
      flows.push({
        id: `hold_${inv.id}`, iso, cents: ready ? held : asked, kind: 'out', status: 'held',
        who: supplierName(t, inv.supplier_id),
        what: `${inv.invoice_number} · ${billStory(inv, holds)}`,
        href: `/invoices/${inv.id}`,
      });
    }
  });

  invoices.filter(i => i.payment_status === 'settled').forEach(inv => {
    flows.push({
      id: `paid_${inv.id}`,
      iso: asIso(inv.due_date) || books,
      cents: centsOf(rev(inv), 'balance_requested_cents'),
      kind: 'out', status: 'landed',
      who: supplierName(t, inv.supplier_id),
      what: `${inv.invoice_number} · paid`,
      href: `/invoices/${inv.id}`,
    });
  });

  const askedCents = unpaid.reduce((s, i) => s + centsOf(rev(i), 'balance_requested_cents'), 0);
  const heldCents = unpaid.reduce((s, i) => {
    const holds = holdsOf(t, i.active_revision_id);
    return s + holds.filter(h => MONEY_HOLD.has(String(h.code)))
      .reduce((n, h) => n + (Number(h.amount_cents) || 0), 0);
  }, 0);
  const readyList = unpaid.filter(i => readyToPay(i, holdsOf(t, i.active_revision_id)));
  const readyCents = readyList.reduce((s, i) => s + centsOf(rev(i), 'balance_requested_cents'), 0);

  const startMon = mondayOf(books);
  const weeks: WeekTape[] = [];
  let cash = OPENING_CASH;
  for (let i = 0; i < 13; i++) {
    const start = addDays(startMon, i * 7);
    const end = addDays(start, 6);
    const inWeek = (f: MoneyFlow) => f.iso >= start && f.iso <= end;
    const inCents = flows.filter(f => f.kind === 'in' && f.status !== 'landed' && inWeek(f))
      .reduce((s, f) => s + f.cents, 0);
    const outCents = flows.filter(f => f.kind === 'out' && f.status === 'expected' && inWeek(f))
      .reduce((s, f) => s + f.cents, 0);
    const weekHeld = flows.filter(f => f.kind === 'out' && f.status === 'held' && inWeek(f))
      .reduce((s, f) => s + f.cents, 0);
    cash += inCents - outCents;
    weeks.push({ start, inCents, outCents, heldCents: weekHeld, endCash: cash });
  }

  const escalations: Escalation[] = unpaid
    .map(inv => {
      const holds = holdsOf(t, inv.active_revision_id);
      if (!holds.length && readyToPay(inv, holds)) return null;
      const next = nextStep(inv, holds);
      const top = holds[0];
      return {
        invoiceId: String(inv.id),
        number: String(inv.invoice_number),
        supplier: supplierName(t, inv.supplier_id),
        cents: centsOf(rev(inv), 'balance_requested_cents'),
        role: next.role,
        action: next.action,
        story: billStory(inv, holds),
        hold: HOLD_LABEL[String(top?.code)] ?? (next.role ? 'Needs a person' : 'Looks right'),
        waitingDays: waitDays(holds, books, asIso(inv.invoice_date)),
      };
    })
    .filter((e): e is Escalation => !!e)
    .sort((a, b) => rankHold(a.hold) - rankHold(b.hold) || b.waitingDays - a.waitingDays || b.cents - a.cents);

  const needReceipt = unpaid.filter(i => i.receipt_status === 'required').length;
  const needBank = unpaid.filter(i => holdsOf(t, i.active_revision_id).some(h => h.code === 'PAYEE_CHANGE_PENDING')).length;
  const moneyHolds = unpaid.filter(i => holdsOf(t, i.active_revision_id).some(h => MONEY_HOLD.has(String(h.code))));
  const letters = (t.outbox ?? []).filter(o => o.status === 'sent' || o.status === 'approved');
  const extracted = invoices.filter(i => i.commercial_status && i.commercial_status !== 'pending').length;

  const close: CloseItem[] = [
    {
      id: 'read',
      label: 'Every bill was read against its quote and purchase order',
      done: invoices.length > 0 && extracted === invoices.length,
      note: `${extracted} of ${invoices.length} bills checked`,
      href: '/bills',
    },
    {
      id: 'site',
      label: 'Site confirmed what arrived, or named what is still waiting',
      done: needReceipt === 0,
      note: needReceipt ? `${needReceipt} still waiting on Site` : 'Every open bill has a delivery note',
      href: '/bills',
    },
    {
      id: 'bank',
      label: 'Bank details match what is already on file',
      done: needBank === 0,
      note: needBank ? `${needBank} new account${needBank === 1 ? '' : 's'} waiting for a call` : 'No unpaid bill has a new account',
    },
    {
      id: 'diff',
      label: 'Differences went back to the supplier, or sit with the owner',
      done: true,
      note: moneyHolds.length
        ? `${moneyHolds.length} bill${moneyHolds.length === 1 ? '' : 's'} held for a corrected invoice or a yes from Dana`
        : 'No price or extra-charge holds',
      href: '/bills',
    },
    {
      id: 'letters',
      label: 'Clarifications left the building',
      done: letters.length > 0 || moneyHolds.length === 0,
      note: letters.length ? `${letters.length} letter${letters.length === 1 ? '' : 's'} marked sent (simulated)` : 'Nothing to send yet',
      href: '/inbox',
    },
    {
      id: 'cash',
      label: 'Cash in and cash out sit on the same tape',
      done: true,
      note: 'Draws already landed. Open bills only leave when they are ready to pay.',
    },
    {
      id: 'board',
      label: 'Board pack uses the same numbers as the bills',
      done: true,
      note: 'One job, one owner, no second set of books',
    },
  ];

  const learned: Learned[] = [];
  const codes = new Set(t.hold.filter(h => h.status === 'open').map(h => String(h.code)));
  if (codes.has('PROMPT_INJECTION')) {
    learned.push({
      title: 'Hidden instructions are printed text',
      body: 'Harbor Pack tried to tell the checker to approve. Clerk ignored the line. The crates still match the order.',
    });
  }
  if (codes.has('PAYEE_CHANGE_PENDING')) {
    learned.push({
      title: 'A new last-4 is a phone call, not an email',
      body: 'Northline asked for a new account by mail. Payment stays until someone calls a number already on file.',
    });
  }
  if (codes.has('PRICE_VARIANCE') || codes.has('PROPOSED_CHARGE') || codes.has('PO_CEILING')) {
    learned.push({
      title: 'A proposal is not an acceptance',
      body: 'An extra ton, a fuel line, or a higher sheet price waits. Nobody pays the difference unless Dana accepts it in the app.',
    });
  }
  if (codes.has('RECEIPT_NOT_VERIFIED')) {
    learned.push({
      title: 'The job site has to see it',
      body: 'A matching invoice is not a delivery. Site still has to confirm the count.',
    });
  }
  if (!learned.length) {
    learned.push({
      title: 'The record is the policy',
      body: 'Clerk reads the quote, the purchase order and the emails already on file. It does not invent a term.',
    });
  }

  const revenue = DRAWS.map(d => ({
    iso: d.iso,
    label: d.label,
    cents: d.cents,
    status: d.landed ? 'recognized' as const : 'scheduled' as const,
  }));

  const bySup = new Map<string, number>();
  unpaid.forEach(inv => {
    const name = supplierName(t, inv.supplier_id);
    bySup.set(name, (bySup.get(name) ?? 0) + centsOf(rev(inv), 'balance_requested_cents'));
  });
  const concentration: Concentration[] = [...bySup.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, cents]) => ({
      name,
      cents,
      shareBps: askedCents > 0 ? Math.floor((cents * 10_000) / askedCents) : 0,
    }));
  const topShare = concentration[0]?.shareBps ?? 0;
  const shortfalls = weeks.filter(w => w.endCash < 0);
  const oldestWait = escalations.reduce((n, e) => Math.max(n, e.waitingDays), 0);
  const controls: Control[] = [
    {
      id: 'sod',
      label: 'The person who proposes cannot pay',
      ok: true,
      note: 'Clerk can open a hold and propose. Dana has to say yes in the app. Same identity cannot do both.',
    },
    {
      id: 'voice',
      label: 'A new bank account needs a call',
      ok: needBank === 0,
      note: needBank
        ? `${needBank} new account${needBank === 1 ? '' : 's'} still waiting for a number already on file`
        : 'No unpaid bill has a new last four',
    },
    {
      id: 'holds',
      label: 'Holds clear one at a time',
      ok: true,
      note: 'Delivery, bank, price and owner are separate. Clearing one never clears another.',
    },
    {
      id: 'cash',
      label: 'The tape does not go below zero',
      ok: shortfalls.length === 0,
      note: shortfalls.length
        ? `${shortfalls.length} week${shortfalls.length === 1 ? '' : 's'} would end negative if ready bills left`
        : 'Ready bills leave. Held bills stay. End cash stays at or above zero.',
    },
    {
      id: 'conc',
      label: 'No single supplier is the book',
      ok: topShare < 4000,
      note: concentration[0]
        ? `${concentration[0].name} is ${Math.floor(topShare / 100)}% of open claims`
        : 'No open claims',
    },
  ];

  const ageBuckets = [
    { id: 'current', label: 'Not yet due', test: (n: number) => n >= 0 },
    { id: 'd30', label: '1–30 days late', test: (n: number) => n < 0 && n >= -30 },
    { id: 'd60', label: '31–60 days late', test: (n: number) => n < -30 && n >= -60 },
    { id: 'd90', label: 'More than 60 days late', test: (n: number) => n < -60 },
  ];
  const aging = ageBuckets.map(b => {
    const rows = unpaid.filter(i => {
      const n = daysUntil(asIso(i.due_date) || books, parseDay(books));
      return n != null && b.test(n);
    });
    return {
      id: b.id,
      label: b.label,
      count: rows.length,
      cents: rows.reduce((s, i) => s + centsOf(rev(i), 'balance_requested_cents'), 0),
    };
  });
  const accrueCents = unpaid.reduce((s, i) => {
    const asked = centsOf(rev(i), 'balance_requested_cents');
    const held = holdsOf(t, i.active_revision_id)
      .filter(h => MONEY_HOLD.has(String(h.code)))
      .reduce((n, h) => n + (Number(h.amount_cents) || 0), 0);
    return s + Math.max(asked - held, 0);
  }, 0);
  const accruals = [
    {
      label: 'Accrue what matches the order',
      cents: accrueCents,
      note: 'Preview only. Clerk does not post. Dana would have to accept the entry.',
    },
    {
      label: 'Do not accrue what is not agreed',
      cents: heldCents,
      note: 'Price gaps and extras stay off the books until a corrected invoice or a yes in the app.',
    },
  ];
  const w0 = weeks[0];
  const rec = [
    { left: 'Job account (after draws 1–2)', right: money(OPENING_CASH) },
    { left: 'Ready to leave this week', right: money(-(w0?.outCents ?? 0)) },
    { left: 'Held until a person acts', right: money(w0?.heldCents ?? 0) },
    { left: 'Scheduled in this week', right: money(w0?.inCents ?? 0) },
    { left: 'Ties to the tape', right: money(w0?.endCash ?? OPENING_CASH), strong: true },
  ];
  const w1 = weeks[1];
  const delta = (w1?.endCash ?? OPENING_CASH) - (w0?.endCash ?? OPENING_CASH);
  const flux = {
    title: 'Why cash moves next week',
    body: delta === 0
      ? 'The tape does not move next week. No ready bill leaves and no draw lands.'
      : `Cash ${delta > 0 ? 'rises' : 'falls'} ${money(Math.abs(delta))} into the week of ${w1?.start ?? ''}. In ${money(w1?.inCents ?? 0)}, out ${money(w1?.outCents ?? 0)}. Held ${money(w1?.heldCents ?? 0)} stays.`,
  };
  const allocMap = new Map<string, { cents: number; count: number }>();
  unpaid.forEach(i => {
    const pur = t.purchase?.find(p => p.id === i.purchase_id);
    const proj = t.project?.find(p => p.id === pur?.project_id);
    const job = String(proj?.name || 'Oakview Lane Fourplex');
    const cur = allocMap.get(job) ?? { cents: 0, count: 0 };
    cur.cents += centsOf(rev(i), 'balance_requested_cents');
    cur.count += 1;
    allocMap.set(job, cur);
  });
  const allocations = [...allocMap.entries()]
    .sort((a, b) => b[1].cents - a[1].cents)
    .map(([job, v]) => ({ job, cents: v.cents, count: v.count }));

  return {
    cashOnHand: OPENING_CASH,
    askedCents,
    heldCents,
    readyCents,
    collectedCents: DRAWS.filter(d => d.landed).reduce((s, d) => s + d.cents, 0),
    recognizedCents: DRAWS.filter(d => d.landed).reduce((s, d) => s + d.cents, 0),
    remainingContractCents: CONTRACT_CENTS - DRAWS.filter(d => d.landed).reduce((s, d) => s + d.cents, 0),
    unpaidCount: unpaid.length,
    readyCount: readyList.length,
    humanCount: escalations.filter(e => e.role && e.role !== 'agent').length,
    weeks,
    flows,
    escalations,
    close,
    learned,
    revenue,
    entities: [
      { name: 'Oakview Lane Fourplex', asked: askedCents, held: heldCents, ready: readyCents },
      { name: 'Marlow & Finch (overhead)', asked: 0, held: 0, ready: 0 },
    ],
    controls,
    concentration,
    shortfalls,
    oldestWait,
    aging,
    accruals,
    rec,
    flux,
    appliedIn: DRAWS.filter(d => d.landed).reduce((s, d) => s + d.cents, 0),
    appliedOut: invoices.filter(i => i.payment_status === 'settled')
      .reduce((s, i) => s + centsOf(rev(i), 'balance_requested_cents'), 0),
    allocations,
    captured: { checked: extracted, total: invoices.length },
  };
}

function byWeek(flows: MoneyFlow[], kind: FlowKind, books = BOOKS_DATE): { left: string; right: string }[] {
  const start = mondayOf(books);
  const rows: { left: string; right: string }[] = [];
  for (let i = 0; i < 13; i++) {
    const mon = addDays(start, i * 7);
    const end = addDays(mon, 6);
    const cents = flows.filter(f => f.kind === kind && f.status !== 'landed' && f.iso >= mon && f.iso <= end)
      .reduce((s, f) => s + f.cents, 0);
    if (!cents) continue;
    rows.push({ left: `Week of ${mon}`, right: money(cents) });
  }
  return rows;
}

function byWho(flows: MoneyFlow[], kind: FlowKind): { left: string; right: string; href?: string }[] {
  const map = new Map<string, { cents: number; href?: string }>();
  flows.filter(f => f.kind === kind && f.status !== 'landed').forEach(f => {
    const cur = map.get(f.who) ?? { cents: 0, href: f.href };
    cur.cents += f.cents;
    map.set(f.who, cur);
  });
  return [...map.entries()]
    .sort((a, b) => b[1].cents - a[1].cents)
    .map(([left, v]) => ({ left, right: money(v.cents), href: v.href }));
}

/** Deterministic answers. Code decides the numbers; the box never invents a total. */
export function answerAsk(q: string, snap: OfficeSnap): AskReport {
  const s = q.trim().toLowerCase();
  if (!s) {
    return {
      title: 'Ask for a report',
      lede: 'Try “AP by supplier”, “AR by week”, “who has to decide”, or “cash next 13 weeks”.',
      checked: 'Nothing asked yet.',
      rows: [],
    };
  }

  const wantsAr = /\b(ar|draw|owner|customer|revenue)\b/.test(s);
  const wantsAp = /\b(ap|bill|supplier|payable|out)\b/.test(s) || (!wantsAr && /\bweek\b/.test(s) && /\bby\b/.test(s));
  const wantsWeek = /\bweek\b/.test(s);
  const wantsWho = /\b(who|decide|approval|turn|human|escalat)\b/.test(s);
  const wantsCash = /\b(cash|forecast|13|thirteen|tape)\b/.test(s);
  const wantsHeld = /\b(hold|held|block|stop|disagree)\b/.test(s);
  const wantsLate = /\b(late|aging|waiting|sla|old)\b/.test(s);
  const wantsConc = /\b(concentrat|share|exposure|largest)\b/.test(s);
  const wantsShort = /\b(shortfall|negative|below zero|dip)\b/.test(s);
  const wantsAge = /\b(aging|age|overdue|late)\b/.test(s);
  const wantsAccrue = /\b(accrual|accrue)\b/.test(s);
  const wantsRec = /\b(rec|reconcil|tie out|tie-out)\b/.test(s);
  const wantsFlux = /\b(flux|commentary|why cash|move)\b/.test(s);
  const wantsAlloc = /\b(allocat|coded|code to)\b/.test(s);

  if (wantsAge) {
    return {
      title: 'Open bills by age',
      lede: 'Due date against the books date. Late does not mean we pay.',
      checked: 'Open bills only. Grouped by due date against the books date.',
      rows: snap.aging.map(a => ({ left: `${a.label} · ${a.count}`, right: money(a.cents) })),
    };
  }
  if (wantsAccrue) {
    return {
      title: 'Accrual preview',
      lede: 'What would hit the books if we closed today. Nothing posts until a person accepts.',
      checked: 'Matching unpaid minus open money holds. Held extras are omitted.',
      rows: snap.accruals.map(a => ({ left: a.label, right: money(a.cents) })),
    };
  }
  if (wantsRec) {
    return {
      title: 'Job account rec',
      lede: 'Same opening cash as the tape. Held amounts do not leave.',
      checked: 'Opening after draws 1–2, minus ready out, plus scheduled in.',
      rows: snap.rec.map(r => ({ left: r.left, right: r.right })),
    };
  }
  if (wantsAlloc) {
    return {
      title: 'Coded to a job',
      lede: 'Every open bill is allocated when it lands. Clerk does not invent a class.',
      checked: 'Invoice → purchase → project name. Missing project stays on Oakview.',
      rows: snap.allocations.map(a => ({
        left: `${a.job} · ${a.count} bill${a.count === 1 ? '' : 's'}`,
        right: money(a.cents),
      })),
    };
  }
  if (wantsFlux) {
    return {
      title: snap.flux.title,
      lede: snap.flux.body,
      checked: 'Week 1 endCash minus week 0 endCash. Integer cents only.',
      rows: snap.weeks.slice(0, 2).map(w => ({
        left: `Week of ${w.start}`,
        right: money(w.endCash),
      })),
    };
  }

  if (wantsLate) {
    const rows = [...snap.escalations]
      .sort((a, b) => b.waitingDays - a.waitingDays)
      .map(e => ({
        left: `${e.supplier} ${e.number} · ${e.waitingDays} day${e.waitingDays === 1 ? '' : 's'}`,
        right: money(e.cents),
        href: `/invoices/${e.invoiceId}`,
      }));
    return {
      title: 'Waiting on a person',
      lede: rows[0]
        ? `Oldest open item has been waiting ${snap.oldestWait} day${snap.oldestWait === 1 ? '' : 's'}.`
        : 'Nothing is waiting.',
      checked: 'Age is books date minus the oldest open hold, or the invoice date if the hold has no time.',
      rows,
    };
  }

  if (wantsConc) {
    return {
      title: 'Open claims by supplier',
      lede: snap.concentration[0]
        ? `${snap.concentration[0].name} is ${Math.floor(snap.concentration[0].shareBps / 100)}% of unpaid claims.`
        : 'No open claims.',
      checked: 'Share is integer basis points of unpaid non-sandbox balances. Watch starts at 40%.',
      rows: snap.concentration.map(c => ({
        left: `${c.name} · ${Math.floor(c.shareBps / 100)}%`,
        right: money(c.cents),
      })),
    };
  }

  if (wantsShort) {
    return {
      title: 'Weeks that would end below zero',
      lede: snap.shortfalls.length
        ? `${snap.shortfalls.length} week${snap.shortfalls.length === 1 ? '' : 's'} would go negative if every ready bill left.`
        : 'No week ends below zero.',
      checked: 'endCash is opening cash plus scheduled in minus ready out. Held amounts do not leave.',
      rows: snap.shortfalls.map(w => ({
        left: `Week of ${w.start}`,
        right: money(w.endCash),
      })),
    };
  }

  if (wantsWho) {
    const rows = snap.escalations
      .filter(e => e.role)
      .map(e => ({
        left: `${nextWho(e.role)} · ${e.supplier} ${e.number}`,
        right: money(e.cents),
        href: `/invoices/${e.invoiceId}`,
      }));
    return {
      title: 'Who has to decide',
      lede: `${rows.length} bill${rows.length === 1 ? '' : 's'} still need a named person. Clerk does not approve or pay.`,
      checked: `Counted ${snap.escalations.length} open bills against nextStep. Ready-to-pay bills are omitted.`,
      rows,
    };
  }

  if (wantsHeld) {
    const rows = snap.escalations
      .filter(e => e.hold !== 'Looks right')
      .map(e => ({
        left: `${e.supplier} ${e.number} · ${e.hold}`,
        right: money(e.cents),
        href: `/invoices/${e.invoiceId}`,
      }));
    return {
      title: 'Held until a person acts',
      lede: `${money(snap.heldCents)} is a money difference. The rest is waiting on delivery, a bank call, or a flag.`,
      checked: 'Summed open MONEY_HOLD amounts. Did not treat a hold as a payment.',
      rows,
    };
  }

  if (wantsCash) {
    return {
      title: '13-week cash tape',
      lede: `Starts at ${money(snap.cashOnHand)} on ${BOOKS_DATE}. Only ready bills leave. Held bills stay.`,
      checked: 'Opening cash is the job account after draws 1–2. Outflows are unpaid bills with no blocking hold.',
      rows: snap.weeks.map(w => ({
        left: `Week of ${w.start}`,
        right: `${money(w.endCash)}  (in ${money(w.inCents)} · out ${money(w.outCents)})`,
      })),
    };
  }

  if (wantsAr && wantsWeek) {
    return {
      title: 'AR by week',
      lede: `Owner draws still to collect: ${money(snap.remainingContractCents)}.`,
      checked: 'Fictional Oakview draws only. No live customer invoices exist in this product.',
      rows: byWeek(snap.flows, 'in'),
    };
  }

  if (wantsAr) {
    return {
      title: 'AR by customer',
      lede: `${OWNER} is the only customer on this job.`,
      checked: 'One fictional owner. Summed scheduled draws that have not landed.',
      rows: byWho(snap.flows, 'in'),
    };
  }

  if (wantsAp && wantsWeek) {
    return {
      title: 'AP by week',
      lede: `Suppliers asked for ${money(snap.askedCents)}. ${money(snap.readyCents)} is ready to pay.`,
      checked: 'Unpaid non-sandbox bills, grouped by due-date week. Held amounts stay in the held column on the tape.',
      rows: byWeek(snap.flows, 'out'),
    };
  }

  if (wantsAp || /\bsupplier\b/.test(s)) {
    return {
      title: 'AP by supplier',
      lede: `${snap.unpaidCount} open bills. ${snap.readyCount} ready to pay.`,
      checked: 'Grouped unpaid non-sandbox bills by supplier. Sandbox judge bills omitted.',
      rows: byWho(snap.flows, 'out'),
    };
  }

  return {
    title: 'The books, in one pass',
    lede: `${money(snap.cashOnHand)} in the job account. ${money(snap.askedCents)} asked. ${money(snap.heldCents)} held.`,
    checked: 'Same snapshot as the Office page. No second total.',
    rows: [
      { left: 'Cash on hand', right: money(snap.cashOnHand) },
      { left: 'Owner still to pay us', right: money(snap.remainingContractCents) },
      { left: 'Suppliers asked', right: money(snap.askedCents) },
      { left: 'Not agreed yet', right: money(snap.heldCents) },
      { left: 'Ready to pay', right: money(snap.readyCents) },
    ],
  };
}
