import type { Row, Tables } from './client';

/** Same books Monday as the office tape. */
export const BOOKS_DATE = '2026-10-27';

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = (cents: number) => usd.format(cents / 100);
const isSandbox = (inv: { supplier_id?: unknown }) => inv.supplier_id === 'sup_sandbox';

/** Job operating account after Oakview draws 1–2. Integer cents. */
export const OPERATING_REF = 'acct_company_operating';
export const OPERATING_LAST4 = '0418';
export const OPERATING_CENTS = 9_240_000;
export const OWNER_DRAW_CENTS = 8_400_000;
export const WORKING_CAPITAL_CENTS = OPERATING_CENTS - OWNER_DRAW_CENTS;
export const ACH_CUTOFF_HOUR = 15;
export const WIRE_DUAL_CENTS = 1_000_000;
export const OWNER_PAY_LIMIT_CENTS = 25_000_000;

const MONEY_HOLD = new Set(['PRICE_VARIANCE', 'PROPOSED_CHARGE', 'USAGE_EVIDENCE_MISSING', 'PO_CEILING']);
const BLOCK_HOLD = new Set([
  ...MONEY_HOLD,
  'PAYEE_CHANGE_PENDING', 'RECEIPT_NOT_VERIFIED', 'PROMPT_INJECTION', 'SUPPLIER_RISK',
  'DUPLICATE_REVIEW', 'EXTRACTION_REVIEW', 'CONTRACT_REVIEW',
]);

export type Rail = 'ach' | 'wire' | 'deposit';
export type PayeeState = 'verified' | 'pending' | 'rejected' | 'superseded';

export interface BankAccount {
  ref: string;
  nessieId: string;
  nickname: string;
  type: 'Checking' | 'Credit Card';
  last4: string;
  cents: number;
  customer: string;
  ours: boolean;
}

export interface BankMove {
  id: string;
  iso: string;
  cents: number;
  rail: Rail;
  status: 'executed' | 'pending' | 'held';
  from: string;
  to: string;
  memo: string;
  simulated: true;
}

export interface PayeeRow {
  id: string;
  supplierId: string;
  supplier: string;
  bank: string;
  last4: string;
  ref: string;
  nessieId: string;
  status: PayeeState;
  nameMatch: boolean;
  rail: Rail;
}

export interface ControlRow {
  id: string;
  label: string;
  ok: boolean;
  note: string;
}

export interface AchWindow {
  books: string;
  cutoffHour: number;
  zone: 'America/Los_Angeles';
  open: boolean;
  settles: string;
  note: string;
}

export interface Treasury {
  source: 'nessie' | 'nessie-fixture';
  label: string;
  books: string;
  operating: BankAccount;
  owner: BankAccount;
  payees: PayeeRow[];
  accounts: BankAccount[];
  moves: BankMove[];
  window: AchWindow;
  controls: ControlRow[];
  booksCents: number;
  bankCents: number;
  diffCents: number;
  heldCents: number;
  readyCents: number;
  readyCount: number;
}

export function nessieId(ref: string): string {
  let h = 2166136261;
  for (let i = 0; i < ref.length; i++) h = Math.imul(h ^ ref.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, '0') + (ref.length * 2654435761 >>> 0).toString(16).padStart(8, '0') + 'a73e494d';
}

export function addBusinessDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  let left = n;
  const step = n >= 0 ? 1 : -1;
  while (left !== 0) {
    dt.setDate(dt.getDate() + step);
    const dow = dt.getDay();
    if (dow !== 0 && dow !== 6) left -= step;
  }
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

export function achWindow(books = BOOKS_DATE): AchWindow {
  const settles = addBusinessDays(books, 1);
  return {
    books,
    cutoffHour: ACH_CUTOFF_HOUR,
    zone: 'America/Los_Angeles',
    open: true,
    settles,
    note: `ACH files cut at ${ACH_CUTOFF_HOUR}:00 PT on ${books}. Money that leaves today lands ${settles}. A wire of ${money(WIRE_DUAL_CENTS)} or more needs a second pair of eyes. Clerk still cannot pay.`,
  };
}

/** Nessie talks dollars. Convert at the edge only. Never store the float. */
export function dollarsToCents(n: unknown): number {
  const raw = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(raw)) return 0;
  return Math.round(raw * 100);
}

/** A seed account is already the supplier. A pending email change must look like them. */
export function namesMatch(supplier: string, bank: string): boolean {
  const a = supplier.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const first = a.split(' ')[0] ?? '';
  return first.length >= 3 && bank.toLowerCase().includes(first);
}

export function payeeNameOk(status: string, supplier: string, bank: string): boolean {
  if (status === 'pending') return namesMatch(supplier, bank);
  return status === 'verified';
}

function centsOf(row: Row | undefined, key: string): number {
  return row ? Number(row[key]) || 0 : 0;
}

function holdsOf(t: Tables, revId: unknown): Row[] {
  return (t.hold ?? []).filter(h => h.status === 'open' && h.revision_id === revId);
}

function readyToPay(inv: Row, holds: Row[]): boolean {
  if (inv.payment_status === 'settled') return false;
  if (holds.some(h => BLOCK_HOLD.has(String(h.code)))) return false;
  if (inv.payee_status === 'change_pending' || inv.payee_status === 'unverified') return false;
  if (inv.receipt_status === 'required') return false;
  return true;
}

export function fixtureAccounts(): BankAccount[] {
  return [
    {
      ref: OPERATING_REF,
      nessieId: nessieId(OPERATING_REF),
      nickname: 'Marlow & Finch · Oakview job operating',
      type: 'Checking',
      last4: OPERATING_LAST4,
      cents: OPERATING_CENTS,
      customer: 'Dana Marlow',
      ours: true,
    },
    {
      ref: 'acct_oakview_owner',
      nessieId: nessieId('acct_oakview_owner'),
      nickname: 'Oakview Lane Owner · draws',
      type: 'Checking',
      last4: '2261',
      cents: 10_100_000,
      customer: 'Oakview Lane Owner',
      ours: false,
    },
  ];
}

export function fixtureMoves(): BankMove[] {
  return [
    {
      id: 'tr_draw_found',
      iso: '2026-10-10',
      cents: 4_800_000,
      rail: 'deposit',
      status: 'executed',
      from: 'acct_oakview_owner',
      to: OPERATING_REF,
      memo: 'cs:draw_found',
      simulated: true,
    },
    {
      id: 'tr_draw_frame',
      iso: '2026-10-17',
      cents: 3_600_000,
      rail: 'deposit',
      status: 'executed',
      from: 'acct_oakview_owner',
      to: OPERATING_REF,
      memo: 'cs:draw_frame',
      simulated: true,
    },
    {
      id: 'tr_working',
      iso: '2026-09-30',
      cents: WORKING_CAPITAL_CENTS,
      rail: 'deposit',
      status: 'executed',
      from: 'acct_oakview_owner',
      to: OPERATING_REF,
      memo: 'cs:working_capital',
      simulated: true,
    },
  ];
}

export function buildTreasury(t: Tables, live?: {
  source: Treasury['source'];
  operatingCents?: number;
  operatingId?: string;
  ownerId?: string;
  byLast4?: Record<string, { id: string; cents: number; nickname: string }>;
  moves?: BankMove[];
}): Treasury {
  const source = live?.source ?? 'nessie-fixture';
  const ours = fixtureAccounts();
  if (live?.operatingCents != null) ours[0] = { ...ours[0], cents: live.operatingCents };
  if (live?.operatingId) ours[0] = { ...ours[0], nessieId: live.operatingId };
  if (live?.ownerId) ours[1] = { ...ours[1], nessieId: live.ownerId };
  const invoices = (t.invoice ?? []).filter(i => !isSandbox(i));
  const unpaid = invoices.filter(i => i.payment_status !== 'settled');
  const heldCents = unpaid.reduce((s, i) => {
    return s + holdsOf(t, i.active_revision_id)
      .filter(h => MONEY_HOLD.has(String(h.code)))
      .reduce((n, h) => n + (Number(h.amount_cents) || 0), 0);
  }, 0);
  const ready = unpaid.filter(i => readyToPay(i, holdsOf(t, i.active_revision_id)));
  const readyCents = ready.reduce((s, i) => {
    const rev = (t.invoice_revision ?? []).find(r => r.id === i.active_revision_id);
    return s + centsOf(rev, 'balance_requested_cents');
  }, 0);

  const payees: PayeeRow[] = (t.payee_profile ?? []).filter(p => p.supplier_id !== 'sup_sandbox').map(p => {
    const supplier = (t.supplier ?? []).find(s => s.id === p.supplier_id)?.name ?? 'Supplier';
    const status = String(p.status) as PayeeState;
    const centsAsk = unpaid
      .filter(i => i.supplier_id === p.supplier_id)
      .reduce((s, i) => {
        const rev = (t.invoice_revision ?? []).find(r => r.id === i.active_revision_id);
        return s + centsOf(rev, 'balance_requested_cents');
      }, 0);
    return {
      id: String(p.id),
      supplierId: String(p.supplier_id),
      supplier,
      bank: String(p.bank_name),
      last4: String(p.last4),
      ref: String(p.account_ref),
      nessieId: live?.byLast4?.[String(p.last4)]?.id ?? nessieId(String(p.account_ref)),
      status,
      nameMatch: payeeNameOk(status, supplier, String(p.bank_name)),
      rail: (centsAsk >= WIRE_DUAL_CENTS ? 'wire' : 'ach') as Rail,
    };
  }).sort((a, b) => a.supplier.localeCompare(b.supplier) || a.status.localeCompare(b.status));

  const payeeAccounts: BankAccount[] = payees
    .filter(p => p.status === 'verified' || p.status === 'pending')
    .map(p => ({
      ref: p.ref,
      nessieId: p.nessieId,
      nickname: `${p.supplier} · ${p.bank}`,
      type: 'Checking',
      last4: p.last4,
      cents: 0,
      customer: p.supplier,
      ours: false,
    }));

  const pending = payees.filter(p => p.status === 'pending');
  const needCall = unpaid.filter(i => holdsOf(t, i.active_revision_id).some(h => h.code === 'PAYEE_CHANGE_PENDING')).length;
  const overLimit = ready.filter(i => {
    const rev = (t.invoice_revision ?? []).find(r => r.id === i.active_revision_id);
    return centsOf(rev, 'balance_requested_cents') > OWNER_PAY_LIMIT_CENTS;
  }).length;
  const wireEyes = ready.filter(i => {
    const rev = (t.invoice_revision ?? []).find(r => r.id === i.active_revision_id);
    return centsOf(rev, 'balance_requested_cents') >= WIRE_DUAL_CENTS;
  }).length;
  const mismatch = payees.filter(p => p.status === 'verified' && !p.nameMatch);

  const window = achWindow();
  const bankCents = ours[0].cents;
  const booksCents = OPERATING_CENTS;
  const controls: ControlRow[] = [
    {
      id: 'rec',
      label: 'Books tie to the bank',
      ok: bankCents === booksCents,
      note: bankCents === booksCents
        ? `Both read ${money(booksCents)} on ${BOOKS_DATE}`
        : `Books ${money(booksCents)}. Bank ${money(bankCents)}. Difference ${money(bankCents - booksCents)}.`,
    },
    {
      id: 'held',
      label: 'Held money is not at the bank as a transfer',
      ok: true,
      note: `${money(heldCents)} stays on the books until a corrected invoice or a yes from Dana.`,
    },
    {
      id: 'ach',
      label: 'ACH has a cutoff',
      ok: window.open,
      note: window.note,
    },
    {
      id: 'wire',
      label: 'A large wire needs a second look',
      ok: wireEyes === 0,
      note: wireEyes
        ? `${wireEyes} ready bill${wireEyes === 1 ? '' : 's'} would go by wire. Books reviews. Dana still pays.`
        : `Nothing ready is at or over ${money(WIRE_DUAL_CENTS)}.`,
    },
    {
      id: 'limit',
      label: 'Dana’s limit is $250,000',
      ok: overLimit === 0,
      note: overLimit ? `${overLimit} ready bill${overLimit === 1 ? '' : 's'} over the owner limit` : 'No ready bill is over the owner limit.',
    },
    {
      id: 'call',
      label: 'A new last-4 needs the number on file',
      ok: needCall === 0,
      note: needCall
        ? `${needCall} new account${needCall === 1 ? '' : 's'} waiting for a call. ${pending.length} profile${pending.length === 1 ? '' : 's'} pending.`
        : 'No unpaid bill has a new account.',
    },
    {
      id: 'name',
      label: 'The name on the account has to look like the supplier',
      ok: mismatch.length === 0,
      note: mismatch.length
        ? `${mismatch.map(p => p.supplier).join(', ')} do not match the bank name on file`
        : 'Verified payees match the name we already have.',
    },
    {
      id: 'sod',
      label: 'The person who proposes cannot pay',
      ok: true,
      note: 'Clerk can open a hold and propose. A transfer from the demo bank only starts after Dana says yes in the app.',
    },
  ];

  return {
    source,
    label: source === 'nessie'
      ? 'Demo job bank · live (pretend money)'
      : 'Demo job bank · labeled fixture (pretend money)',
    books: BOOKS_DATE,
    operating: ours[0],
    owner: ours[1],
    payees,
    accounts: [...ours, ...payeeAccounts],
    moves: live?.moves ?? fixtureMoves(),
    window,
    controls,
    booksCents,
    bankCents,
    diffCents: bankCents - booksCents,
    heldCents,
    readyCents,
    readyCount: ready.length,
  };
}
