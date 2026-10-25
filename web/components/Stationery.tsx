'use client';
import { useState } from 'react';
import type { Row, Tables } from '@/lib/client';
import { buildPaper } from '@/lib/stationery';
import { downloadPaper } from '@/lib/downloadPaper';

const KIND: Record<string, string> = {
  invoice: 'Invoice', po: 'Purchase order', quote: 'Quote', terms: 'Terms', email: 'Email',
};

export function Stationery({
  doc, t, inv, rev, pur, highlight,
}: {
  doc: Row;
  t: Tables;
  inv?: Row;
  rev?: Row;
  pur?: Row;
  highlight?: string;
}) {
  const p = buildPaper(doc, t, { inv, rev, pur, highlight });
  return (
    <article className="letter" aria-label={`${p.title} ${p.number}`}>
      <header className="letter-top">
        <div>
          <div className="letter-firm">{p.firm}</div>
          {p.firmSub.map(s => <div key={s} className="letter-sub">{s}</div>)}
        </div>
        <div className="letter-plate">
          <div className="letter-kind">{p.title}</div>
          <div className="letter-no">{p.number}</div>
        </div>
      </header>
      <div className="letter-rule" />
      <div className="letter-grid">
        <div>
          <div className="letter-k">{p.partyLabel}</div>
          <div className="letter-party">{p.partyName}</div>
          {p.partySub.map(s => <div key={s} className="letter-sub">{s}</div>)}
        </div>
        <dl className="letter-meta">
          {p.fields.map(f => (
            <div key={f.k}>
              <dt>{f.k}</dt>
              <dd>{f.v}</dd>
            </div>
          ))}
        </dl>
      </div>
      {p.lines.length > 0 && (
        <table className="letter-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Description</th>
              <th className="num">Qty</th>
              <th>Unit</th>
              <th className="num">Unit price</th>
              <th className="num">Amount</th>
            </tr>
          </thead>
          <tbody>
            {p.lines.map(l => (
              <tr key={`${l.no}-${l.desc}`} className={l.mark ? 'mark' : undefined}>
                <td>{l.no}</td>
                <td>{l.desc}</td>
                <td className="num">{l.qty}</td>
                <td>{l.unit}</td>
                <td className="num">{l.price}</td>
                <td className="num">{l.amount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {p.totals.length > 0 && (
        <table className="letter-totals">
          <tbody>
            {p.totals.map(r => (
              <tr key={r.k} className={r.strong ? 'strong' : undefined}>
                <th>{r.k}</th>
                <td className="num">{r.v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {p.notes.length > 0 && (
        <footer className="letter-notes">
          {p.notes.map(n => <p key={n}>{n}</p>)}
        </footer>
      )}
      {p.signatures.length > 0 && (
        <div className="letter-signs">
          {p.signatures.map(s => (
            <div key={s.label + s.name} className="letter-sign">
              <div className="letter-sign-name">{s.name}</div>
              <div className="letter-sub">{s.label}{s.date ? ` · ${s.date}` : ''}</div>
            </div>
          ))}
        </div>
      )}
    </article>
  );
}

export function Papers({
  docs, t, inv, rev, pur,
}: {
  docs: Row[];
  t: Tables;
  inv?: Row;
  rev?: Row;
  pur?: Row;
}) {
  const items = docs.filter(Boolean);
  const [cur, setCur] = useState(items[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const doc = items.find(d => d.id === cur) ?? items[0];
  if (!items.length || !doc) return null;
  const paper = doc.kind === 'email' ? null : buildPaper(doc, t, { inv, rev, pur });
  async function save() {
    if (!paper) return;
    setBusy(true);
    try { await downloadPaper(paper); } finally { setBusy(false); }
  }
  return (
    <section className="sheet pad papers" aria-labelledby="papers">
      <div className="papers-head">
        <div>
          <div className="card-kicker">On file</div>
          <h2 id="papers">Documents</h2>
        </div>
        <div className="doc-tabs" role="tablist" aria-label="Documents on this bill">
          {items.map(d => (
            <button
              key={d.id}
              type="button"
              role="tab"
              aria-selected={doc.id === d.id}
              className={doc.id === d.id ? 'btn' : 'btn secondary'}
              onClick={() => setCur(d.id)}
            >
              {KIND[d.kind] ?? d.kind}
            </button>
          ))}
          {paper && (
            <button className="btn secondary" type="button" onClick={save} disabled={busy}>
              {busy ? 'Preparing…' : `Download ${KIND[doc.kind] ?? 'document'}`}
            </button>
          )}
        </div>
      </div>
      {doc.kind === 'email' ? (
        <div className="mail">{t.source_fragment.find(f => f.document_id === doc.id && String(f.id).endsWith('_body'))?.text || 'Email on file.'}</div>
      ) : (
        <Stationery doc={doc} t={t} inv={inv} rev={rev} pur={pur} />
      )}
    </section>
  );
}
