'use client';
import Link from 'next/link';
import { Hear } from '@/components/Hear';
import { booksLine, type BooksHealth } from '@/lib/books';
import { money } from '@/lib/format';
import { pipeLine } from '@/lib/pipes';
import { QUESTIONS } from '@/lib/questions';
import {
  CHAPTERS, caseSpeech, chapterScore, watchLine, type BillTrust, type TrustDesk,
} from '@/lib/trust';

function tone(ok: boolean, warn = false) {
  return ok ? 'ok' : warn ? 'hold' : 'stop';
}

export function TrustWall({ desk }: { desk: TrustDesk }) {
  return (
    <nav className="trust-wall" aria-label="Six working papers">
      {CHAPTERS.map(c => {
        const s = chapterScore(desk, c.id);
        const cls = c.id === 'canon' && desk.conflicts > 0 ? 'hold' : tone(s.ok);
        return (
          <a key={c.id} className="trust-card" href={`#${c.id}`}>
            <span className="card-kicker">{c.kicker}</span>
            <b className={`num ${cls}`}>{s.num}</b>
            <span className="small">{c.ask}</span>
          </a>
        );
      })}
    </nav>
  );
}

export function TrustCase({ bill, compact = false }: { bill: BillTrust; compact?: boolean }) {
  const p = bill.proof;
  const sheets: Record<string, string> = {
    watch: watchLine(bill.watch),
    pack: bill.pack.line,
    canon: bill.canon.line,
    lesson: bill.lesson.line,
    run: bill.run.line,
    write: bill.write.line,
  };
  return (
    <article className={`trust-case${bill.pack.leaked || bill.watch.guessed ? ' leak' : ''}`} id={`trust-${p.invoiceId}`}>
      <header className="proof-head">
        <div>
          <p className="card-kicker">Working paper · {p.invoiceNumber}</p>
          {compact
            ? <h3><Link href={p.href}>{p.supplier}</Link></h3>
            : <h2>Six questions this bill has to survive</h2>}
          <p className="small muted">{p.story}</p>
        </div>
        <div className="proof-amt">
          <b className="num">{money(p.guards.claimedCents)}</b>
          <span className="small muted">They asked</span>
        </div>
      </header>
      <ol className="proof-rows">
        {QUESTIONS.map(q => (
          <li key={q.id}>
            <span className="proof-k">{q.kicker}</span>
            <span>
              {!compact && <strong className="honest-ask">{q.ask}</strong>}
              {sheets[q.id]}
            </span>
          </li>
        ))}
      </ol>
      {!compact && bill.canon.facts.length > 0 && (
        <ul className="canon-facts">
          {bill.canon.facts.map(f => (
            <li key={f.name} className={f.conflict ? 'conflict' : ''}>
              <span>{f.name}</span>
              <b>{f.value}</b>
              <em>{f.owner}</em>
            </li>
          ))}
        </ul>
      )}
      {!compact && bill.watch.gaps.some(g => g.kind !== 'match') && (
        <p className="small" style={{ marginTop: 12 }}>
          Still does not match: {bill.watch.gaps.filter(g => g.kind !== 'match').map(g => `${g.label} (${g.kind})`).join(' · ')}
        </p>
      )}
      <div className="row" style={{ marginTop: 12 }}>
        <Hear label="Hear this paper" text={caseSpeech(bill)} />
        {compact && <Link className="btn secondary" href={p.href}>Open the bill</Link>}
        {!compact && <Link className="btn secondary" href="/proof">The six answers</Link>}
      </div>
    </article>
  );
}

export function TrustChapters({ desk, books }: { desk: TrustDesk; books?: BooksHealth | null }) {
  const scored = desk.bills.filter(b => b.watch.scored);
  const leaks = desk.bills.filter(b => b.pack.leaked);
  const conflicts = desk.bills.filter(b => b.canon.conflicts.length > 0);
  const lessons = desk.bills.flatMap(b => b.lesson.rows.map(r => ({ ...r, href: b.proof.href, number: b.proof.invoiceNumber })));
  const jobs = desk.bills.flatMap(b => b.run.jobs.map(j => ({ ...j, href: b.proof.href, number: b.proof.invoiceNumber, supplier: b.proof.supplier })));
  const writes = desk.bills.filter(b => b.write.rows.length > 0 || b.write.paid || b.write.waitingOnOwner);

  return (
    <>
      <section className="trust-chapter" id="watch">
        <p className="card-kicker">Watch</p>
        <h2>{QUESTIONS.find(q => q.id === 'watch')?.ask}</h2>
        <p className="lede">Grade it against the quote and the order. A failed read goes to a person. A live read that disagrees with the labelled quote is held. The model never grades itself.</p>
        {desk.fieldsScored > 0 && (
          <p className="small muted">{desk.fieldsOk}/{desk.fieldsScored} labelled fields matched the quote and the order.</p>
        )}
        {scored.length === 0 ? <p className="muted">No labelled quote and order on these bills.</p> : (
          <table className="trust-table">
            <thead>
              <tr><th>Bill</th><th>Gold</th><th>They asked</th><th>Fields</th><th>Holds</th></tr>
            </thead>
            <tbody>
              {scored.map(b => (
                <tr key={b.proof.invoiceId}>
                  <td><Link href={b.proof.href}>{b.proof.invoiceNumber}</Link><div className="small muted">{b.proof.supplier}</div></td>
                  <td><span className={`chip ${b.watch.pass ? 'ok' : 'stop'}`}>{b.watch.pass ? 'Match' : b.watch.guessed ? 'Guessed' : 'Drift'}</span></td>
                  <td className="num">{money(b.proof.guards.claimedCents)}</td>
                  <td className="num">{b.watch.fields.total ? `${b.watch.fields.ok}/${b.watch.fields.total}` : '-'}</td>
                  <td>{b.watch.gaps.filter(g => g.kind === 'match').map(g => g.label).join(', ') || 'None expected'}{b.watch.missed ? ` · missed ${b.watch.missed}` : ''}{b.watch.extra ? ` · extra ${b.watch.extra}` : ''}{b.watch.fields.misses[0] ? ` · ${b.watch.fields.misses[0].name}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="trust-chapter" id="pack">
        <p className="card-kicker">Pack</p>
        <h2>{QUESTIONS.find(q => q.id === 'pack')?.ask}</h2>
        <p className="lede">A pack is this supplier’s quote, order, bill, mail and lessons. Other suppliers stay out. A cited line from the wrong file is a leak, and a hold.</p>
        {leaks.length > 0
          ? leaks.map(b => <p key={b.proof.invoiceId}><Link href={b.proof.href}>{b.proof.invoiceNumber}</Link>: {b.pack.line}</p>)
          : <p className="muted">{desk.packsClean}/{desk.bills.length} packs stayed in their supplier. Fingerprints pin what the assessment used.</p>}
        <ul className="trust-list">
          {desk.bills.slice(0, 6).map(b => (
            <li key={b.proof.invoiceId}>
              <Link href={b.proof.href}>{b.proof.invoiceNumber}</Link>
              <span>{b.pack.line}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="trust-chapter" id="canon">
        <p className="card-kicker">Canon</p>
        <h2>{QUESTIONS.find(q => q.id === 'canon')?.ask}</h2>
        <p className="lede">The bill owns what they asked. The quote owns the unit price. The order owns the cap. Site owns the count. The account on file owns where to pay. Mail never owns a bank number. A later ERP is another pipe with an owns list, not a dump into the prompt. When two disagree, the hold is the record. Clerk does not average them.</p>
        {desk.pipes.length > 0 && (
          <ul className="trust-list">
            {desk.pipes.map(p => (
              <li key={p.id}>
                <b>{p.name}</b>
                <span>{pipeLine(p)} {p.note}</span>
              </li>
            ))}
          </ul>
        )}
        {conflicts.length === 0 ? <p className="muted">No source conflicts on file. Code still does not pay.</p> : (
          <ul className="trust-list">
            {conflicts.map(b => (
              <li key={b.proof.invoiceId}>
                <Link href={b.proof.href}>{b.proof.invoiceNumber}</Link>
                <span>{b.canon.conflicts.map(f => `${f.name} ${f.value}`).join(' · ')}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="trust-chapter" id="lesson">
        <p className="card-kicker">Lesson</p>
        <h2>{QUESTIONS.find(q => q.id === 'lesson')?.ask}</h2>
        <p className="lede">Dana’s note, Luis’s count, or a written change stays on file for the next bill from that supplier. They do not fine-tune a model. They do not auto-pay the next extra.</p>
        {lessons.length === 0 ? <p className="muted">No person has taught these bills yet.</p> : (
          <ul className="trust-list">
            {lessons.map((l, i) => (
              <li key={`${l.supplierId}-${i}`}>
                <Link href={l.href}>{l.number}</Link>
                <span>{l.who}: {l.taught} {l.nextTime}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="trust-chapter" id="run">
        <p className="card-kicker">Run</p>
        <h2>{QUESTIONS.find(q => q.id === 'run')?.ask}</h2>
        <p className="lede">A worker crash does not lose a bill. A claimed job past its lease is picked up again. If the assessment changes, an old yes dies. The same request comes back as already done. A public domain cannot keep in-process books.</p>
        {books && <p className={books.shared ? 'muted' : 'hold-note'}>{booksLine(books)}</p>}
        {jobs.length === 0 ? <p className="muted">No jobs in flight. Finished writes still replay as duplicates.</p> : (
          <ul className="trust-list">
            {jobs.slice(0, 12).map((j, i) => (
              <li key={`${j.number}-${i}`}>
                <Link href={j.href}>{j.number}</Link>
                <span>{j.kind} · {j.note}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="trust-chapter" id="write">
        <p className="card-kicker">Write</p>
        <h2>{QUESTIONS.find(q => q.id === 'write')?.ask}</h2>
        <p className="lede">Every reducer takes a request id. A retry that already ran returns duplicate. Journals debit and credit the same cents. The demo bank is labeled simulated. Clerk proposes. Dana still has to say yes.</p>
        {writes.length === 0 ? <p className="muted">No writes on file.</p> : (
          <ul className="trust-list">
            {writes.map(b => (
              <li key={b.proof.invoiceId}>
                <Link href={b.proof.href}>{b.proof.invoiceNumber}</Link>
                <span>{b.write.line}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
