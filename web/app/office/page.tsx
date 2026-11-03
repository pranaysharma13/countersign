'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Loading } from '@/components/parts';
import { useTables, type Tables } from '@/lib/client';
import { Hear } from '@/components/Hear';
import { HonestStrip, useHonestSnap } from '@/components/Honest';
import { PayeeCall } from '@/components/PayeeCall';
import { VoiceBar } from '@/components/VoiceBar';
import { downloadBoardPack } from '@/lib/boardPack';
import { billSpeech, queueSpeech } from '@/lib/voice';
import { BOOKS_DATE, CLOSE_MONTH, answerAsk, buildOffice, type AskReport, type OfficeSnap } from '@/lib/office';
import { nextWho, money } from '@/lib/format';

const TABS = [
  { id: 'work', label: 'Work', does: 'Bills that still need a person.' },
  { id: 'bills', label: 'Bills', does: 'Every vendor claim, oldest due first.' },
  { id: 'cash', label: 'Cash', does: 'Cash in the job account, and cash that may leave.' },
  { id: 'close', label: 'Close', does: 'October close items still open.' },
  { id: 'revenue', label: 'Revenue', does: 'Recognize after Site confirms delivery.' },
  { id: 'ask', label: 'Ask', does: 'Ask a question about these bills.' },
] as const;

type Tab = (typeof TABS)[number]['id'];

const ASK_CHIPS = [
  { q: 'who is waiting', label: 'Who is waiting' },
  { q: 'aging', label: 'Aging' },
  { q: 'accrual', label: 'Accruals' },
  { q: 'cash next 13 weeks', label: '13 weeks' },
  { q: 'flux', label: 'Why cash moves' },
  { q: 'allocated', label: 'Coded to a job' },
];

export default function Office() {
  const { data: t, error } = useTables([
    'invoice', 'invoice_revision', 'supplier', 'hold', 'outbox', 'purchase', 'project',
    'payee_profile', 'supplier_contact',
  ]);
  const [tab, setTab] = useState<Tab>('work');
  const [q, setQ] = useState('');
  const [report, setReport] = useState<AskReport | null>(null);
  const honest = useHonestSnap();
  const snap = useMemo(() => {
    if (!t) return null;
    try { return buildOffice(t); }
    catch (e) { return e instanceof Error ? e : new Error('Could not build the books'); }
  }, [t]);
  if (!t || !snap) return <Loading error={error} />;
  if (snap instanceof Error) return <Loading error={snap.message} />;

  const asked = (text: string) => {
    setQ(text);
    setReport(answerAsk(text, snap));
    setTab('ask');
  };
  const first = snap.escalations[0];
  const now = TABS.find(x => x.id === tab) ?? TABS[0];

  return (
    <div className="office">
      <header className="head">
        <div>
          <p className="card-kicker">{tab === 'work' ? 'You are Dana · only you can pay' : 'Marlow & Finch books'}</p>
          <h1>{now.label}</h1>
          <p className="lede">{now.does} {first && tab === 'work' ? `${first.supplier} ${first.number}: ${nextWho(first.role)}: ${first.action}` : ''}</p>
        </div>
        <div className="office-head-actions print-hide">
          <p className="small muted">{BOOKS_DATE} · {CLOSE_MONTH}</p>
          <div className="office-head-btns">
            <Link className="btn secondary" href="/proof">Proof</Link>
            <button className="btn secondary" type="button" onClick={() => downloadBoardPack(snap)}>Download pack</button>
          </div>
        </div>
      </header>

      <nav className="fn-tabs" aria-label="What Clerk runs">
        {TABS.map(x => (
          <button
            key={x.id}
            type="button"
            className={x.id === tab ? 'on' : ''}
            aria-current={x.id === tab ? 'page' : undefined}
            onClick={() => setTab(x.id)}
          >
            <b>{x.label}</b>
            <span>{x.does}</span>
          </button>
        ))}
      </nav>

      {tab === 'work' && (
        <>
          {honest && <HonestStrip snap={honest} />}
          <Work snap={snap} t={t} />
        </>
      )}
      {tab === 'bills' && <Vendor snap={snap} />}
      {tab === 'cash' && <Cash snap={snap} />}
      {tab === 'close' && <Close snap={snap} />}
      {tab === 'revenue' && <Revenue snap={snap} />}
      {tab === 'ask' && <Ask snap={snap} q={q} setQ={setQ} report={report} asked={asked} />}
    </div>
  );
}

function Work({ snap, t }: { snap: OfficeSnap; t: Tables }) {
  const bankCalls = snap.escalations.filter(e => e.hold === 'New bank account');
  return (
    <>
      {bankCalls.map(e => {
        const inv = t.invoice.find(i => i.id === e.invoiceId);
        const pending = (t.payee_profile ?? []).filter(p => p.supplier_id === inv?.supplier_id && p.status === 'pending');
        const oldLast4 = String((t.payee_profile ?? []).find(p => p.supplier_id === inv?.supplier_id && p.status === 'verified')?.last4 ?? '');
        if (!inv || !pending.length) return null;
        return pending.map(p => (
          <PayeeCall
            key={String(p.id)}
            invoiceId={String(inv.id)}
            invoiceNumber={String(inv.invoice_number)}
            supplier={e.supplier}
            oldLast4={oldLast4}
            profile={p}
            t={t}
          />
        ));
      })}
      <section className="pipe" aria-label="Money right now">
        <div className="pipe-cell"><span>In the account</span><b className="num">{money(snap.cashOnHand)}</b></div>
        <div className="pipe-cell"><span>They asked</span><b className="num">{money(snap.askedCents)}</b></div>
        <div className="pipe-cell"><span>Not agreed</span><b className="num hold">{money(snap.heldCents)}</b></div>
        <div className="pipe-cell"><span>Ready to pay</span><b className="num">{money(snap.readyCents)}</b></div>
      </section>
      <section className="sheet pad" aria-labelledby="human">
        <h2 id="human">A person has to act</h2>
        <p className="small muted">Clerk already read the quote, the order and the mail. It will not approve or pay.</p>
        <div className="voice-bar" style={{ marginTop: 8 }}>
          <Hear
            label="Hear who is waiting"
            text={queueSpeech(snap.escalations.map(e => ({
              supplier: e.supplier,
              number: e.number,
              who: nextWho(e.role),
              action: e.action,
              amount: money(e.cents),
            })), 'Nothing is waiting on a person.')}
          />
          {snap.escalations[0] && (
            <Hear
              label="Hear the next bill"
              text={billSpeech({
                supplier: snap.escalations[0].supplier,
                invoiceNumber: snap.escalations[0].number,
                story: snap.escalations[0].story,
                who: nextWho(snap.escalations[0].role),
                action: snap.escalations[0].action,
                math: `${money(snap.escalations[0].cents)} is on this bill.`,
              })}
            />
          )}
        </div>
        <ul className="office-esc">
          {snap.escalations.slice(0, 8).map(e => (
            <li key={e.invoiceId} data-invoice-id={e.invoiceId} data-cents={e.cents} data-hold={e.hold} data-next-role={e.role}>
              <Link href={`/invoices/${e.invoiceId}`}>
                <span className="office-esc-who">{e.supplier}</span>
                <span className="small muted">{e.number} · {e.hold} · {e.waitingDays === 1 ? '1 day' : `${e.waitingDays} days`}</span>
                <span className="office-esc-next">{nextWho(e.role)} · {e.action}</span>
              </Link>
              <b className="num">{money(e.cents)}</b>
            </li>
          ))}
        </ul>
        {snap.escalations.length === 0 && <p className="small muted">Nothing is waiting.</p>}
      </section>
    </>
  );
}

function Vendor({ snap }: { snap: OfficeSnap }) {
  return (
    <div className="office-grid">
      <section className="sheet pad">
        <h2>Age of what they asked</h2>
        <p className="small muted">A late bill can still sit on hold.</p>
        <ul className="office-rows">
          {snap.aging.map(a => (
            <li key={a.id}>
              <span>{a.label} · {a.count}</span>
              <b className="num">{money(a.cents)}</b>
            </li>
          ))}
        </ul>
      </section>
      <section className="sheet pad">
        <h2>By supplier</h2>
        <p className="small muted">Watch starts at 40% of open claims.</p>
        <ul className="office-rows">
          {snap.concentration.map(c => (
            <li key={c.name}>
              <span>{c.name} · {Math.floor(c.shareBps / 100)}%</span>
              <b className="num">{money(c.cents)}</b>
            </li>
          ))}
        </ul>
      </section>
      <section className="sheet pad">
        <h2>Coded when it landed</h2>
        <p className="small muted">{snap.captured.checked} of {snap.captured.total} bills read and coded. Clerk does not invent a class.</p>
        <ul className="office-rows">
          {snap.allocations.map(a => (
            <li key={a.job}>
              <span>{a.job} · {a.count} {a.count === 1 ? 'bill' : 'bills'}</span>
              <b className="num">{money(a.cents)}</b>
            </li>
          ))}
        </ul>
      </section>
      <section className="sheet pad">
        <h2>Accrual preview</h2>
        <p className="small muted">If we closed today. Clerk does not post the entry.</p>
        <ul className="office-rows">
          {snap.accruals.map(a => (
            <li key={a.label}>
              <span>{a.label}</span>
              <b className="num">{money(a.cents)}</b>
            </li>
          ))}
        </ul>
        <p className="small muted">{snap.accruals[0]?.note}</p>
      </section>
    </div>
  );
}

function Cash({ snap }: { snap: OfficeSnap }) {
  const peak = Math.max(1, ...snap.weeks.map(w => w.inCents + w.outCents + w.heldCents));
  return (
    <>
      <section className="sheet pad">
        <h2>Job account rec</h2>
        <p className="small muted">Ties to the tape. Held money does not leave.</p>
        <dl className="office-dl">
          {snap.rec.map(r => (
            <div key={r.left}>
              <dt>{r.left}</dt>
              <dd className={`num${r.strong ? '' : ''}`}>{r.right}</dd>
            </div>
          ))}
        </dl>
        <p className="small">{snap.flux.body}</p>
        <p className="small muted" style={{ marginTop: 12 }}>
          Job operating ····0418 on the <Link href="/banks">demo bank</Link>. Books and the bank should read the same. Held money is not a transfer.
        </p>
      </section>
      <section className="sheet pad">
        <div className="office-tape-head">
          <div>
            <h2>13 weeks</h2>
            <p className="small muted">Updates when a bill is ready, or a draw lands.</p>
          </div>
          <span className="small muted">Ends at {money(snap.weeks[snap.weeks.length - 1]?.endCash ?? snap.cashOnHand)}</span>
        </div>
        <div className="tape" role="img" aria-label="Thirteen weeks of cash">
          {snap.weeks.map(w => (
            <div key={w.start} className="tape-col">
              <div className="tape-bars">
                <i className="in" style={{ height: `${Math.max(4, (w.inCents / peak) * 88)}px` }} />
                <i className="out" style={{ height: `${Math.max(4, (w.outCents / peak) * 88)}px` }} />
                {w.heldCents > 0 && <i className="held" style={{ height: `${Math.max(4, (w.heldCents / peak) * 88)}px` }} />}
              </div>
              <span>{w.start.slice(5)}</span>
            </div>
          ))}
        </div>
        <p className="tape-key small muted">
          <span className="swatch in" /> In
          <span className="swatch out" /> Ready
          <span className="swatch held" /> Held
        </p>
      </section>
      <section className="pipe" aria-label="Applied">
        <div className="pipe-cell"><span>Owner draws landed</span><b className="num">{money(snap.appliedIn)}</b></div>
        <div className="pipe-cell"><span>Supplier bills paid</span><b className="num">{money(snap.appliedOut)}</b></div>
        <div className="pipe-cell"><span>Still to collect</span><b className="num">{money(snap.remainingContractCents)}</b></div>
        <div className="pipe-cell"><span>Ready to leave</span><b className="num">{money(snap.readyCents)}</b></div>
      </section>
    </>
  );
}

function Close({ snap }: { snap: OfficeSnap }) {
  const closeDone = snap.close.filter(c => c.done).length;
  return (
    <div className="office-grid">
      <section className="sheet pad">
        <div className="office-tape-head">
          <h2>{CLOSE_MONTH}</h2>
          <span className="chip ok">{closeDone} of {snap.close.length} already true</span>
        </div>
        <p className="small muted">Each row is a fact about the bills, not a task list.</p>
        <ul className="office-close">
          {snap.close.map(c => (
            <li key={c.id} className={c.done ? 'done' : 'open'}>
              <span className="tick" aria-hidden="true">{c.done ? '✓' : '·'}</span>
              <div>
                <strong>{c.label}</strong>
                <p className="small muted">{c.note}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>
      <section className="sheet pad">
        <h2>Guardrails</h2>
        <p className="small muted">Limits live in the module. The prompt cannot lift them.</p>
        <ul className="office-close">
          {snap.controls.map(c => (
            <li key={c.id} className={c.ok ? 'done' : 'open'}>
              <span className="tick" aria-hidden="true">{c.ok ? '✓' : '·'}</span>
              <div>
                <strong>{c.label}</strong>
                <p className="small muted">{c.note}</p>
              </div>
            </li>
          ))}
        </ul>
        <div className="office-learn" style={{ marginTop: 16 }}>
          {snap.learned.map(l => (
            <article key={l.title}>
              <h3>{l.title}</h3>
              <p>{l.body}</p>
            </article>
          ))}
        </div>
      </section>
      <section className="sheet pad">
        <h2>Stays with the books</h2>
        <p className="small muted">Clerk runs the bills, the tape and the pack. It does not replace the ledger.</p>
        <ul className="office-close">
          <li className="open">
            <span className="tick" aria-hidden="true">·</span>
            <div>
              <strong>No entry posts itself</strong>
              <p className="small muted">Accrual is a preview. Dana would have to accept it in the app.</p>
            </div>
          </li>
          <li className="open">
            <span className="tick" aria-hidden="true">·</span>
            <div>
              <strong>Fixed assets, leases, prepaids</strong>
              <p className="small muted">Stay on the books. Clerk does not run those ledgers.</p>
            </div>
          </li>
          <li className="done">
            <span className="tick" aria-hidden="true">✓</span>
            <div>
              <strong>Two names, one job</strong>
              <p className="small muted">{snap.entities.map(e => e.name).join(' · ')}</p>
            </div>
          </li>
        </ul>
      </section>
    </div>
  );
}

function Revenue({ snap }: { snap: OfficeSnap }) {
  return (
    <section className="sheet pad">
      <h2>The deal</h2>
      <p className="small muted">
        Oakview Lane Fourplex. One owner. {money(snap.recognizedCents + snap.remainingContractCents)} on the schedule.
        Clerk reads the milestones. It does not send the owner an invoice, and it does not chase.
      </p>
      <dl className="office-dl">
        <div><dt>Recognize when</dt><dd>Site signs the work in place</dd></div>
        <div><dt>Already recognized</dt><dd className="num">{money(snap.recognizedCents)}</dd></div>
        <div><dt>Still on the schedule</dt><dd className="num">{money(snap.remainingContractCents)}</dd></div>
        <div><dt>Independent of AP</dt><dd>A supplier bill never books a draw</dd></div>
      </dl>
      <h2>Waterfall</h2>
      <p className="small muted">Recognition and supplier bills run on their own clocks.</p>
      <ol className="office-sched">
        {snap.revenue.map(r => (
          <li key={r.iso} className={r.status}>
            <span className="num">{r.iso}</span>
            <span>{r.label}</span>
            <b className="num">{money(r.cents)}</b>
            <em>{r.status === 'recognized' ? 'Recognized' : 'Scheduled'}</em>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Ask({
  snap, q, setQ, report, asked,
}: {
  snap: OfficeSnap;
  q: string;
  setQ: (s: string) => void;
  report: AskReport | null;
  asked: (s: string) => void;
}) {
  return (
    <>
      <section className="office-ask sheet pad" aria-labelledby="ask">
        <div className="office-ask-top">
          <h2 id="ask">Ask</h2>
          <span className="small muted">The answer is counted from these bills. It does not invent a total.</span>
        </div>
        <form className="office-ask-form" onSubmit={e => { e.preventDefault(); asked(q); }}>
          <input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="Who is waiting" aria-label="Ask for a report" />
          <button className="btn" type="submit">Show me</button>
        </form>
        <div className="office-chips">
          {ASK_CHIPS.map(c => (
            <button key={c.q} type="button" className="chip-btn" onClick={() => asked(c.q)}>{c.label}</button>
          ))}
        </div>
        <VoiceBar snap={snap} report={report} onHeard={asked} />
        {report && (
          <div className="office-report" role="status">
            <div className="office-report-head">
              <h3>{report.title}</h3>
              <p className="small muted">{report.lede}</p>
            </div>
            {report.rows.length > 0 && (
              <ul className="office-rows">
                {report.rows.map(r => (
                  <li key={r.left}>
                    {r.href ? <Link href={r.href}>{r.left}</Link> : <span>{r.left}</span>}
                    <b className="num">{r.right}</b>
                  </li>
                ))}
              </ul>
            )}
            <p className="small muted office-checked">{report.checked}</p>
          </div>
        )}
      </section>
      <section className="sheet pad office-board">
        <h2>Board pack</h2>
        <p className="small muted">The same job. No second formatting pass.</p>
        <dl className="office-dl">
          <div><dt>Still to collect</dt><dd className="num">{money(snap.remainingContractCents)}</dd></div>
          <div><dt>Open claims</dt><dd className="num">{money(snap.askedCents)}</dd></div>
          <div><dt>Held</dt><dd className="num">{money(snap.heldCents)}</dd></div>
          <div><dt>People who act</dt><dd className="num">{snap.humanCount}</dd></div>
        </dl>
      </section>
    </>
  );
}
