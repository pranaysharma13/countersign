export type VoiceKind = 'call' | 'readback' | 'site' | 'desk';
export type VoiceOutcome = 'accept' | 'reject' | 'approve' | 'unclear' | 'failed' | 'credit_promised';

export interface VoiceEvent {
  id: string;
  at: number;
  kind: VoiceKind;
  invoiceId: string;
  invoiceNumber: string;
  contact?: string;
  last4?: string;
  transcript: string;
  outcome: VoiceOutcome;
  fingerprint: string;
}

const KEY = 'clerk.voice.v1';
const MAX = 80;

export function fingerprint(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h) ^ text.charCodeAt(i);
  return `v${(h >>> 0).toString(16).padStart(8, '0')}`;
}

export function loadVoiceLog(invoiceId?: string): VoiceEvent[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]') as VoiceEvent[];
    const rows = Array.isArray(raw) ? raw : [];
    return invoiceId ? rows.filter(r => r.invoiceId === invoiceId) : rows;
  } catch {
    return [];
  }
}

export function recordVoice(event: Omit<VoiceEvent, 'id' | 'at' | 'fingerprint'>): VoiceEvent {
  const said = event.transcript.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400);
  const row: VoiceEvent = {
    ...event,
    transcript: said,
    id: `ve_${Date.now().toString(36)}`,
    at: Date.now(),
    fingerprint: fingerprint([event.kind, event.invoiceId, event.outcome, said, event.contact ?? '', event.last4 ?? ''].join('|')),
  };
  if (typeof window === 'undefined') return row;
  const prev = loadVoiceLog();
  const next = [row, ...prev].slice(0, MAX);
  localStorage.setItem(KEY, JSON.stringify(next));
  window.dispatchEvent(new CustomEvent('clerk-voice'));
  return row;
}
