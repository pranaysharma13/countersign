import { STAFF_MAIL } from './access.ts';
import type { PersonaId } from './personas.ts';

const ROLES: PersonaId[] = ['owner', 'purchasing', 'receiver', 'bookkeeper'];

/** Map a signed-in person onto a desk. Metadata first, then known emails, then owner. */
export function roleFromLogin(opts: {
  email?: string | null;
  role?: string | null;
}): PersonaId {
  const claimed = String(opts.role || '').toLowerCase();
  if (ROLES.includes(claimed as PersonaId)) return claimed as PersonaId;
  const email = String(opts.email || '').trim().toLowerCase();
  const known = (Object.entries(STAFF_MAIL) as [PersonaId, string][])
    .find(([, mail]) => mail.toLowerCase() === email);
  if (known) return known[0];
  if (email.startsWith('dana@') || email.includes('marlow')) return 'owner';
  if (email.startsWith('jordan@') || email.includes('pike')) return 'purchasing';
  if (email.startsWith('luis@') || email.includes('ortega')) return 'receiver';
  if (email.startsWith('sam@') || email.includes('okafor')) return 'bookkeeper';
  return 'owner';
}

export function supabaseConfigured(): boolean {
  return !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

export function supabaseIssuer(url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''): string {
  return `${url.replace(/\/$/, '')}/auth/v1`;
}

export function supabaseJwks(url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''): string {
  return `${supabaseIssuer(url)}/.well-known/jwks.json`;
}
