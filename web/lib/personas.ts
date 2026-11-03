export const PERSONAS = [
  {
    id: 'owner',
    name: 'Dana Marlow',
    role: 'Owner',
    does: 'Pays, accepts an extra, or confirms a new bank after the call.',
    cannot: 'Cannot accept extra quantity over a purchase order.',
    why: 'The person who can release cash is never the person who ordered, received, or booked the bill.',
  },
  {
    id: 'purchasing',
    name: 'Jordan Pike',
    role: 'Buyer',
    does: 'Sends the supplier a correction when the bill does not match the order.',
    cannot: 'Cannot pay, accept an extra, or change a bank.',
    why: 'Purchasing owns the purchase order. They fix the match. They do not send money.',
  },
  {
    id: 'receiver',
    name: 'Luis Ortega',
    role: 'Site',
    does: 'Confirms what arrived on the job.',
    cannot: 'Cannot pay or change a price.',
    why: 'The person who saw the delivery is not the person who ordered it, and not the person who pays.',
  },
  {
    id: 'bookkeeper',
    name: 'Sam Okafor',
    role: 'Books',
    does: 'Reads the close and the bank.',
    cannot: 'Cannot approve, pay, or clear a hold.',
    why: 'The books stay independent of the people who spend.',
  },
] as const;

export type PersonaId = (typeof PERSONAS)[number]['id'];

export function personaOf(id: string) {
  return PERSONAS.find(x => x.id === id);
}

export function initials(name: string): string {
  return name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
}

export function switchTo(id: PersonaId): string {
  const p = personaOf(id);
  return p ? `Switch I am to ${p.name}, ${p.role}.` : 'Switch I am.';
}
