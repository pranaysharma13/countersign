export async function voiceReady(): Promise<boolean> {
  const r = await fetch('/api/voice/status');
  const j = await r.json().catch(() => ({ ready: false }));
  return !!j.ready;
}

export async function speakClip(transcript: string, voice: 'clerk' | 'contact' = 'clerk'): Promise<Blob> {
  const r = await fetch('/api/voice/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript, voice }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({ message: 'Could not speak' }));
    throw new Error(j.message || 'Could not speak');
  }
  return r.blob();
}

export async function playClip(blob: Blob): Promise<void> {
  const url = URL.createObjectURL(blob);
  await new Promise<void>((resolve, reject) => {
    const a = new Audio(url);
    a.onended = () => { URL.revokeObjectURL(url); resolve(); };
    a.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Playback failed')); };
    a.play().catch(reject);
  });
}

export async function playVoice(transcript: string, voice: 'clerk' | 'contact' = 'clerk'): Promise<void> {
  await playClip(await speakClip(transcript, voice));
}

export async function startRecording(): Promise<{ stop: () => Promise<Blob> }> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mr = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  mr.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  mr.start();
  return {
    stop: () => new Promise((resolve, reject) => {
      mr.onstop = () => resolve(new Blob(chunks, { type: mr.mimeType || 'audio/webm' }));
      mr.onerror = () => reject(new Error('Recording failed'));
      mr.stop();
      stream.getTracks().forEach(t => t.stop());
    }),
  };
}

export async function transcribeClip(blob: Blob): Promise<string> {
  const form = new FormData();
  const name = blob.type.includes('wav') ? 'reply.wav' : 'reply.webm';
  form.append('file', blob, name);
  const r = await fetch('/api/voice/transcribe', { method: 'POST', body: form });
  const j = await r.json();
  if (!r.ok) throw new Error(j.message || 'Could not hear that');
  return String(j.text || '').trim();
}
