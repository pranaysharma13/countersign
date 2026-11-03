'use client';
import { useEffect, useRef, useState } from 'react';
import {
  clerkLine, deskTitle, isDeskHold, resolutionOf,
  type ClerkBeat, type CompanyReply, type DeskCase, type DeskHoldCode, type DeskResolution,
} from '@/lib/deskCall';
import { HOLD_LABEL, money } from '@/lib/format';
import { playClip, speakClip, transcribeClip, voiceReady } from '@/lib/voiceClient';
import { recordVoice } from '@/lib/voiceLog';
import { Steps } from '@/components/Steps';

type Phase = 'idle' | 'live' | 'done';
type Turn = { who: 'clerk' | 'company'; text: string; heard?: string };

const BEATS: ClerkBeat[] = ['dial', 'rapport', 'refuse', 'hold_line', 'thanks'];

async function askCompany(c: DeskCase, heard: string, turn: number): Promise<CompanyReply> {
  const r = await fetch('/api/voice/company', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...c, heard, turn }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || 'The mock company did not pick up');
  return j as CompanyReply;
}

export function DeskCall({
  invoiceId,
  invoiceNumber,
  supplier,
  contactName,
  contactPhone,
  holdCode,
  extraCents,
}: {
  invoiceId: string;
  invoiceNumber: string;
  supplier: string;
  contactName: string;
  contactPhone: string;
  holdCode: string;
  extraCents: number;
}) {
  const [ready, setReady] = useState<boolean | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [caption, setCaption] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [err, setErr] = useState('');
  const [resolution, setResolution] = useState<DeskResolution | null>(null);
  const stop = useRef(false);

  useEffect(() => {
    voiceReady().then(setReady).catch(() => setReady(false));
    return () => { stop.current = true; };
  }, []);

  if (!isDeskHold(holdCode)) return null;
  const c: DeskCase = {
    invoiceId, invoiceNumber, supplier, contactName, contactPhone,
    holdCode: holdCode as DeskHoldCode, extraCents,
  };
  const step = phase === 'done' ? 4 : phase === 'live' ? (turns.length < 3 ? 2 : 3) : 1;

  async function speak(who: 'clerk' | 'company', text: string, hear = false): Promise<string> {
    setTurns(prev => [...prev, { who, text }]);
    if (ready === false) return text;
    try {
      const blob = await speakClip(text, who === 'company' ? 'contact' : 'clerk');
      if (stop.current) return text;
      await playClip(blob);
      if (!hear || stop.current) return text;
      try {
        const heard = await transcribeClip(blob);
        if (heard) {
          setTurns(prev => {
            const next = prev.slice();
            const last = next[next.length - 1];
            if (last && last.who === 'company') next[next.length - 1] = { ...last, heard };
            return next;
          });
          return heard;
        }
      } catch { /* captions still stand */ }
    } catch (e) {
      if (ready === true) throw e;
    }
    return text;
  }

  async function run() {
    stop.current = false;
    setErr('');
    setTurns([]);
    setResolution(null);
    setPhase('live');
    setCaption(`Ringing ${contactName} at the number on the quote…`);
    try {
      for (let i = 0; i < BEATS.length; i++) {
        if (stop.current) return;
        const line = clerkLine(c, BEATS[i]);
        setCaption(BEATS[i] === 'dial' ? 'Clerk is placing the call.' : 'Clerk is talking.');
        await speak('clerk', line, false);
        if (stop.current) return;
        setCaption(`${contactName} is answering.`);
        const reply = await askCompany(c, line, i);
        const hearThem = reply.intent === 'pitch' || reply.intent === 'close_try' || reply.intent === 'agree';
        await speak('company', reply.say, hearThem);
        if (reply.resolution) setResolution(reply.resolution);
        if (reply.done) break;
      }
      const end = resolutionOf(c);
      setResolution(end);
      recordVoice({
        kind: 'desk',
        invoiceId,
        invoiceNumber,
        contact: `${contactName} · ${contactPhone}`,
        transcript: `${supplier}: ${end.summary}`,
        outcome: 'credit_promised',
      });
      setCaption('');
      setPhase('done');
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'The call dropped');
      setCaption('');
      setPhase('idle');
    }
  }

  return (
    <div className={`call${phase === 'live' ? ' live' : ''}`} id="desk-call">
      <p className="call-line" aria-live="polite">
        <span className={phase === 'live' ? 'on' : ''} />
        {phase === 'live' ? 'Line open · Cartesia · simulated' : 'Simulated call · number on file'}
      </p>
      <h3 className="call-title">{deskTitle(c.holdCode)}</h3>
      <p className="small" style={{ marginTop: 0 }}>
        {contactName}, {contactPhone || 'number on the quote'}. {HOLD_LABEL[c.holdCode]}.
        {extraCents > 0 ? ` Extra ${money(extraCents)}.` : ''} Clerk talks. The mock company answers. The hold stays until a credit or a revised invoice lands.
      </p>
      <Steps now={step} items={['Place the call', 'They pitch', 'Hold stays on the paper']} />
      {ready === false && (
        <div className="notice hold" role="status">
          Cartesia is off on this host, so you will read the call instead of hearing it. The mock company still answers.
        </div>
      )}
      {phase === 'idle' && (
        <button className="btn" type="button" onClick={() => run()}>
          Call {contactName.split(' ')[0] || 'them'}
        </button>
      )}
      {phase === 'live' && <p className="call-caption">{caption || 'On the line…'}</p>}
      {turns.length > 0 && (
        <ol className="call-tape" aria-live="polite" aria-label="Live call">
          {turns.map((row, i) => (
            <li key={`${row.who}-${i}`} className={row.who}>
              <span className={`who ${row.who}`}>{row.who === 'clerk' ? 'Clerk' : supplier}</span>
              <p>{row.text}</p>
              {row.heard ? <p className="heard">Clerk heard: {row.heard}</p> : null}
            </li>
          ))}
        </ol>
      )}
      {phase === 'done' && (resolution ?? resolutionOf(c)) && (
        <div className="notice ok" role="status">
          {(resolution ?? resolutionOf(c)).summary}
        </div>
      )}
      {phase === 'done' && (
        <button className="btn secondary" type="button" onClick={() => { setTurns([]); setPhase('idle'); setResolution(null); }}>
          Call again
        </button>
      )}
      {err && <div className="notice stop" role="alert">{err}</div>}
    </div>
  );
}
