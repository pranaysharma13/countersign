'use client';
import { useEffect, useRef, useState } from 'react';
import { call, type CallResult, type Row, type Tables } from '@/lib/client';
import { usePersona } from '@/lib/usePersona';
import { recordVoice } from '@/lib/voiceLog';
import { callScript, verdictFromTranscript, type CallVerdict } from '@/lib/voice';
import { Steps } from '@/components/Steps';

type Phase = 'idle' | 'calling' | 'listen' | 'review' | 'done';

async function playLine(transcript: string, voice: 'clerk' | 'contact') {
  const r = await fetch('/api/voice/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript, voice }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({ message: 'Could not speak' }));
    throw new Error(j.message || 'Could not speak');
  }
  const blob = await r.blob();
  const url = URL.createObjectURL(blob);
  await new Promise<void>((resolve, reject) => {
    const audio = new Audio(url);
    audio.onended = () => { URL.revokeObjectURL(url); resolve(); };
    audio.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Playback failed')); };
    audio.play().catch(reject);
  });
}

export function PayeeCall({
  invoiceId,
  invoiceNumber,
  supplier,
  oldLast4,
  profile,
  t,
}: {
  invoiceId: string;
  invoiceNumber: string;
  supplier: string;
  oldLast4: string;
  profile: Row;
  t: Tables;
}) {
  const trusted = (t.supplier_contact ?? []).filter(c => c.supplier_id === profile.supplier_id && c.pre_established);
  const [contactId, setContactId] = useState(trusted[0]?.id ?? '');
  const contact = trusted.find(c => c.id === contactId) ?? trusted[0];
  const persona = usePersona();
  const owner = !persona || persona === 'owner';
  const [ready, setReady] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [caption, setCaption] = useState('');
  const [err, setErr] = useState('');
  const [transcript, setTranscript] = useState('');
  const [verdict, setVerdict] = useState<CallVerdict>('unclear');
  const [result, setResult] = useState<CallResult | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);
  const last4 = String(profile.last4);

  useEffect(() => {
    fetch('/api/voice/status').then(r => r.json()).then(j => setReady(!!j.ready)).catch(() => setReady(false));
  }, []);

  const step = phase === 'done' ? 4 : phase === 'review' || phase === 'listen' ? 3 : phase === 'calling' ? 2 : 1;

  async function placeCall() {
    if (!contact) return;
    setErr('');
    setPhase('calling');
    const lines = callScript({
      contactName: contact.name,
      contactPhone: contact.phone,
      supplier,
      invoiceNumber,
      oldLast4: oldLast4 || 'none',
      newLast4: last4,
      newBank: String(profile.bank_name),
    });
    try {
      setCaption(`Calling ${contact.name} at the number on the quote…`);
      await playLine(lines.clerkOpen, 'clerk');
      setCaption(`${contact.name} picked up.`);
      await playLine(lines.contactPickup, 'contact');
      setCaption('Clerk is asking if they requested the new account.');
      await playLine(lines.clerkAsk, 'clerk');
      setCaption('');
      setPhase('listen');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The call could not be placed');
      setCaption('');
      setPhase('idle');
    }
  }

  async function startRec() {
    setErr('');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mr = new MediaRecorder(stream);
    chunks.current = [];
    mr.ondataavailable = e => { if (e.data.size) chunks.current.push(e.data); };
    rec.current = mr;
    mr.start();
    setRecording(true);
  }

  async function stopRec() {
    const mr = rec.current;
    if (!mr) return;
    const blob = await new Promise<Blob>(resolve => {
      mr.onstop = () => resolve(new Blob(chunks.current, { type: mr.mimeType || 'audio/webm' }));
      mr.stop();
      mr.stream.getTracks().forEach(t => t.stop());
    });
    setRecording(false);
    const form = new FormData();
    form.append('file', blob, 'reply.webm');
    const r = await fetch('/api/voice/transcribe', { method: 'POST', body: form });
    const j = await r.json();
    if (!r.ok) { setErr(j.message || 'Could not hear the reply'); return; }
    const text = String(j.text || '');
    const v = verdictFromTranscript(text, last4);
    setTranscript(text);
    setVerdict(v);
    recordVoice({
      kind: 'call',
      invoiceId,
      invoiceNumber,
      contact: contact ? `${contact.name} · ${contact.phone}` : '',
      last4,
      transcript: text,
      outcome: v,
    });
    setPhase('review');
  }

  async function decide(approve: boolean) {
    if (!contact) return;
    const said = transcript.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
    const note = approve
      ? `Callback to ${contact.phone} (number on file). They said: “${said}”`
      : `Callback to ${contact.phone}. They denied the change: “${said}”`;
    const r = await call('decide_payee_profile', {
      id: profile.id,
      approve,
      verified_via_contact_id: contact.id,
      note,
    });
    setResult(r);
    if (r.outcome === 'ok') setPhase('done');
  }

  return (
    <div className={`call${phase === 'calling' || phase === 'listen' ? ' live' : ''}`} id="call">
      <p className="call-line" aria-live="polite">
        <span className={phase === 'calling' || phase === 'listen' ? 'on' : ''} />
        {phase === 'calling' || phase === 'listen' ? 'Line open · Cartesia' : 'Number on file'}
      </p>
      <h3 className="call-title">Call to confirm the new account</h3>
      <p className="small" style={{ marginTop: 0 }}>
        {contact ? `${contact.name}, ${contact.phone}` : 'No number on file from before this request.'}
        {'. '}They asked for {profile.bank_name} ····{last4}. We only call a number already on the quote.
      </p>
      <Steps
        now={step}
        items={['Start the call', 'Hear them pick up', 'Say their answer']}
      />
      {trusted.length > 1 && phase === 'idle' && (
        <label className="f">Who to call
          <select value={contactId} onChange={e => setContactId(e.target.value)} aria-label="Contact on file">
            {trusted.map(c => <option key={c.id} value={c.id}>{c.name}, {c.phone}</option>)}
          </select>
        </label>
      )}
      {ready === false && (
        <div className="notice hold" role="status">
          Clerk cannot place the call from this computer yet. The new account stays blocked.
        </div>
      )}
      {!owner && (
        <p className="small muted">Switch to Owner in the bar. Only Dana can make this call.</p>
      )}
      {phase === 'idle' && (
        <button className="btn" disabled={!contact || ready === false || !owner} onClick={placeCall}>
          1. Call {contact?.name ?? 'them'}
        </button>
      )}
      {phase === 'calling' && <p className="call-caption">{caption || 'On the line…'}</p>}
      {phase === 'listen' && (
        <div className="stack" style={{ gap: 10 }}>
          <p className="small" style={{ margin: 0 }}>
            You are answering as {contact?.name ?? 'them'}. Clerk is listening.
          </p>
          <p className="call-hint">
            Say <em>“Yes, we requested {last4}”</em> or <em>“No, we did not request this”</em>.
          </p>
          {!recording
            ? <button className="btn" onClick={() => startRec().catch(e => setErr(e.message))}>3. Say their answer</button>
            : <button className="btn secondary" onClick={stopRec}>Done speaking</button>}
        </div>
      )}
      {phase === 'review' && (
        <div className="call-review">
          <p><strong>Heard:</strong> {transcript || 'nothing yet'}</p>
          {verdict === 'accept' && <div className="notice ok">That is a yes, and the last four match.</div>}
          {verdict === 'reject' && <div className="notice stop">They said no. Reject the change.</div>}
          {verdict === 'unclear' && (
            <div className="notice hold">
              Not clear enough. Need yes plus {last4}, or a plain no.
              <button className="btn secondary" style={{ marginTop: 8 }} onClick={() => setPhase('listen')}>Say it again</button>
            </div>
          )}
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn" disabled={verdict !== 'accept'} onClick={() => decide(true)}>Keep the new account</button>
            <button className="btn danger" disabled={verdict === 'unclear'} onClick={() => decide(false)}>Keep the old account</button>
          </div>
        </div>
      )}
      {phase === 'done' && result?.outcome === 'ok' && (
        <div className="notice ok" role="status">Done. The new account is on the record because this call used a number already on file.</div>
      )}
      {err && <div className="notice stop" role="alert">{err}</div>}
      {result && result.outcome !== 'ok' && <div className="notice stop" role="alert">{result.message}</div>}
    </div>
  );
}
