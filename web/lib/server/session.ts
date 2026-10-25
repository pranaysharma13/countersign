// Demo-mode personas. The persona lives in a cookie; when DEMO_PIN is set, a matching PIN cookie is
// required before any staff action. This is labeled demo mode in the UI: in production each employee
// signs in individually.
import 'server-only';
import { cookies } from 'next/headers';
import { STAFF, type Persona } from './backend';

export async function currentPersona(): Promise<{ persona: Persona; unlocked: boolean }> {
  const c = await cookies();
  const p = c.get('cs_persona')?.value as Persona | undefined;
  const persona = p && STAFF.includes(p as any) ? p : 'owner';
  const pin = process.env.DEMO_PIN;
  const unlocked = !pin || c.get('cs_pin')?.value === pin;
  return { persona, unlocked };
}
