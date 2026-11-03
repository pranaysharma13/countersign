'use client';
import Link from 'next/link';
import { Hear } from '@/components/Hear';
import { money } from '@/lib/format';
import { guardLine, packLine, proofSpeech, type BillProof } from '@/lib/proof';

const ROWS: { key: string; kicker: string; of: (p: BillProof) => string }[] = [
  { key: 'pack', kicker: 'Pack', of: packLine },
  { key: 'guard', kicker: 'Guard', of: guardLine },
  { key: 'tape', kicker: 'Tape', of: p => p.tape[0] ? `${p.tape[0].fact} · ${p.tape[0].from}` : 'No figures yet.' },
  { key: 'lesson', kicker: 'Lesson', of: p => p.lessons[0] ? `${p.lessons[0].taught} ${p.lessons[0].nextTime}` : 'No person has taught this bill yet. Clerk will not guess.' },
  { key: 'run', kicker: 'Run', of: p => p.jobs[0] ? `${p.jobs[0].kind.replaceAll('_', ' ')} · ${p.jobs[0].note}` : 'No job in flight. The last read is still the one that counts.' },
  { key: 'write', kicker: 'Write', of: p => `${p.write.leaving}${p.write.duplicates ? ` ${p.write.duplicates} retry came back as already done.` : ' Retries cannot pay twice.'}` },
];

export function ProofTape({ proof, compact = false }: { proof: BillProof; compact?: boolean }) {
  return (
    <article className={`proof-tape${proof.pack.leaked ? ' leak' : ''}`} id={`proof-${proof.invoiceId}`}>
      <header className="proof-head">
        <div>
          <p className="card-kicker">Proof · {proof.invoiceNumber}</p>
          {compact
            ? <h3><Link href={proof.href}>{proof.supplier}</Link></h3>
            : <h2>How this bill was allowed to exist</h2>}
          <p className="small muted">{proof.story}</p>
        </div>
        <div className="proof-amt">
          <b className="num">{money(proof.guards.claimedCents)}</b>
          <span className="small muted">They asked</span>
        </div>
      </header>
      <ol className="proof-rows">
        {ROWS.map(r => (
          <li key={r.key}>
            <span className="proof-k">{r.kicker}</span>
            <span>{r.of(proof)}</span>
          </li>
        ))}
      </ol>
      {!compact && proof.tape.length > 1 && (
        <ul className="proof-facts">
          {proof.tape.slice(1).map(row => (
            <li key={row.fact}><span>{row.fact}</span><em>{row.from}</em></li>
          ))}
        </ul>
      )}
      {!compact && proof.guards.denials.length > 0 && (
        <p className="small" style={{ marginTop: 12 }}>
          Refused attempts stay on the record: {proof.guards.denials[0]}
        </p>
      )}
      <div className="row" style={{ marginTop: 12 }}>
        <Hear label="Hear this proof" text={proofSpeech(proof)} />
        {compact && <Link className="btn secondary" href={proof.href}>Open the bill</Link>}
        {!compact && <Link className="btn secondary" href="/proof">Every proof</Link>}
      </div>
    </article>
  );
}
