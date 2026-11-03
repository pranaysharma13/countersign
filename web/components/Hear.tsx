'use client';
import { useEffect, useState } from 'react';
import { playVoice, voiceReady } from '@/lib/voiceClient';

export function Hear({ text, label = 'Hear this' }: { text: string; label?: string }) {
  const [ready, setReady] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => { voiceReady().then(setReady).catch(() => setReady(false)); }, []);
  if (ready === false || !text.trim()) return null;

  return (
    <>
      <button
        className="btn secondary"
        type="button"
        disabled={busy || ready !== true}
        onClick={async () => {
          setErr('');
          setBusy(true);
          try { await playVoice(text); }
          catch (e) { setErr(e instanceof Error ? e.message : 'Could not read that'); }
          setBusy(false);
        }}
      >
        {busy ? 'Reading…' : label}
      </button>
      {err && <span className="small" style={{ color: 'var(--stop)' }}>{err}</span>}
    </>
  );
}
