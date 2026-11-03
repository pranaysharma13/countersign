'use client';
import { useEffect, useRef, useState } from 'react';
import { startRecording, transcribeClip, voiceReady } from '@/lib/voiceClient';
import { parseSiteReceipt } from '@/lib/voice';
import { recordVoice } from '@/lib/voiceLog';

export function SayFill({
  invoiceId,
  invoiceNumber,
  onHeard,
}: {
  invoiceId: string;
  invoiceNumber: string;
  onHeard: (qty: string, reason: string) => void;
}) {
  const [ready, setReady] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const rec = useRef<{ stop: () => Promise<Blob> } | null>(null);
  const [recording, setRecording] = useState(false);

  useEffect(() => { voiceReady().then(setReady).catch(() => setReady(false)); }, []);
  if (ready === false) return null;

  async function start() {
    setErr('');
    rec.current = await startRecording();
    setRecording(true);
  }

  async function stop() {
    const blob = await rec.current?.stop();
    rec.current = null;
    setRecording(false);
    if (!blob) return;
    setBusy(true);
    try {
      const text = await transcribeClip(blob);
      const parsed = parseSiteReceipt(text);
      if (!parsed.reason) throw new Error('Could not hear a count or a reason');
      onHeard(parsed.qty, parsed.reason);
      recordVoice({
        kind: 'site', invoiceId, invoiceNumber, transcript: text, outcome: parsed.qty ? 'accept' : 'unclear',
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not hear that');
    }
    setBusy(false);
  }

  return (
    <div className="row" style={{ marginTop: 10 }}>
      {!recording
        ? <button className="btn secondary" type="button" disabled={busy || ready !== true} onClick={() => start().catch(e => setErr(e.message))}>
          {busy ? 'Hearing…' : 'Say what arrived'}
        </button>
        : <button className="btn" type="button" onClick={() => void stop()}>Done speaking</button>}
      <p className="small muted" style={{ margin: 0 }}>Say the count and how you know. Clerk fills the boxes. You still press confirm.</p>
      {err && <span className="small" style={{ color: 'var(--stop)' }}>{err}</span>}
    </div>
  );
}
