'use client';
import { useEffect, useRef, useState } from 'react';
import { playVoice, startRecording, transcribeClip, voiceReady } from '@/lib/voiceClient';
import { recordVoice } from '@/lib/voiceLog';
import { approveFromTranscript, paymentReadback, type PayVerdict } from '@/lib/voice';
import { Steps } from '@/components/Steps';

export function Readback({
  invoiceId,
  invoiceNumber,
  supplier,
  amount,
  bank,
  last4,
  onVerdict,
}: {
  invoiceId: string;
  invoiceNumber: string;
  supplier: string;
  amount: string;
  bank: string;
  last4: string;
  onVerdict: (v: PayVerdict, transcript: string) => void;
}) {
  const [ready, setReady] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<'idle' | 'speak' | 'listen' | 'done'>('idle');
  const [err, setErr] = useState('');
  const [heard, setHeard] = useState('');
  const [verdict, setVerdict] = useState<PayVerdict>('unclear');
  const rec = useRef<{ stop: () => Promise<Blob> } | null>(null);
  const [recording, setRecording] = useState(false);

  useEffect(() => { voiceReady().then(setReady).catch(() => setReady(false)); }, []);

  const step = phase === 'done' ? 3 : phase === 'listen' ? 2 : 1;

  async function speak() {
    setErr('');
    setPhase('speak');
    try {
      await playVoice(paymentReadback({ supplier, invoiceNumber, amount, bank, last4 }));
      setPhase('listen');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not read the transfer');
      setPhase('idle');
    }
  }

  async function start() {
    rec.current = await startRecording();
    setRecording(true);
  }

  async function stop() {
    const blob = await rec.current?.stop();
    rec.current = null;
    setRecording(false);
    if (!blob) return;
    try {
      const text = await transcribeClip(blob);
      const v = approveFromTranscript(text, last4);
      setHeard(text);
      setVerdict(v);
      recordVoice({
        kind: 'readback', invoiceId, invoiceNumber, last4, transcript: text, outcome: v,
      });
      onVerdict(v, text);
      setPhase('done');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not hear that');
    }
  }

  if (ready === false) {
    return (
      <p className="small muted">
        Clerk would usually read this out and ask you to repeat ····{last4}. Voice is off on this computer, so you can approve in writing.
      </p>
    );
  }

  return (
    <div className="readback">
      <Steps now={step} items={['Hear the transfer', `Say “approve ${last4}”`]} />
      {phase === 'idle' && (
        <button className="btn" disabled={ready !== true} onClick={speak}>1. Hear it</button>
      )}
      {phase === 'speak' && <p className="call-caption">Reading {amount} to ····{last4}…</p>}
      {phase === 'listen' && (
        <div className="stack" style={{ gap: 10 }}>
          <p className="call-hint">Say <em>“Approve {last4}”</em> or <em>“Reject”</em>.</p>
          {!recording
            ? <button className="btn" onClick={() => start().catch(e => setErr(e.message))}>2. Repeat it</button>
            : <button className="btn secondary" onClick={stop}>Done speaking</button>}
        </div>
      )}
      {phase === 'done' && (
        <div>
          <p className="small"><strong>Heard:</strong> {heard || 'nothing yet'}</p>
          {verdict === 'approve' && <div className="notice ok">Last four match. You can approve below.</div>}
          {verdict === 'reject' && <div className="notice stop">You said no. Use Reject.</div>}
          {verdict === 'unclear' && (
            <div className="notice hold">
              Need “approve” and {last4}, or “reject”.
              <button className="btn secondary" style={{ marginTop: 8 }} onClick={() => setPhase('listen')}>Say it again</button>
            </div>
          )}
        </div>
      )}
      {err && <div className="notice stop" role="alert">{err}</div>}
    </div>
  );
}
