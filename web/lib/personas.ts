export const PERSONAS = [
  { id: 'owner', name: 'Dana Marlow', role: 'Owner', does: 'Says yes or no to paying.' },
  { id: 'purchasing', name: 'Jordan Pike', role: 'Buyer', does: 'Asks the supplier to fix a bill.' },
  { id: 'receiver', name: 'Luis Ortega', role: 'Site', does: 'Confirms what arrived.' },
  { id: 'bookkeeper', name: 'Sam Okafor', role: 'Books', does: 'Reads everything. Does not pay.' },
] as const;

export type PersonaId = (typeof PERSONAS)[number]['id'];

export function personaOf(id: string) {
  return PERSONAS.find(x => x.id === id);
}

export function initials(name: string): string {
  return name.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
}
