'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { useTables, type Row, type Tables } from '@/lib/client';
import { day } from '@/lib/format';
import { Loading } from '@/components/parts';

const TABLES = ['email_message', 'source_fragment', 'document', 'invoice', 'invoice_revision', 'supplier', 'purchase'];

function billFor(m: Row, t: Tables): Row | undefined {
  const rev = t.invoice_revision.find(r => r.document_id === m.document_id);
  if (rev) return t.invoice.find(i => i.id === rev.invoice_id);
  const from = String(m.from_address || '').toLowerCase();
  const domain = from.split('@')[1] || '';
  const sup = t.supplier.find(s => domain && String(s.email_domain || '').toLowerCase() === domain);
  if (sup) return t.invoice.find(i => i.supplier_id === sup.id);
  return undefined;
}

function mailDay(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? at : day(d.toISOString());
}

interface GmailLetter { id: string; from: string; subject: string; snippet: string; at: string }
interface GmailStatus { configured: boolean; connected: boolean; email: string }

export default function Inbox() {
  const { data: t, error } = useTables(TABLES);
  const [g, setG] = useState<GmailStatus | null>(null);
  const [letters, setLetters] = useState<GmailLetter[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  const refreshGmail = useCallback(async () => {
    const s = await fetch('/api/gmail/status', { cache: 'no-store' }).then(r => r.json()) as GmailStatus;
    setG(s);
    if (!s.connected) { setLetters([]); return; }
    const m = await fetch('/api/gmail/messages', { cache: 'no-store' }).then(r => r.json());
    setLetters(m.letters || []);
    if (m.error) setNote(m.error);
  }, []);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('gmail');
    if (q === 'ok') setNote('Gmail is on.');
    else if (q) setNote(q);
    refreshGmail();
    const id = setInterval(refreshGmail, 20_000);
    return () => clearInterval(id);
  }, [refreshGmail]);

  async function disconnect() {
    setBusy(true);
    await fetch('/api/gmail/disconnect', { method: 'POST' });
    setBusy(false);
    setNote('');
    refreshGmail();
  }

  if (!t) return <Loading error={error} />;

  const mails = [...t.email_message].sort((a, b) => (a.original_sent_at_iso < b.original_sent_at_iso ? 1 : -1));
  const connected = !!g?.connected;
  const configured = !!g?.configured;

  return (
    <div className="board">
      <div className="board-head">
        <div>
          <h1>Inbox</h1>
          <p className="lede">Vendor mail. Read as data, never as an instruction.</p>
        </div>
        <div className="inbox-actions">
          {connected ? (
            <>
              <div className="inbox-on"><span className="dot ok" /> Connected · {g?.email}</div>
              <button className="btn secondary" type="button" onClick={disconnect} disabled={busy}>Disconnect</button>
            </>
          ) : configured ? (
            <>
              <div className="inbox-on"><span className="dot" /> Gmail off</div>
              <a className="btn" href="/api/gmail/start">Connect Gmail</a>
            </>
          ) : (
            <div className="inbox-on"><span className="dot" /> Add Gmail keys in web/.env.local</div>
          )}
        </div>
      </div>

      {note && (
        <div className={`notice ${note === 'Gmail is on.' ? 'ok' : 'hold'}`} role="status">{note}</div>
      )}

      {!configured && (
        <section className="sheet pad">
          <div className="card-kicker">Setup</div>
          <h2>Connect a new Gmail</h2>
          <ol className="setup-list">
            <li>Create a new Google account for the demo. Do not use a real company mailbox.</li>
            <li>In <a href="https://console.cloud.google.com/" target="_blank" rel="noreferrer">Google Cloud Console</a>, new project → enable <strong>Gmail API</strong>.</li>
            <li>APIs &amp; Services → OAuth consent screen → External. Add your new Gmail as a test user.</li>
            <li>Create credentials → OAuth client ID → Web application. Origins: <code>http://localhost:3001</code>. Redirect: <code>http://localhost:3001/api/gmail/callback</code>.</li>
            <li>Put <code>GMAIL_CLIENT_ID</code> and <code>GMAIL_CLIENT_SECRET</code> in <code>web/.env.local</code>, then restart the web app.</li>
            <li>Come back here and press Connect Gmail. Send a few fictional vendor letters to that inbox — they show up on this page.</li>
          </ol>
        </section>
      )}

      {connected && (
        <section>
          <div className="card-kicker">Gmail</div>
          <h2>Live mail</h2>
          {letters.length === 0 ? (
            <div className="sheet empty">Inbox is empty. Send a fictional vendor letter to {g?.email}.</div>
          ) : (
            <div className="tiles">
              {letters.map((m, i) => {
                const who = m.from.replace(/<[^>]+>/, '').trim() || m.from;
                return (
                  <article key={m.id} className={`tile${i === 0 ? ' featured' : ''}`}>
                    <div className="tile-top">
                      <div className="avatar">{who.slice(0, 1)}</div>
                      <span className="small muted">{mailDay(m.at)}</span>
                    </div>
                    <div className="tile-name">{who}</div>
                    <div className="small muted">{m.from}</div>
                    <p className="tile-story"><strong>{m.subject}</strong><br />{m.snippet}</p>
                    <span className="small muted">From Gmail · not a bill yet</span>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}

      <section>
        <div className="card-kicker">On file</div>
        <h2>Vendor letters in this case</h2>
        {mails.length === 0 ? (
          <div className="sheet empty">No mail yet.</div>
        ) : (
          <div className="tiles">
            {mails.map(m => {
              const frag = t.source_fragment.find(f => f.id === m.body_fragment_id);
              const inv = billFor(m, t);
              const sup = inv ? t.supplier.find(s => s.id === inv.supplier_id) : t.supplier.find(s =>
                String(m.from_address || '').toLowerCase().endsWith(`@${String(s.email_domain || '').toLowerCase()}`));
              const ours = String(m.from_address || '').endsWith('@marlowfinch.example');
              const preview = (frag?.text || '').replace(/\s+/g, ' ').slice(0, 140);
              const who = ours ? 'Marlow & Finch' : (sup?.name ?? m.from_address);
              return (
                <article key={m.id} className="tile">
                  <div className="tile-top">
                    <div className="avatar">{String(who).slice(0, 1)}</div>
                    <span className="small muted">{day(m.original_sent_at_iso)}</span>
                  </div>
                  <div className="tile-name">{who}</div>
                  <div className="small muted">{m.from_address}</div>
                  <p className="tile-story"><strong>{m.subject}</strong><br />{preview}{preview.length >= 140 ? '…' : ''}</p>
                  {inv
                    ? <Link className="btn" href={`/invoices/${inv.id}`}>Open bill</Link>
                    : <span className="small muted">No bill yet</span>}
                </article>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
