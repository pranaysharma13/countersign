// People sign in through Supabase when keys are set. The four desks remain
// a cookie fallback so a judge can still open the books without an account.
import 'server-only';
import { cookies } from 'next/headers';
import { roleFromLogin } from '@/lib/authRole';
import { STAFF, type Persona } from './backend';
import { supabaseUser } from './supabase';

export type AuthKind = 'supabase' | 'desk';

export async function currentPersona(): Promise<{
  persona: Persona;
  unlocked: boolean;
  auth: AuthKind;
  email: string | null;
}> {
  const pin = process.env.DEMO_PIN;
  const c = await cookies();
  const pinOk = !pin || c.get('cs_pin')?.value === pin;

  const user = await supabaseUser();
  if (user) {
    const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
    const app = (user.app_metadata ?? {}) as Record<string, unknown>;
    const persona = roleFromLogin({
      email: user.email,
      role: String(app.role || meta.role || ''),
    });
    return { persona, unlocked: true, auth: 'supabase', email: user.email ?? null };
  }

  const p = c.get('cs_persona')?.value;
  const persona = STAFF.find(id => id === p) ?? 'owner';
  return { persona, unlocked: pinOk, auth: 'desk', email: null };
}
