import 'server-only';

const VERSION = '2026-08-14';
const BASE = 'https://api.cartesia.ai';

/** Clerk (calm, on-the-record). Public library id from Cartesia docs. */
export const CLERK_VOICE = 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4';
/** The person who picks up at the number on file. */
export const CONTACT_VOICE = 'a0e99841-438c-4a64-b679-ae501e7d6091';

export function cartesiaKey(): string {
  return process.env.CARTESIA_API_KEY?.trim() || '';
}

function headers(key: string): HeadersInit {
  return {
    Authorization: `Bearer ${key}`,
    'X-API-Key': key,
    'Cartesia-Version': VERSION,
  };
}

export async function speakBytes(transcript: string, voice = CLERK_VOICE, language = 'en'): Promise<{ ok: true; body: ArrayBuffer; type: string } | { ok: false; status: number; message: string }> {
  const key = cartesiaKey();
  if (!key) return { ok: false, status: 503, message: 'CARTESIA_API_KEY is not set' };
  const clean = transcript.replace(/\s+/g, ' ').trim().slice(0, 2000);
  if (!clean) return { ok: false, status: 400, message: 'Nothing to read' };
  const lang = ['en', 'es', 'fr'].includes(language) ? language : 'en';
  const r = await fetch(`${BASE}/tts/bytes`, {
    method: 'POST',
    headers: { ...headers(key), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model_id: 'sonic-3.6',
      transcript: clean,
      voice: { id: voice },
      language: lang,
      normalization: 'auto',
      output_format: { container: 'wav', encoding: 'pcm_s16le', sample_rate: 24000 },
      generation_config: { emotion: 'calm', speed: 0.96 },
    }),
  });
  if (!r.ok) {
    const message = (await r.text()).slice(0, 400);
    return { ok: false, status: 502, message: message || `Cartesia TTS ${r.status}` };
  }
  return { ok: true, body: await r.arrayBuffer(), type: r.headers.get('content-type') || 'audio/wav' };
}

export async function transcribeFile(file: File): Promise<{ ok: true; text: string } | { ok: false; status: number; message: string }> {
  const key = cartesiaKey();
  if (!key) return { ok: false, status: 503, message: 'CARTESIA_API_KEY is not set' };
  if (file.size > 8 * 1024 * 1024) return { ok: false, status: 413, message: 'Recording too long' };
  const form = new FormData();
  form.append('file', file, file.name || 'reply.webm');
  form.append('model', 'ink-whisper');
  form.append('language', 'en');
  const r = await fetch(`${BASE}/stt`, {
    method: 'POST',
    headers: headers(key),
    body: form,
  });
  if (!r.ok) {
    const message = (await r.text()).slice(0, 400);
    return { ok: false, status: 502, message: message || `Cartesia STT ${r.status}` };
  }
  const body = await r.json() as { text?: string };
  return { ok: true, text: String(body.text ?? '').trim() };
}
