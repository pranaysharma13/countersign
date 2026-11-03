'use client';
import { useEffect, useState } from 'react';
import { Hear } from '@/components/Hear';
import { Loading } from '@/components/parts';
import { HonestAsk } from '@/components/Honest';
import { TrustCase, TrustChapters } from '@/components/Trust';
import { booksLine, type BooksHealth } from '@/lib/books';
import { useTables } from '@/lib/client';
import { snapFromDesk } from '@/lib/questions';
import { SECURITY } from '@/lib/security';
import { deskSpeech, trustDesk } from '@/lib/trust';

const TABLES = [
  'invoice', 'invoice_revision', 'invoice_line', 'assessment', 'hold', 'supplier', 'supplier_contact',
  'purchase', 'document', 'source_fragment', 'email_message', 'outbox', 'audit_log', 'receipt_attestation',
  'change_request', 'proposal', 'settlement_decision', 'job', 'payee_profile', 'payment', 'ledger_line',
  'request_result', 'extraction_run', 'term', 'payment_approval',
];

export default function ProofPage() {
  const { data: t, error } = useTables(TABLES);
  const [books, setBooks] = useState<BooksHealth | null>(null);
  useEffect(() => {
    fetch('/api/health', { cache: 'no-store' }).then(r => r.json()).then(setBooks).catch(() => setBooks(null));
  }, []);
  if (!t) return <Loading error={error} />;
  const desk = trustDesk(t);
  const held = desk.bills.filter(b => b.proof.guards.holds.length > 0);
  const clean = desk.bills.filter(b => b.proof.guards.holds.length === 0);

  return (
    <div className="board proof-desk">
      <div className="board-head">
        <div>
          <p className="card-kicker">These books</p>
          <h1>Proof</h1>
          <p className="lede">
            Each question is scored from the live Marlow &amp; Finch invoices. The model reads the papers. Code decides the holds. Dana still has to approve.
          </p>
        </div>
        <Hear label="Hear how Clerk stays honest" text={deskSpeech(desk)} />
      </div>

      <HonestAsk snap={{ ...snapFromDesk(desk), shared: books?.shared }} hear={false} />

      <p className="small muted" style={{ margin: 0 }}>
        {desk.sandboxUntouched
          ? 'Judge sandbox bills did not change the company books.'
          : 'A sandbox bill shares an id with a company bill. That should never happen.'}
        {desk.guessed ? ` ${desk.guessed} bills guessed. That is a fail.` : ''}
        {desk.fieldsScored ? ` ${desk.fieldsOk}/${desk.fieldsScored} labelled fields matched.` : ''}
        {' '}None of the lessons auto-pay.
        {books ? ` ${booksLine(books)}` : ''}
      </p>

      <TrustChapters desk={desk} books={books} />

      {held.length > 0 && (
        <>
          <h2 className="tiles-head">Stopped</h2>
          <div className="proof-grid">
            {held.map(b => <TrustCase key={b.proof.invoiceId} bill={b} compact />)}
          </div>
        </>
      )}
      {clean.length > 0 && (
        <>
          <h2 className="tiles-head">Matches the papers. Still waiting on Dana.</h2>
          <div className="proof-grid">
            {clean.map(b => <TrustCase key={b.proof.invoiceId} bill={b} compact />)}
          </div>
        </>
      )}

      <section className="trust-chapter" id="say">
        <p className="card-kicker">If a questionnaire asks</p>
        <h2>What we can say today</h2>
        <p className="lede">This is not a SOC report. It is the list we would take into that audit.</p>
        <dl className="sec-list">
          {SECURITY.map(s => (
            <div key={s.id}>
              <dt>{s.title}</dt>
              <dd>{s.body}</dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
