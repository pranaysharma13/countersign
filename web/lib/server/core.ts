import 'server-only';

/** The Python API (intake, file preview, audit, "why?"). Server-side only. */
export function coreBase(): string {
  return (process.env.CORE_URL || process.env.NEXT_PUBLIC_CORE_URL || 'http://localhost:8000').replace(/\/$/, '');
}
