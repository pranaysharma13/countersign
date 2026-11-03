import { PERSONAS, type PersonaId } from './personas.ts';

/** One person, one job. The same human must not sit in two of these seats. */
export const SOD: { a: PersonaId; b: PersonaId; why: string }[] = [
  { a: 'owner', b: 'purchasing', why: 'The person who pays is not the person who ordered.' },
  { a: 'owner', b: 'receiver', why: 'The person who pays is not the person who counted the drop.' },
  { a: 'purchasing', b: 'receiver', why: 'The person who wrote the order is not the person who received it.' },
  { a: 'bookkeeper', b: 'owner', why: 'The books stay independent of the person who spends.' },
];

export const STAFF_MAIL: Record<PersonaId, string> = {
  owner: 'dana@marlowfinch.example',
  purchasing: 'jordan@marlowfinch.example',
  receiver: 'luis@marlowfinch.example',
  bookkeeper: 'sam@marlowfinch.example',
};

export function identityLine(opts: { pinRequired: boolean; sso: boolean }): string {
  if (opts.sso) return 'People sign in through the company IdP. Leavers lose access there, not in a cookie.';
  if (opts.pinRequired) return 'This host uses a demo PIN on top of the four desks. That is not SSO.';
  return 'These four desks are a demo identity. Production signs in through your IdP. Nothing here is SSO yet.';
}

export function ssoContract(origin: string): { acs: string; audience: string; scim: string; status: string } {
  const base = origin.replace(/\/$/, '');
  return {
    acs: `${base}/api/sso/acs`,
    audience: `${base}/api/sso/metadata`,
    scim: `${base}/api/scim/v2/Users`,
    status: 'not wired',
  };
}

export function scimUsers() {
  return PERSONAS.map(p => ({
    id: p.id,
    userName: STAFF_MAIL[p.id],
    displayName: p.name,
    title: p.role,
    active: true,
    emails: [{ value: STAFF_MAIL[p.id], primary: true }],
    roles: [{ value: p.id, display: p.role }],
  }));
}

export function sodOk(held: PersonaId[]): boolean {
  const set = new Set(held);
  return !SOD.some(p => set.has(p.a) && set.has(p.b));
}
