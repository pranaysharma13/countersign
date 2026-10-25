// Server-only data access. Two backends behind one interface:
//   live  — the published SpacetimeDB module over HTTP (SQL reads, reducer calls with per-role tokens)
//   local — the same module running in-process with the BayMix demo seeded (db/dist/local.mjs)
// Choose with DATA_SOURCE=live|local (default local). Tokens never reach the browser.
import 'server-only';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export type Persona = 'owner' | 'purchasing' | 'receiver' | 'bookkeeper' | 'public';
export const STAFF: Exclude<Persona, 'public'>[] = ['owner', 'purchasing', 'receiver', 'bookkeeper'];
export interface CallResult { outcome: 'ok' | 'duplicate' | 'denied' | 'invalid' | 'error'; message: string }
type Row = Record<string, unknown>;

export const mode = (): 'live' | 'local' => (process.env.DATA_SOURCE === 'live' ? 'live' : 'local');

// ---------------------------------------------------------------- local

type LocalModule = {
  localBackend: () => {
    state(t: string[]): Record<string, Row[]>;
    call(p: string, reducer: string, args: unknown[]): CallResult;
    reset(): void;
  };
  REDUCER_ARGS: Record<string, string[]>;
};
let localMod: Promise<LocalModule> | null = null;
// Loaded at runtime from db/dist (built by `npm run build:local` in db/, run automatically by predev/prebuild).
const LOCAL_PATH = resolve(process.cwd(), process.env.LOCAL_BACKEND_PATH ?? '../db/dist/local.mjs');
const local = () => (localMod ??= import(/* webpackIgnore: true */ /* turbopackIgnore: true */ pathToFileURL(LOCAL_PATH).href) as Promise<LocalModule>);

// ---------------------------------------------------------------- live

const base = () => `${(process.env.SPACETIMEDB_URI ?? 'http://localhost:3000').replace(/\/$/, '')}/v1/database/${process.env.SPACETIMEDB_DATABASE ?? 'countersign'}`;
const token = (p: Persona) => (p === 'public' ? process.env.SPACETIMEDB_PUBLIC_TOKEN : process.env[`SPACETIMEDB_${p.toUpperCase()}_TOKEN`]) ?? '';

function normalize(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const entries = Object.entries(v as Row);
    if (entries.length === 1) {
      const [k, inner] = entries[0];
      if (k.startsWith('__') && k.endsWith('__')) return normalize(inner);
      if (k === 'some') return normalize(inner);
      if (k === 'none') return null;
    }
    return Object.fromEntries(entries.map(([k, x]) => [k, normalize(x)]));
  }
  return v;
}

async function sql(query: string, p: Persona = 'bookkeeper'): Promise<Row[]> {
  const t = token(p);
  const res = await fetch(`${base()}/sql`, {
    method: 'POST', body: query, cache: 'no-store',
    headers: { 'Content-Type': 'text/plain', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
  });
  if (!res.ok) throw new Error(`SQL ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const out: Row[] = [];
  for (const stmt of [].concat(await res.json())) {
    const names = ((stmt as any).schema?.elements ?? []).map((e: any) => (typeof e.name === 'object' ? e.name?.some : e.name));
    for (const r of (stmt as any).rows ?? []) out.push(Object.fromEntries(names.map((n: string, i: number) => [n, normalize(r[i])])));
  }
  return out;
}

// ---------------------------------------------------------------- shared API

const SAFE_TABLE = /^[a-z_]+$/;

export async function readTables(tables: string[]): Promise<Record<string, Row[]>> {
  const names = tables.filter(t => SAFE_TABLE.test(t));
  if (mode() === 'local') return (await local()).localBackend().state(names);
  const entries = await Promise.all(names.map(async t => [t, await sql(`SELECT * FROM ${t}`)] as const));
  return Object.fromEntries(entries);
}

/** Call a reducer as a persona. `args` is a name → value object; we order it by the contract. */
export async function callReducer(p: Persona, reducer: string, args: Row): Promise<CallResult> {
  const order = (await local()).REDUCER_ARGS[reducer];
  if (!order) return { outcome: 'invalid', message: `unknown action ${reducer}` };
  const positional = order.slice(1).map(name => {
    if (!(name in args)) throw new Error(`missing argument ${name} for ${reducer}`);
    return args[name];
  });
  if (mode() === 'local') {
    if (p === 'public') return { outcome: 'denied', message: 'the public page is only available on the live server' };
    return (await local()).localBackend().call(p, reducer, positional);
  }
  const requestId = crypto.randomUUID();
  const t = token(p);
  const res = await fetch(`${base()}/call/${reducer}`, {
    method: 'POST', cache: 'no-store', body: JSON.stringify([requestId, ...positional]),
    headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) },
  });
  if (!res.ok) return { outcome: 'error', message: `server error ${res.status}` };
  for (let i = 0; i < 10; i++) {
    const rows = await sql(`SELECT * FROM request_result WHERE request_id = '${requestId}'`);
    if (rows[0]) return { outcome: rows[0].outcome as CallResult['outcome'], message: String(rows[0].message ?? '') };
    await new Promise(r => setTimeout(r, 150));
  }
  return { outcome: 'error', message: 'no result recorded for this request' };
}

export async function resetLocal() {
  if (mode() !== 'local') return false;
  (await local()).localBackend().reset();
  return true;
}
