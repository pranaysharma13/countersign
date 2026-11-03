import 'server-only';
import { OPERATING_CENTS, dollarsToCents, type BankMove, type Treasury } from '../banks';

const BASE_DEFAULT = 'https://api.nessieisreal.com';

export interface LiveNessie {
  source: Treasury['source'];
  reason?: string;
  operatingCents?: number;
  operatingId?: string;
  ownerId?: string;
  byLast4: Record<string, { id: string; cents: number; nickname: string }>;
  moves?: BankMove[];
}

function readEnv(name: string): string {
  return process.env[name]?.trim() || '';
}

function last4Of(nickname: string): string {
  const m = nickname.match(/····(\d{4})|ending (\d{4})|(\d{4})$/);
  return m?.[1] || m?.[2] || '';
}

async function nessieGet<T>(path: string): Promise<T> {
  const key = readEnv('NESSIE_API_KEY');
  const base = (readEnv('NESSIE_BASE_URL') || BASE_DEFAULT).replace(/\/$/, '').replace('http://', 'https://');
  const url = `${base}${path}${path.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}`;
  const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`Nessie ${r.status}`);
  return r.json() as Promise<T>;
}

export async function probeNessie(): Promise<LiveNessie> {
  const key = readEnv('NESSIE_API_KEY');
  if (!key) return { source: 'nessie-fixture', reason: 'NESSIE_API_KEY is not set', byLast4: {} };
  try {
    const rows = await nessieGet<{ _id?: string; nickname?: string; balance?: unknown }[]>('/accounts');
    if (!Array.isArray(rows) || rows.length === 0) {
      return { source: 'nessie-fixture', reason: 'Nessie answered with no accounts', byLast4: {} };
    }
    const byLast4: LiveNessie['byLast4'] = {};
    let operatingId: string | undefined;
    let operatingCents: number | undefined;
    let ownerId: string | undefined;
    for (const a of rows) {
      const id = String(a._id || '');
      const nick = String(a.nickname || '');
      const cents = dollarsToCents(a.balance);
      const low = nick.toLowerCase();
      if (low.includes('operating')) {
        operatingId = id;
        operatingCents = cents;
      }
      if (low.includes('draws') || low.includes('oakview lane owner')) ownerId = id;
      const last4 = last4Of(nick);
      if (last4 && id) byLast4[last4] = { id, cents, nickname: nick };
    }
    return {
      source: 'nessie',
      operatingCents: operatingCents ?? OPERATING_CENTS,
      operatingId,
      ownerId,
      byLast4,
    };
  } catch (e) {
    return {
      source: 'nessie-fixture',
      reason: e instanceof Error ? e.message : 'Nessie unreachable',
      byLast4: {},
    };
  }
}

export function fixtureOperatingCents(): number {
  return OPERATING_CENTS;
}
