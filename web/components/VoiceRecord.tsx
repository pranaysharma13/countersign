'use client';
import { useEffect, useState } from 'react';
import { loadVoiceLog, type VoiceEvent } from '@/lib/voiceLog';

const KIND: Record<VoiceEvent['kind'], string> = {
  call: 'Call to the number on file',
  desk: 'Call to the supplier about a hold',
  readback: 'Payment readback',
  site: 'What arrived, said out loud',
};

const OUT: Record<VoiceEvent['outcome'], string> = {
  accept: 'Accepted',
  approve: 'Approved by voice',
  reject: 'Rejected',
  unclear: 'Not enough',
  failed: 'Failed',
  credit_promised: 'Credit promised. Hold stays.',
};

export function VoiceRecord({ invoiceId, bare }: { invoiceId?: string; bare?: boolean }) {
  const [rows, setRows] = useState<VoiceEvent[]>([]);
  useEffect(() => {
    const load = () => setRows(loadVoiceLog(invoiceId));
    load();
    window.addEventListener('clerk-voice', load);
    window.addEventListener('storage', load);
    return () => {
      window.removeEventListener('clerk-voice', load);
      window.removeEventListener('storage', load);
    };
  }, [invoiceId]);
  if (!rows.length) return null;
  const list = (
    <ol className="voice-log">
      {rows.slice(0, 8).map(r => (
        <li key={r.id}>
          <div>
            <strong>{KIND[r.kind]}</strong>
            <span className="small muted"> {OUT[r.outcome]}</span>
            {r.transcript && <p className="small">“{r.transcript}”</p>}
          </div>
        </li>
      ))}
    </ol>
  );
  if (bare) return list;
  return (
    <section className="sheet pad" aria-labelledby="vrec">
      <h2 id="vrec">Voice record</h2>
      {list}
    </section>
  );
}
