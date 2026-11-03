'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Hear } from '@/components/Hear';
import { honestRows, honestSpeech, type HonestSnap } from '@/lib/questions';

export function useHonestSnap(): HonestSnap | null {
  const [snap, setSnap] = useState<HonestSnap | null>(null);
  useEffect(() => {
    let on = true;
    const load = async () => {
      try {
        const [p, h] = await Promise.all([
          fetch('/api/proof', { cache: 'no-store' }).then(r => r.json()),
          fetch('/api/health', { cache: 'no-store' }).then(r => r.json()).catch(() => ({ shared: false })),
        ]);
        if (!on) return;
        setSnap({
          billCount: Array.isArray(p.bills) ? p.bills.length : 0,
          watchPass: Number(p.watchPass) || 0,
          watchScored: Number(p.watchScored) || 0,
          fieldsOk: Number(p.fieldsOk) || 0,
          fieldsScored: Number(p.fieldsScored) || 0,
          packsClean: Number(p.packsClean) || 0,
          conflicts: Number(p.conflicts) || 0,
          lessons: Number(p.lessons) || 0,
          autoPaid: Number(p.autoPaid) || 0,
          writesOnce: Number(p.writesOnce) || 0,
          guessed: Number(p.guessed) || 0,
          shared: !!h.shared,
        });
      } catch { /* keep last */ }
    };
    load();
    const t = window.setInterval(load, 8000);
    return () => { on = false; window.clearInterval(t); };
  }, []);
  return snap;
}

export function HonestAsk({ snap, hear = true }: { snap: HonestSnap; hear?: boolean }) {
  const rows = honestRows(snap);
  return (
    <section className="honest" aria-labelledby="honest-h">
      <header className="honest-head">
        <div>
          <p className="card-kicker">How Clerk stays honest</p>
          <h2 id="honest-h">Answers from these books, as the invoices change.</h2>
        </div>
        {hear && <Hear label="Hear the six answers" text={honestSpeech(rows)} />}
      </header>
      <ol className="honest-list">
        {rows.map(r => (
          <li key={r.id} className={r.id === 'write' ? 'last' : undefined}>
            <Link href={r.href}>
              <span className="proof-k">{r.kicker}</span>
              <span className="honest-ask">{r.ask}</span>
              <b className={`num ${r.ok ? 'ok' : r.id === 'canon' ? 'hold' : 'stop'}`}>{r.num}</b>
              <span className="honest-ans">{r.answer}</span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function HonestStrip({ snap }: { snap: HonestSnap }) {
  const rows = honestRows(snap);
  return (
    <nav className="honest-strip" aria-label="How Clerk stays honest">
      {rows.map(r => (
        <Link key={r.id} href={r.href} className={r.ok ? 'ok' : r.id === 'canon' ? 'hold' : 'stop'}>
          <span className="proof-k">{r.kicker}</span>
          <b className="num">{r.num}</b>
          <span>{r.ask}</span>
        </Link>
      ))}
    </nav>
  );
}
