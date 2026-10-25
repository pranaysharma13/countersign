'use client';
// Polls /api/state for the tables a screen needs (1s). Every screen updates live as the agent,
// people and gateway act. Calls go through /api/call as the current demo persona.
import { useCallback, useEffect, useRef, useState } from 'react';

export type Row = Record<string, any>;
export type Tables = Record<string, Row[]>;
export interface CallResult { outcome: 'ok' | 'duplicate' | 'denied' | 'invalid' | 'error'; message: string }

const listeners = new Set<() => void>();
export const refreshAll = () => listeners.forEach(f => f());

export function useTables(names: string[], intervalMs = 1000) {
  const key = names.join(',');
  const [state, setState] = useState<{ data: Tables | null; mode: 'live' | 'local' | null; error: string | null }>({ data: null, mode: null, error: null });
  const alive = useRef(true);
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/state?t=${key}`, { cache: 'no-store' });
      const body = await res.json();
      if (!alive.current) return;
      if (body.error) setState(s => ({ ...s, mode: body.mode, error: body.error }));
      else setState({ data: body.tables, mode: body.mode, error: null });
    } catch {
      if (alive.current) setState(s => ({ ...s, error: "Can't reach the server" }));
    }
  }, [key]);
  useEffect(() => {
    alive.current = true;
    load();
    const t = setInterval(load, intervalMs);
    listeners.add(load);
    return () => { alive.current = false; clearInterval(t); listeners.delete(load); };
  }, [load, intervalMs]);
  return state;
}

export async function call(reducer: string, args: Record<string, unknown>, opts: { asPublic?: boolean } = {}): Promise<CallResult> {
  const res = await fetch('/api/call', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reducer, args, ...opts }) });
  const r = (await res.json()) as CallResult;
  refreshAll();
  return r;
}

export const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().slice(0, 8)}`;

/** A denial from approve_supplier_payment carries a JSON list of reasons. */
export function reasonsOf(message: string): string[] {
  try { const v = JSON.parse(message); if (Array.isArray(v)) return v.map(String); } catch { /* plain text */ }
  return message ? [message] : [];
}
