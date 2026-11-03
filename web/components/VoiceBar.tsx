'use client';
import { useEffect, useRef, useState } from 'react';
import type { AskReport, OfficeSnap } from '@/lib/office';
import { playVoice } from '@/lib/voiceClient';
import { billSpeech, spokenBriefing } from '@/lib/voice';
import { nextWho, money } from '@/lib/format';

async function speak(transcript: string) {
  await playVoice(transcript);
}

export function briefingText(snap: OfficeSnap): string {
  const top = snap.escalations[0];
  return spokenBriefing([
    `Oakview books for October 27th.`,
    `${money(snap.cashOnHand)} in the job account.`,
    `Suppliers asked for ${money(snap.askedCents)}. ${money(snap.heldCents)} is not agreed.`,
    `${money(snap.readyCents)} is ready to pay.`,
    top
      ? `First judgment: ${top.supplier} ${top.number}. ${nextWho(top.role)} needs to ${top.action}`
      : 'Nothing is waiting on a person.',
    `${snap.close.filter(c => c.done).length} of ${snap.close.length} close items are already true.`,
  ]);
}

export function reportSpeech(report: AskReport): string {
  const rows = report.rows.slice(0, 6).map(r => `${r.left}: ${r.right}`).join('. ');
  return spokenBriefing([report.title + '.', report.lede, rows, `Checked: ${report.checked}`]);
}

export function VoiceBar({
  snap,
  report,
  onHeard,
}: {
  snap: OfficeSnap;
  report: AskReport | null;
  onHeard: (text: string) => void;
}) {
  const [ready, setReady] = useState<boolean | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    fetch('/api/voice/status').then(r => r.json()).then(j => setReady(!!j.ready)).catch(() => setReady(false));
  }, []);

  async function run(label: string, fn: () => Promise<void>) {
    setErr('');
    setBusy(label);
    try { await fn(); }
    catch (e) { setErr(e instanceof Error ? e.message : 'Voice failed'); }
    setBusy('');
  }

  async function startRec() {
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
    form.append('file', blob, 'ask.webm');
    const r = await fetch('/api/voice/transcribe', { method: 'POST', body: form });
    const j = await r.json();
    if (!r.ok) throw new Error(j.message || 'Could not hear that');
    if (j.text) onHeard(String(j.text));
  }

  if (ready === false) return null;

  return (
    <div className="voice-bar">
      <button className="btn secondary" disabled={!!busy || ready !== true} onClick={() => run('brief', () => speak(briefingText(snap)))}>
        {busy === 'brief' ? 'Reading…' : 'Read the books'}
      </button>
      {snap.escalations[0] && (
        <button
          className="btn secondary"
          disabled={!!busy || ready !== true}
          onClick={() => run('next', () => {
            const top = snap.escalations[0];
            return speak(billSpeech({
              supplier: top.supplier,
              invoiceNumber: top.number,
              story: top.story,
              who: nextWho(top.role),
              action: top.action,
              math: `${money(top.cents)} is on this bill.`,
            }));
          })}
        >
          {busy === 'next' ? 'Reading…' : 'Hear the next bill'}
        </button>
      )}
      {report && (
        <button className="btn secondary" disabled={!!busy} onClick={() => run('report', () => speak(reportSpeech(report)))}>
          {busy === 'report' ? 'Reading…' : 'Read this report'}
        </button>
      )}
      {!recording
        ? <button className="btn" disabled={!!busy || ready !== true} onClick={() => startRec().catch(e => setErr(e.message))}>Ask out loud</button>
        : <button className="btn secondary" onClick={() => run('hear', stopRec)}>Done speaking</button>}
      {err && <span className="small" style={{ color: 'var(--stop)' }}>{err}</span>}
    </div>
  );
}
