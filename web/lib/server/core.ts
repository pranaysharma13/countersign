import 'server-only';

/** The Python API (intake, file preview, audit, "why?"). Empty on a hosted box until CORE_URL is set. */
export function coreBase(): string {
  const set = (process.env.CORE_URL || process.env.NEXT_PUBLIC_CORE_URL || '').trim().replace(/\/$/, '');
  if (set) return set;
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL === '1') return '';
  return 'http://localhost:8000';
}

export function coreUnavailable(action = 'That service'): string {
  return coreBase()
    ? `${action} is not reachable.`
    : `${action} is off on this host.`;
}
