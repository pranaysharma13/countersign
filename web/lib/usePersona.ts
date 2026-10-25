'use client';
import { useEffect, useState } from 'react';

export const PERSONA_EVENT = 'cs-persona';

export function usePersona(): string | null {
  const [p, setP] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/session').then(r => r.json()).then(j => setP(j.persona ?? 'owner')).catch(() => setP('owner'));
    const on = (e: Event) => setP((e as CustomEvent<string>).detail);
    window.addEventListener(PERSONA_EVENT, on);
    return () => window.removeEventListener(PERSONA_EVENT, on);
  }, []);
  return p;
}
