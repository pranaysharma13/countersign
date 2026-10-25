'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { refreshAll, useTables, type Row, type Tables } from '@/lib/client';
import { day } from '@/lib/format';
import { fromGmail, gmailImports, readingStatus } from '@/lib/mail';
import { Loading } from '@/components/parts';

const TABLES = ['email_message', 'source_fragment', 'document', 'invoice', 'invoice_revision', 'supplier', 'purchase', 'job'];

// What /api/gmail/callback's ?gmail=<code> means. Unknown codes get a generic line, never the raw text.
const CONNECT_NOTES: Record<string, string> = {
  ok: 'Gmail is connected.',
  denied: "You cancelled on Google's screen, so Gmail isn't connected.",
  bad_state: "The sign-in didn't match this browser: it expired, or it started on another address. Press Connect Gmail " +
    'again, from http://localhost:3001.',
  google_error: 'Google returned an error. Press Connect Gmail to try again.',
  scope_missing: "Google didn't grant read access to Gmail. Connect again and tick \"View your email messages and settings\".",
  invalid_client: 'Google rejected the OAuth client. Check that GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in web/.env.local come ' +
    'from the same OAuth client, then restart the web app.',
  unauthorized_client: 'Google rejected the OAuth client. Check GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in web/.env.local.',
  redirect_uri_mismatch: "The OAuth client doesn't list this redirect URI. Add http://localhost:3001/api/gmail/callback under " +
    'Authorized redirect URIs.',
  invalid_grant: 'That sign-in code expired. Press Connect Gmail again.',
  network: "Couldn't reach Google. Check the internet connection.",
  api_disabled: 'The Gmail API is turned off in your Google Cloud project: enable it, wait a minute, then reload.',
  config: 'Gmail settings are missing or wrong; see Setup below.',
};

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

interface GmailLetter { id: string; from: string; subject: string; snippet: string; at: string; pdf: boolean }
interface GmailStatus { configured: boolean; connected: boolean; email: string; mode: 'live' | 'local'; problem: string; error?: string }
interface ImportResult {
  documents?: { document_id: string; filename: string; kind: string; new: boolean }[];
  skipped?: { filename: string; reason: string }[];
  message?: string;
}

function importSummary(r: ImportResult): string {
  const docs = r.documents || [];
  const fresh = docs.filter(d => d.new).length;
  const skipped = (r.skipped || []).map(s => `${s.filename} (${s.reason})`);
  const head = docs.length && !fresh ? 'Already imported: nothing changed.'
    : `Imported ${fresh} document${fresh === 1 ? '' : 's'}; Clerk is reading ${fresh === 1 ? 'it' : 'them'}.`;
  return skipped.length ? `${head} Skipped: ${skipped.join('; ')}.` : head;
}

export default function Inbox() {
  const { data: t, error } = useTables(TABLES);
  const [g, setG] = useState<GmailStatus | null>(null);
  const [letters, setLetters] = useState<GmailLetter[]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [importing, setImporting] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { ok: boolean; text: string }>>({});

  const refreshGmail = useCallback(async () => {
    const s = await fetch('/api/gmail/status', { cache: 'no-store' }).then(r => r.json()) as GmailStatus;
    setG(s);
    if (s.error) setNote(s.error);
    if (!s.connected) { setLetters([]); return; }
    const m = await fetch('/api/gmail/messages', { cache: 'no-store' }).then(r => r.json());
    setLetters(m.letters || []);
    if (m.error) setNote(m.error);
  }, []);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('gmail');
    if (q) setNote(CONNECT_NOTES[q] ?? `Gmail sign-in failed (${q}). Press Connect Gmail to try again.`);
    refreshGmail();
    const id = setInterval(refreshGmail, 20_000);
    return () => clearInterval(id);
  }, [refreshGmail]);

  async function importMessage(id: string) {
    setImporting(id);
    const r = await fetch('/api/gmail/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
    });
    const j = await r.json().catch(() => ({})) as ImportResult;
    setImporting(null);
    setResults(p => ({ ...p, [id]: r.ok ? { ok: true, text: importSummary(j) } : { ok: false, text: j.message || 'Import failed.' } }));
    refreshAll();
  }

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
  const live = g?.mode === 'live';

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
        <div className={`notice ${note === CONNECT_NOTES.ok ? 'ok' : 'hold'}`} role="status">{note}</div>
      )}

      {!configured && (
        <section className="sheet pad">
          <div className="card-kicker">Setup</div>
          <h2>Connect a new Gmail</h2>
          {g?.problem && <div className="notice hold" role="status">{g.problem}</div>}
          <ol className="setup-list">
            <li>Create a new Google account for the demo. Do not use a real company mailbox.</li>
            <li>In <a href="https://console.cloud.google.com/" target="_blank" rel="noreferrer">Google Cloud Console</a>, new project → enable <strong>Gmail API</strong>.</li>
            <li>APIs &amp; Services → OAuth consent screen → External, Testing. Add your new Gmail as a test user.</li>
            <li>Create credentials → OAuth client ID → Web application (not an API key). Redirect URI: <code>http://localhost:3001/api/gmail/callback</code>.</li>
            <li>Put <code>GMAIL_CLIENT_ID</code>, <code>GMAIL_CLIENT_SECRET</code> and <code>GMAIL_REDIRECT_URI</code> in <code>web/.env.local</code>, then restart the web app. <code>npm run check:gmail</code> checks them without showing any value.</li>
            <li>Come back here and press Connect Gmail. Send a few fictional vendor letters to that inbox; they show up on this page.</li>
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
            <>
              <p className="small muted">Nothing is imported until you press Import. Links and images in mail are never opened.
                {!live && ' Import needs live mode (DATA_SOURCE=live, with SpacetimeDB and the Python worker running).'}</p>
              <div className="tiles">
                {letters.map(m => {
                  const who = m.from.replace(/<[^>]+>/, '').trim() || m.from;
                  const docs = gmailImports(t, m.id);
                  const result = results[m.id];
                  return (
                    <article key={m.id} className="tile">
                      <div className="tile-top">
                        <div className="avatar">{who.slice(0, 1)}</div>
                        <span className="small muted">{mailDay(m.at)}</span>
                      </div>
                      <div className="tile-name">{who}</div>
                      <div className="small muted">{m.from}</div>
                      <p className="tile-story"><strong>{m.subject}</strong><br />{m.snippet}</p>
                      <div className="row">
                        <span className="chip idle">From Gmail</span>
                        {m.pdf && <span className="chip idle">PDF attached</span>}
                      </div>
                      {docs.length > 0 && (
                        <ul className="small" style={{ margin: '8px 0', paddingLeft: 18 }}>
                          {docs.map(({ job, doc }) => {
                            const st = readingStatus(job, doc);
                            const rev = t.invoice_revision.find(r => r.document_id === doc?.id);
                            return (
                              <li key={job.id}>
                                {doc?.filename ?? job.id} <span className={`chip ${st.tone}`}>{st.text}</span>
                                {rev && <> · <Link href={`/invoices/${rev.invoice_id}`}>Open bill</Link></>}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                      <button className="btn secondary" type="button" disabled={!live || importing !== null}
                        onClick={() => importMessage(m.id)}>
                        {importing === m.id ? 'Importing…' : docs.length ? 'Import again' : 'Import'}
                      </button>
                      {result && <div className={`notice ${result.ok ? 'ok' : 'hold'}`} role="status">{result.text}</div>}
                    </article>
                  );
                })}
              </div>
            </>
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
                  {fromGmail(t, m.document_id) && <div><span className="chip idle">From Gmail</span></div>}
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
